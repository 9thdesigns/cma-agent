import fs from "node:fs"
import path from "node:path"

import {
  builtinWebTools, classifyFailure, emptyUsage, envForGithub, envForWeb, GITHUB_MCP_SERVER,
  locateBin, locationAdvice, mcpServersFor, normalizeUsage, shortCommand, shortPath
} from "./shared.js"

// ---------------------------------------------------------------------------
// Google's Gemini CLI (`gemini`).
//
// Flags below were read out of the shipped bundle of @google/gemini-cli
// 0.54.4 rather than from prose, so they are what that build actually parses:
//
//   --prompt / -p        string, nargs 1. "Run in non-interactive (headless)
//                        mode with the given prompt."
//   --output-format      choices: text | json | stream-json
//   --model              string
//   --approval-mode      choices: default | auto_edit | yolo | plan
//   --allowed-tools      array, comma-separated. Marked DEPRECATED in favour
//                        of the Policy Engine, but still parsed.
//   --yolo / -y          boolean. Mutually exclusive with --approval-mode.
//
// `auto_edit` is the direct analogue of Claude Code's `acceptEdits`:
// auto-approve edit tools and nothing else. That correspondence is what makes
// this adapter safe to ship without inventing a permission model.
//
// ── The v1 limitation, stated rather than hidden ───────────────────────────
//
// A Gemini repository turn can read and edit files. It CANNOT run git.
//
// Auto-approving shell would need either `--yolo` (auto-approve *all* actions,
// which is handing over the machine) or a Policy Engine file whose format is
// not verified here. Given the choice between over-granting and a stated
// limitation, this takes the limitation: the allowance fails CLOSED.
//
// Work still ships. The companion's own `git.push` command (src/repos.js) is
// what commits and pushes a working tree, it is driven by the server rather
// than by the model, and it is already bounded by the shared-folder allowlist.
// So a Gemini session edits files and the machine pushes them — the model
// never gets a shell.
//
// ── MCP wiring, without touching the user's ~/.gemini ──────────────────────
//
// This adapter used to state a gap here: Gemini discovers MCP servers from
// settings files, the user's own directory is not ours to write into, and the
// env var that relocates it was unverified. The gap is closed by a different
// door, and every piece of it is in Gemini CLI's own documentation:
//
//   * Settings load from four layers, and the SYSTEM OVERRIDES file has the
//     final say. Its path is overridden with GEMINI_CLI_SYSTEM_SETTINGS_PATH.
//   * `mcpServers` entries merge across layers, so a file of ours that names
//     cma_github and cma_web ADDS them beside whatever the user configured.
//   * MCP server child processes do NOT inherit the CLI's environment —
//     sensitive variables are redacted — so each entry lists what it needs in
//     `env`, as `$VAR` references the CLI expands at spawn. The FILE carries
//     variable names, never values: the token still travels by environment.
//   * `trust: true` bypasses per-call confirmations for a server, which is
//     what makes the tools usable at all in a run with nobody to confirm.
//
// prepare() writes that file into OUR profile directory (config.js), merging
// in the machine's real system settings first — pointing the variable at our
// file must not silently disable an enterprise policy file that was already
// in force. Nothing is ever written into ~/.gemini or the repository.
// ---------------------------------------------------------------------------

const CLI = {
  prompt: (text) => ["--prompt", text],
  streamFormat: ["--output-format", "stream-json"],
  model: (id) => ["--model", id],
  approvalMode: (mode) => ["--approval-mode", mode],
  // Comma-separated, coerced by the CLI. One flag, one value — not variadic,
  // so it cannot swallow anything.
  allowedTools: (list) => ["--allowed-tools", list.join(",")],
  // Same shape. --allowed-tools only auto-APPROVES; it removes nothing, so it
  // is no help against a tool we want gone from the surface entirely.
  excludeTools: (list) => ["--exclude-tools", list.join(",")]
}

// Gemini's own tool names, taken from the shipped bundle. Read and edit only —
// run_shell_command is deliberately absent; see the note above.
const FILE_TOOLS = [
  "read_file",
  "read_many_files",
  "write_file",
  "replace",
  "list_directory",
  "search_file_content",
  "glob"
]

export function baseArgs(job) {
  const args = [...CLI.streamFormat]
  if (job.model) args.push(...CLI.model(job.model))

  // Gemini's own google_web_search and web_fetch, gone in EVERY job shape —
  // not only a repository turn. The reasoning is the one that applies to any
  // runtime here: a headless run has nobody to answer a permission prompt, so
  // the CLI's own web tools can never succeed, and a tool the model can see
  // beats a system prompt telling it not to reach for that tool. It should be
  // reaching for mcp__cma_web__* instead, which needs no grant.
  //
  // --exclude-tools is registered in engine.js's CAPABILITY_FLAGS, so a build
  // that does not parse it loses the exclusion rather than the whole turn.
  const builtins = builtinWebTools("gemini_cli")
  if (builtins.length > 0) args.push(...CLI.excludeTools(builtins))

  if (job.workdir) {
    // Edits without prompting, nothing else. A headless run has no terminal to
    // approve in, so anything not auto-approved simply does not happen.
    args.push(...CLI.approvalMode("auto_edit"))
    args.push(...CLI.allowedTools(FILE_TOOLS))
  }

  return args
}

// The whole prompt travels as ONE argument. `--prompt` is nargs 1, so there is
// no positional for anything to swallow and no ordering hazard of the kind
// that killed an earlier Claude Code release.
//
// Worth knowing: this puts the conversation in argv, so a very long history is
// bounded by ARG_MAX (~2MB on Linux, ~1MB on macOS) rather than by the model's
// context. The server compacts before it gets close.
export function streamingArgs(job, prompt = "") {
  return [...CLI.prompt(prompt), ...baseArgs(job)]
}

// Gemini has no append-system-prompt flag either, so the system text rides the
// prompt — kept visibly separated so a model reading it can tell the
// operator's instructions from the conversation.
export function renderPrompt(job, conversation) {
  if (!job.system) return conversation
  return `<system>\n${job.system}\n</system>\n\n${conversation}`
}

// Where our system-overrides shim lives inside the directory the engine hands
// us (our profile directory, ambient login included). One function because
// prepare() writes it and envFor() names it, and the two must agree.
export function settingsPathIn(dir) {
  return path.join(dir, "system-settings.json")
}

// The machine's REAL system settings, so ours can extend them instead of
// replacing them. The path is the one Gemini itself would read: the override
// variable when the environment already sets one, the OS's documented default
// otherwise. Unreadable or absent is an empty policy, which is the common case.
const SYSTEM_SETTINGS_DEFAULTS = {
  darwin: "/Library/Application Support/GeminiCli/settings.json",
  win32: "C:\\ProgramData\\gemini-cli\\settings.json"
}

function existingSystemSettings() {
  const file = process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH ||
               SYSTEM_SETTINGS_DEFAULTS[process.platform] ||
               "/etc/gemini-cli/settings.json"
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"))
    return parsed && typeof parsed === "object" ? parsed : {}
  } catch {
    return {}
  }
}

// Each server's entry: command and args from the shared map, plus the `env`
// references Gemini needs because it redacts the inherited environment, plus
// `trust` because a headless run has nobody to answer a per-call confirmation.
// `$CMA_GITHUB_REPOS` is included even though single-repo jobs never set it:
// Gemini resolves an unset variable to an empty string, and the MCP server
// treats an empty string as "no list" (see linkedRepos in mcp.js).
function geminiServersFor(job) {
  const passthrough = {
    [GITHUB_MCP_SERVER]: ["CMA_GITHUB_ENDPOINT", "CMA_GITHUB_TOKEN", "CMA_GITHUB_REPOS"]
  }

  const entries = {}
  for (const [name, server] of Object.entries(mcpServersFor(job))) {
    const vars = passthrough[name] || ["CMA_WEB_ENDPOINT", "CMA_WEB_TOKEN"]
    entries[name] = {
      command: server.command,
      args: server.args,
      env: Object.fromEntries(vars.map((v) => [v, `$${v}`])),
      trust: true
    }
  }
  return entries
}

// Exported so what a run is wired with can be asserted without spawning
// anything — the same reasoning as Cursor's permissionsFor.
export function systemSettingsFor(job) {
  const base = existingSystemSettings()
  return {
    ...base,
    mcpServers: { ...(base.mcpServers || {}), ...geminiServersFor(job) }
  }
}

// Called before every spawn. Writes our shim when the job has something to
// mount, and removes a stale one when it doesn't — a leftover file would keep
// offering tools whose grant is gone, which is worse than no file.
export function writeConfig(job, file) {
  if (Object.keys(mcpServersFor(job)).length === 0) {
    if (fs.existsSync(file)) fs.rmSync(file, { force: true })
    return
  }

  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  fs.writeFileSync(file, `${JSON.stringify(systemSettingsFor(job), null, 2)}\n`, { mode: 0o600 })
}

// Event types, from the bundle's JsonStreamEventType enum:
//   init | message | tool_use | tool_result | error | result
function describeEvent(event) {
  if (!event || typeof event !== "object") return null

  if (event.type === "init") return "Starting up"

  if (event.type === "tool_use") {
    const args = event.parameters || {}
    const file = shortPath(args.file_path || args.path || args.absolute_path)

    switch (event.tool_name) {
      case "read_file":
      case "read_many_files":     return file ? `Reading ${file}` : "Reading a file"
      case "write_file":          return file ? `Writing ${file}` : "Writing a file"
      case "replace":             return file ? `Editing ${file}` : "Editing a file"
      case "list_directory":      return file ? `Looking in ${file}` : "Looking for files"
      case "run_shell_command": {
        const cmd = shortCommand(args.command)
        return cmd ? `Running ${cmd}` : "Running a command"
      }
      case "search_file_content":
      case "glob": {
        const pattern = String(args.pattern || args.query || "").trim().slice(0, 40)
        return pattern ? `Searching for ${pattern}` : "Searching the code"
      }
      case "google_web_search":
      case "web_fetch": {
        let host = ""
        try { host = new URL(String(args.url || "")).host } catch { host = "" }
        return host ? `Reading ${host}` : "Searching the web"
      }
      default: {
        const pretty = String(event.tool_name || "").replace(/_/g, " ").trim()
        return pretty ? `${pretty.charAt(0).toUpperCase()}${pretty.slice(1)}`.slice(0, 60) : "Working"
      }
    }
  }

  return null
}

// `message` events carry the whole content as a string and a role, which makes
// them both the answer and the partial-text stream.
function assistantTextOf(event) {
  if (event?.type !== "message" || event.role !== "assistant") return null
  return typeof event.content === "string" && event.content ? event.content : null
}

function partialTextFrom(event) {
  return assistantTextOf(event)
}

// The `result` event carries status, stats and an error — but NOT the final
// text. That is the one place Gemini's stream differs materially from the
// other two: the answer has to be assembled from the assistant messages.
function tokensFrom(stats) {
  if (!stats || typeof stats !== "object") return {}

  // The stats object nests differently between builds, so look in the places
  // it has been rather than assuming one. Nothing here guesses a number: an
  // unrecognised shape yields zeros and the answer still arrives.
  const candidates = [stats, stats.tokens, stats.usage, stats.metrics, stats.models]
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") continue
    const prompt = candidate.promptTokenCount ?? candidate.input_tokens ?? candidate.prompt
    const output = candidate.candidatesTokenCount ?? candidate.output_tokens ?? candidate.candidates
    if (prompt === undefined && output === undefined) continue

    return {
      input_tokens: Number(prompt || 0),
      output_tokens: Number(output || 0),
      cache_read_input_tokens: Number(candidate.cachedContentTokenCount || 0)
    }
  }

  return {}
}

function collapseEvents(events) {
  const out = {
    content: "", usage: emptyUsage(), model: null,
    stopReason: null, isError: false, errorStatus: null
  }

  let sawResult = false
  const assistantText = []

  for (const event of events) {
    if (event?.type === "init" && event.model) out.model = event.model

    const text = assistantTextOf(event)
    if (text) assistantText.push(text)

    // A standalone `error` event is a warning channel as well as a failure
    // one — it carries `severity`. Only a genuine error should fail the turn;
    // a warning about a blocked tool call must not throw away a good answer.
    if (event?.type === "error" && event.severity !== "warning") {
      out.errorStatus = out.errorStatus || String(event.message || "").slice(0, 300)
    }

    if (event?.type === "result") {
      sawResult = true
      out.stopReason = event.status || null
      out.isError = event.status === "error"
      if (event.error?.message) out.errorStatus = String(event.error.message).slice(0, 300)
      out.usage = normalizeUsage(tokensFrom(event.stats))
    }
  }

  out.content = assistantText.join("")
  return { ...out, sawResult }
}

export const gemini = {
  id: "gemini_cli",
  name: "Gemini CLI",
  cli: "gemini",
  install: "https://github.com/google-gemini/gemini-cli",
  binEnvVar: "CMA_GEMINI_BIN",
  extraHomePaths: [".gemini/bin/gemini"],

  // Gemini keeps its login in ~/.gemini. The environment variable that
  // relocates that directory is not verified, so this build supports exactly
  // one Gemini login per machine — the ambient one — rather than pretending
  // to isolate profiles it cannot. `cma-agent runtimes:list` says so, which
  // is better than two profiles silently sharing an account and billing the
  // wrong plan.
  configDirEnvVar: null,
  multiLogin: false,
  ambientProfile: true,
  profilesDirName: "gemini-profiles",

  versionArgs: ["--version"],
  loginArgs: () => [],
  loginHint: "run `gemini` once and complete the browser sign-in",
  probeArgs: () => ["--prompt", "Reply with the single word: ok", "--output-format", "json"],

  // The prompt is the value of --prompt, not stdin — see streamingArgs.
  promptOnStdin: false,
  supportsBuffered: false,

  streamingArgs,
  renderPrompt,

  // Writes the system-overrides shim (MCP servers) before every spawn — see
  // the header. Runs for the ambient login too, which is why the engine calls
  // prepare() whether or not there is a managed config directory.
  prepare(job, { filesDir }) {
    writeConfig(job, settingsPathIn(filesDir()))
  },

  // The variable is set only when the shim was actually written: with no
  // grant there is no file, and pointing Gemini at a missing path would
  // silence a real enterprise policy file for nothing.
  envFor: (job, { filesDir } = {}) => {
    const env = { ...envForGithub(job), ...envForWeb(job) }
    if (filesDir && Object.keys(mcpServersFor(job)).length > 0) {
      env.GEMINI_CLI_SYSTEM_SETTINGS_PATH = settingsPathIn(filesDir())
    }
    return env
  },

  describeEvent,
  collapseEvents,
  partialTextFrom,
  classifyFailure: (detail) =>
    classifyFailure(detail, { name: "Gemini", loginHint: "run `gemini` once to sign in" }),

  // What this runtime cannot do, in a form the CLI can print. Being able to
  // say "edits yes, git no" beats a user discovering it when a session
  // finishes by asking them to push its work by hand. The GitHub
  // pull-request line that used to sit here is gone: the cma_github and
  // cma_web MCP servers now mount through the system-settings shim, so a
  // Gemini run can open pull requests and read the web — it still cannot run
  // git itself.
  limitations: [
    "Repository turns can read and edit files, but cannot run git — the machine pushes for them.",
    "One Gemini login per machine."
  ],

  resolveBin() {
    return locateBin({ cli: this.cli, envVar: this.binEnvVar, extraHomePaths: this.extraHomePaths })
  },

  advice() {
    const { bin, source } = this.resolveBin()
    return locationAdvice({ name: this.name, install: this.install, bin, source })
  }
}
