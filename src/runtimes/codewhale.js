import fs from "node:fs"
import path from "node:path"

import {
  classifyFailure, emptyUsage, envForGithub, envForWeb, locateBin, locationAdvice,
  mcpServersFor, normalizeUsage, shortCommand, shortPath
} from "./shared.js"

// ---------------------------------------------------------------------------
// CodeWhale (`codewhale`) — the DeepSeek-first terminal agent, formerly
// DeepSeek TUI, now provider-neutral and community-maintained. What it spends
// is whatever the user configured inside CodeWhale itself: a DeepSeek API
// key for most people, or a local model for free. No credential of theirs
// ever reaches this companion.
//
// The headless surface below is CodeWhale's own published launch contract for
// `codewhale exec` (docs/AGENT_RUNTIME.md in its repository), which is the
// strongest source any adapter here has had — the vendor documents the exact
// argv shape for harnesses like this one:
//
//   codewhale [globals] exec [flags] -- "<prompt>"
//
//   globals:  --workspace <dir>       the directory the run may work in
//             --model <id>            model override (e.g. deepseek-v4-flash)
//             --skip-onboarding       never open the setup wizard headless
//             --no-project-config     ignore workspace-local config overlays
//   exec:     --output-format stream-json    NDJSON event stream
//             --append-system-prompt <text>  caller-supplied system text
//             --auto                         run without stopping to ask
//             --sandbox <level>       read-only | workspace-write | danger-full-access
//
// `--no-project-config` is deliberate and load-bearing: a repository shared
// with this companion must not be able to reconfigure the harness that runs
// over it (swap the provider, lift the sandbox) by carrying a config file.
//
// The sandbox levels are codex-vocabulary on purpose (CodeWhale uses the same
// Landlock/Seatbelt/AppContainer machinery), and the mapping is the same one
// the codex adapter uses: workspace-write for a repository turn, read-only
// for a plain chat. `--auto` is safe ONLY because the sandbox bounds it —
// bare, it would be cursor's `--force` problem all over again.
//
// ── MCP wiring ─────────────────────────────────────────────────────────────
//
// CODEWHALE_MCP_CONFIG names the MCP file for a run — CodeWhale's own,
// documented way to hand a harness its servers — so the file lives in OUR
// profile directory and nothing is ever written into ~/.codewhale, whose
// config the user's own CodeWhale reads. Same shape as Cursor's mcp.json
// ({ mcpServers: { name: { command, args } } }), same secret discipline: the
// file names a command, the tokens travel by environment. (CodeWhale spawns
// MCP servers with the run's environment — the same inheritance bet the
// Cursor adapter already makes; if a build ever sanitizes it, the tools
// mount and fail auth loudly rather than silently.)
//
// ── Stated limitation ──────────────────────────────────────────────────────
//
// The forbidden-git deny list has no verified flag to ride:
// `--disallowed-tools` takes CodeWhale's tool names (read/write/edit/bash/…),
// not per-command patterns, so denying "bash" would also deny the test suite.
// The workspace-write sandbox and the system prompt are the bounds, and
// `limitations` says so.
// ---------------------------------------------------------------------------

const CLI = {
  exec: "exec",
  separator: "--",
  streamFormat: ["--output-format", "stream-json"],
  auto: "--auto",
  sandbox: (level) => ["--sandbox", level],
  workspace: (dir) => ["--workspace", dir],
  model: (id) => ["--model", id],
  appendSystem: (text) => ["--append-system-prompt", text],
  skipOnboarding: "--skip-onboarding",
  noProjectConfig: "--no-project-config"
}

// Globals precede the subcommand — that is the documented shape, not a
// preference.
//
// `--workspace` goes FIRST, and that ordering is load-bearing: it is a
// capability flag, and the engine's degraded retry drops a rejected
// capability flag plus every non-flag token after it. Anywhere later in the
// list, the token after `--workspace <dir>` would be the bare `exec`
// subcommand, and stripping would eat it — the same class of ordering hazard
// that once cost Claude Code its prompt. Here the next token is always
// another flag, so only the directory goes with it.
export function globalArgs(job) {
  const args = []
  if (job.workdir) args.push(...CLI.workspace(job.workdir))
  args.push(CLI.skipOnboarding, CLI.noProjectConfig)
  if (job.model) args.push(...CLI.model(job.model))
  return args
}

export function execArgs(job) {
  const args = [...CLI.streamFormat]
  if (job.system) args.push(...CLI.appendSystem(job.system))

  if (job.workdir) {
    // Work without stopping to ask, confined to the workspace by the sandbox.
    args.push(CLI.auto)
    args.push(...CLI.sandbox("workspace-write"))
  } else {
    // A chat completion writes nothing.
    args.push(...CLI.sandbox("read-only"))
  }

  return args
}

// The prompt is a positional after `--`, which is the documented contract and
// also the safest of the three shapes: nothing after a `--` is ever parsed as
// a flag, so nothing can swallow it.
export function streamingArgs(job, prompt = "") {
  return [...globalArgs(job), CLI.exec, ...execArgs(job), CLI.separator, prompt]
}

// Where the MCP file lives inside the directory the engine hands us (our
// profile directory, ambient login included). One function because prepare()
// writes it and envFor() names it, and the two must agree.
export function mcpPathIn(dir) {
  return path.join(dir, "mcp.json")
}

// Written before every spawn when the job has something to mount; a stale
// file from a job that had a grant this one lacks is removed rather than left
// offering tools that can only fail.
export function writeConfig(job, file) {
  const servers = mcpServersFor(job)

  if (Object.keys(servers).length === 0) {
    if (fs.existsSync(file)) fs.rmSync(file, { force: true })
    return
  }

  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  fs.writeFileSync(file, `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`, { mode: 0o600 })
}

// ---------------------------------------------------------------------------
// The event stream. CodeWhale documents a closed set of NDJSON event types:
//
//   content | tool_use | tool_result | sandbox_denied | workflow_event |
//   session_capture | turn_usage | metadata | done | error
//
// `content` carries answer text as it is produced (the partial channel),
// `turn_usage` the per-turn token counts, `done` the terminal marker.
// ---------------------------------------------------------------------------

function contentTextOf(event) {
  if (event?.type !== "content") return null
  const value = event.text ?? event.content ?? event.delta
  return typeof value === "string" && value ? value : null
}

function describeEvent(event) {
  if (!event || typeof event !== "object") return null

  if (event.type === "metadata") return "Starting up"

  if (event.type === "sandbox_denied") return "Blocked by the sandbox"

  if (event.type === "tool_use") {
    const name = String(event.tool_name || event.name || event.tool || "")
    const args = event.args || event.input || event.parameters || {}
    const file = shortPath(args.path || args.file_path)

    switch (name) {
      case "read":       return file ? `Reading ${file}` : "Reading a file"
      case "write":      return file ? `Writing ${file}` : "Writing a file"
      case "edit":       return file ? `Editing ${file}` : "Editing a file"
      case "bash": {
        const cmd = shortCommand(args.command)
        return cmd ? `Running ${cmd}` : "Running a command"
      }
      case "agent":      return "Delegating a subtask"
      case "todo_write": return "Updating the plan"
      default: {
        const pretty = name.replace(/_/g, " ").trim()
        return pretty ? `${pretty.charAt(0).toUpperCase()}${pretty.slice(1)}`.slice(0, 60) : "Working"
      }
    }
  }

  return null
}

function partialTextFrom(event) {
  return contentTextOf(event)
}

// Which file this event wrote, for the documents channel. Write/edit tool
// calls name their path; a shape we don't recognise reports nothing.
function writtenPathFrom(event) {
  if (event?.type !== "tool_use") return null
  const name = String(event.tool_name || event.name || event.tool || "")
  if (!["write", "edit"].includes(name)) return null

  const args = event.args || event.input || event.parameters || {}
  const file = args.path || args.file_path
  return typeof file === "string" && file.trim() ? file.trim() : null
}

function collapseEvents(events) {
  const out = {
    content: "", usage: emptyUsage(), model: null,
    stopReason: null, isError: false, errorStatus: null
  }

  let sawResult = false
  const text = []

  for (const event of events) {
    const chunk = contentTextOf(event)
    if (chunk) text.push(chunk)

    if (event?.type === "metadata" && event.model) out.model = event.model

    // Per-turn counts; the LAST turn's numbers stand for the run, matching
    // how the other adapters report a single terminal usage object.
    if (event?.type === "turn_usage") {
      out.usage = normalizeUsage(event)
    }

    if (event?.type === "error") {
      out.isError = true
      out.errorStatus = String(event.message || event.error || "").slice(0, 300) || out.errorStatus
    }

    if (event?.type === "done") {
      sawResult = true
      out.stopReason = event.status || "done"
    }
  }

  out.content = text.join("")
  return { ...out, sawResult }
}

export const codewhale = {
  id: "codewhale",
  name: "CodeWhale",
  cli: "codewhale",
  install: "https://github.com/Hmbown/CodeWhale",
  binEnvVar: "CMA_CODEWHALE_BIN",
  // Cargo installs land in ~/.cargo/bin, which the generic sweep does not
  // cover; npm globals it already finds.
  extraHomePaths: [".cargo/bin/codewhale"],

  // CODEWHALE_HOME is CodeWhale's own, documented way to relocate its config,
  // so two provider setups (a work DeepSeek key and a personal one) isolate
  // the same way two Claude logins do. The empty slug stays ambient: most
  // machines have one setup, in ~/.codewhale, and it should work untouched.
  configDirEnvVar: "CODEWHALE_HOME",
  profilesDirName: "codewhale-profiles",

  versionArgs: ["--version"],
  // "Login" is CodeWhale's own onboarding: it prompts for a provider and key
  // in its TUI. We hand over the terminal, same as every other runtime.
  loginArgs: () => [],
  loginHint: "run `codewhale` once and add your DeepSeek API key (or point it at your own model)",
  probeArgs: () => [
    CLI.skipOnboarding, CLI.noProjectConfig, CLI.exec, ...CLI.streamFormat,
    ...CLI.sandbox("read-only"), CLI.separator, "Reply with the single word: ok"
  ],

  // The prompt is a positional after `--` — see streamingArgs.
  promptOnStdin: false,
  supportsBuffered: false,

  streamingArgs,

  // Writes the MCP file CODEWHALE_MCP_CONFIG points at — see the header. Runs
  // for the ambient login too, which is why the engine calls prepare()
  // whether or not there is a managed config directory.
  prepare(job, { filesDir }) {
    writeConfig(job, mcpPathIn(filesDir()))
  },

  // The variable is set only when the file was actually written: pointing
  // CodeWhale at a path that does not exist would be an error where "no MCP"
  // is the honest state.
  envFor: (job, { filesDir } = {}) => {
    const env = { ...envForGithub(job), ...envForWeb(job) }
    if (filesDir && Object.keys(mcpServersFor(job)).length > 0) {
      env.CODEWHALE_MCP_CONFIG = mcpPathIn(filesDir())
    }
    return env
  },

  describeEvent,
  collapseEvents,
  partialTextFrom,
  writtenPathFrom,
  classifyFailure: (detail) =>
    classifyFailure(detail, {
      name: "CodeWhale",
      loginHint: "run `codewhale` once and check its provider configuration"
    }),

  limitations: [
    "The forbidden-git deny list is not enforced by a CodeWhale flag — the workspace-write " +
      "sandbox and the system prompt are the bounds.",
    "What a run can spend is whatever provider CodeWhale itself is configured with — " +
      "a DeepSeek API key bills per token, not a monthly plan."
  ],

  resolveBin() {
    return locateBin({ cli: this.cli, envVar: this.binEnvVar, extraHomePaths: this.extraHomePaths })
  },

  advice() {
    const { bin, source } = this.resolveBin()
    return locationAdvice({ name: this.name, install: this.install, bin, source })
  }
}
