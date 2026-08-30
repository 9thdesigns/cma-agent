import fs from "node:fs"
import path from "node:path"

import {
  classifyFailure, emptyUsage, envForGithub, envForWeb, FORBIDDEN_GIT, GIT_VERBS,
  locateBin, locationAdvice, mcpServersFor, normalizeUsage, shortCommand, shortPath
} from "./shared.js"

// ---------------------------------------------------------------------------
// Cursor's headless agent (`cursor-agent`).
//
// Worth having alongside Claude Code for one reason: the catalogue. A single
// Cursor subscription reaches Cursor's own Composer models AND the frontier
// models from Anthropic, OpenAI, Google and xAI, under Cursor's own model ids.
//
// Verified against the flag surface two independent third-party adapters use
// (@sumeru/adapter-cursor-agent, pi-cursor-agent) and Cursor's CLI reference.
// As with every other product's CLI, when an upgrade breaks a run this object
// is the first thing to check against `cursor-agent --help`.
//
// ── Three differences from Claude Code that are NOT cosmetic ────────────────
//
// 1. There is no per-invocation tool allowlist. cursor-agent has `--force`
//    (don't stop to ask) and file-based permissions. `--force` on its own is
//    closer to Claude Code's `bypassPermissions` than to `acceptEdits`, so
//    using it bare would quietly hand a coding turn the whole machine. Instead
//    we write the same allow/deny sets the Claude Code path passes as flags
//    into a permissions.json inside our own config directory, and THAT is what
//    bounds the run. See writeConfig below.
//
// 2. There is no inline `--mcp-config`. Cursor discovers MCP servers from
//    mcp.json on disk. The file we write names a command and carries no
//    secret — the GitHub token still travels by environment, exactly as it
//    does for Claude Code.
//
// 3. There is no `--append-system-prompt`. Cursor reads rules from AGENTS.md,
//    .cursorrules and .cursor/rules/*.md — all of which live in the user's
//    repository. Writing into a folder somebody shared with us to read is not
//    something to do quietly, so the system text is prepended to the prompt
//    instead. Nothing is written into the user's repo or into their ~/.cursor.
// ---------------------------------------------------------------------------

const CLI = {
  print: "-p",
  streamFormat: ["--output-format", "stream-json"],
  // `--force` means "don't stop to ask". It is safe ONLY because
  // permissions.json is in place before we spawn — see writeConfig.
  force: "--force",
  model: (id) => ["--model", id],
  workspace: (dir) => ["--workspace", dir]
}

// Cursor's permission tokens. Same sets as the Claude Code adapter, spelled
// Cursor's way, so the two runtimes cannot drift on what a turn may do.
const FILE_TOOLS = ["Read", "Edit", "Write", "Delete", "List", "Search", "Glob", "Grep"]

function permissionsFor(job) {
  const allow = []
  const deny = FORBIDDEN_GIT.map((command) => `Shell(${command})`)

  if (job.workdir) {
    allow.push(...FILE_TOOLS)
    allow.push(...GIT_VERBS.map((verb) => `Shell(git ${verb})`))
  }

  return { permissions: { allow, deny } }
}

// Exported so the allowance a repository turn actually runs with can be
// asserted without spawning anything. This is a security decision and it
// should not be reachable only through a child process.
export { permissionsFor }

// Everything we put on disk goes in OUR directory, never in ~/.cursor and
// never in the user's repository. `configDir` is the per-profile directory the
// engine hands us, which is also what CURSOR_CONFIG_DIR points at — so the
// files are found without a flag, and removed with the profile.
export function writeConfig(job, configDir) {
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 })

  fs.writeFileSync(
    path.join(configDir, "permissions.json"),
    `${JSON.stringify(permissionsFor(job), null, 2)}\n`,
    { mode: 0o600 }
  )

  // Only when there is something to connect. A chat completion with no GitHub
  // credentials gets no MCP file at all rather than an empty one.
  const mcpPath = path.join(configDir, "mcp.json")
  const servers = mcpServersFor(job)
  if (Object.keys(servers).length > 0) {
    fs.writeFileSync(
      mcpPath,
      `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`,
      { mode: 0o600 }
    )
  } else if (fs.existsSync(mcpPath)) {
    // A previous run left one behind and this job has no GitHub grant. Removing
    // it is the difference between "the tools aren't offered" and "the tools
    // are offered and fail", and it keeps a stale endpoint from being reachable.
    fs.rmSync(mcpPath, { force: true })
  }
}

export function baseArgs(job) {
  const args = []
  if (job.model) args.push(...CLI.model(job.model))
  // Bounded by permissions.json, which prepare() has already written.
  if (job.workdir) {
    args.push(CLI.force)
    args.push(...CLI.workspace(job.workdir))
  }
  return args
}

// The prompt is an ARGUMENT here, not stdin — the opposite of the Claude Code
// path, and deliberately so. cursor-agent takes the prompt as a positional and
// none of its options are variadic, so there is nothing to swallow it. The
// engine knows which form to use from `promptOnStdin`.
export function streamingArgs(job, prompt = "") {
  return [CLI.print, prompt, ...CLI.streamFormat, ...baseArgs(job)]
}

// Cursor has no system-prompt flag, so the system text rides the prompt. Kept
// visibly separated rather than glued on, so a model reading it can tell the
// operator's instructions from the conversation.
export function renderPrompt(job, conversation) {
  if (!job.system) return conversation
  return `<system>\n${job.system}\n</system>\n\n${conversation}`
}

// cursor-agent emits tool calls as their OWN top-level events with explicit
// started/completed subtypes, rather than embedding tool_use inside an
// assistant message the way Claude Code does. That is the one structural
// difference between the two streams.
function toolNameOf(toolCall) {
  if (!toolCall || typeof toolCall !== "object") return null
  return Object.keys(toolCall).find((key) => key.endsWith("ToolCall")) || null
}

function describeEvent(event) {
  if (!event || typeof event !== "object") return null

  if (event.type === "system" && event.subtype === "init") return "Starting up"

  if (event.type === "tool_call" && event.subtype === "started") {
    const name = toolNameOf(event.tool_call)
    if (!name) return "Working"

    const inner = event.tool_call[name] || {}
    const args = inner.args || inner || {}
    const file = shortPath(args.path || args.file_path || args.target_file)

    switch (name) {
      case "editToolCall":   return file ? `Editing ${file}` : "Editing a file"
      case "writeToolCall":  return file ? `Writing ${file}` : "Writing a file"
      case "deleteToolCall": return file ? `Deleting ${file}` : "Deleting a file"
      case "readToolCall":   return file ? `Reading ${file}` : "Reading a file"
      case "lsToolCall":
      case "listToolCall":   return file ? `Looking in ${file}` : "Looking for files"
      case "shellToolCall": {
        const cmd = shortCommand(args.command)
        return cmd ? `Running ${cmd}` : "Running a command"
      }
      case "grepToolCall":
      case "searchToolCall": {
        const pattern = String(args.pattern || args.query || "").trim().slice(0, 40)
        return pattern ? `Searching for ${pattern}` : "Searching the code"
      }
      case "todoToolCall":   return "Updating the plan"
      case "webToolCall":
      case "fetchToolCall": {
        let host = ""
        try { host = new URL(String(args.url || "")).host } catch { host = "" }
        return host ? `Reading ${host}` : "Searching the web"
      }
      default: {
        // mcpToolCall and anything Cursor adds later. Strip the suffix and
        // space out the camel case, same as the Claude Code fallback.
        const pretty = name.replace(/ToolCall$/, "").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase()
        return pretty ? `${pretty.charAt(0).toUpperCase()}${pretty.slice(1)}`.slice(0, 60) : "Working"
      }
    }
  }

  // `thinking` is Cursor's reasoning channel — private scratchwork, and it
  // arrives constantly, so it is a liveness signal and not a ticker line.
  if (event.type === "thinking") return "Thinking"

  return null
}

function textOf(message) {
  if (!message || !Array.isArray(message.content)) return ""
  return message.content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("")
}

// Assistant events carry segments of the answer as they are produced, so they
// double as the partial-text stream. The final answer still comes from the
// `result` event, so if a build ever emits cumulative rather than incremental
// assistant events the worst case is a repeated fragment in the live ticker,
// corrected the moment the run finishes.
function partialTextFrom(event) {
  if (event?.type !== "assistant") return null
  return textOf(event.message) || null
}

function collapseEvents(events) {
  const out = {
    content: "", usage: emptyUsage(), model: null,
    stopReason: null, isError: false, errorStatus: null
  }

  let sawResult = false
  const assistantText = []

  for (const event of events) {
    if (event?.type === "system" && event.subtype === "init" && event.model) {
      out.model = event.model
    }

    if (event?.type === "assistant") {
      const text = textOf(event.message)
      if (text) assistantText.push(text)
      if (event.message?.model) out.model = event.message.model
    }

    if (event?.type === "result") {
      sawResult = true
      if (typeof event.result === "string") out.content = event.result
      out.stopReason = event.subtype || event.stop_reason || null
      // Same trap as Claude Code: an in-band failure comes back with a zero
      // exit code and is_error true.
      out.isError = event.is_error === true
      out.errorStatus = event.api_error_status || null
      out.usage = normalizeUsage(event.usage)
    }
  }

  if (!out.content) out.content = assistantText.join("")
  return { ...out, sawResult }
}

export const cursor = {
  id: "cursor",
  name: "Cursor",
  cli: "cursor-agent",
  install: "https://cursor.com/cli",
  binEnvVar: "CMA_CURSOR_BIN",
  extraHomePaths: [".cursor/bin/cursor-agent", ".local/bin/cursor-agent"],

  configDirEnvVar: "CURSOR_CONFIG_DIR",
  profilesDirName: "cursor-profiles",

  // Cursor is the one runtime with no ambient mode.
  //
  // Every other adapter can run with no config-directory override and pick up
  // whatever login the user already has. Cursor cannot, because the allowance
  // that makes `--force` safe is a FILE, and the only directory we may write it
  // to is one we own. Writing into ~/.cursor would edit the config the user's
  // editor reads; writing into the workspace would edit their repository.
  //
  // So even the "default" profile gets a CMA-managed directory, and signing in
  // once with `cma-agent runtimes:login --runtime cursor` is a required step
  // rather than an optional one. The probe reports `logged_out` until it is
  // done, which is what makes that legible instead of mysterious.
  ambientProfile: false,

  versionArgs: ["--version"],
  loginArgs: () => ["login"],
  loginHint: "cma-agent runtimes:login --runtime cursor",
  probeArgs: () => [CLI.print, "Reply with the single word: ok", ...CLI.streamFormat],

  // The prompt is a positional argument — see streamingArgs.
  promptOnStdin: false,
  // No `--output-format json` equivalent worth falling back to: stream-json
  // already ends with the same result envelope the buffered format would give
  // us, so there is nothing a fallback would buy.
  supportsBuffered: false,

  streamingArgs,
  renderPrompt,
  envFor: (job) => ({ ...envForGithub(job), ...envForWeb(job) }),

  // Called before every spawn, with the profile's config directory. This is
  // where the allowance and the MCP wiring land.
  prepare(job, { configDir }) {
    writeConfig(job, configDir)
  },

  describeEvent,
  collapseEvents,
  partialTextFrom,
  // The one runtime whose own web tools are still on its surface.
  //
  // Claude Code takes --disallowedTools and Gemini takes --exclude-tools, so
  // both have their built-in web tools removed and are left with
  // mcp__cma_web__*, which needs no grant. cursor-agent names tools in the
  // permissions file this adapter writes rather than in a documented flag, and
  // its web tool's name was never checked against a real build — the same trap
  // the model ids in AiCredential::LOCAL_RUNTIMES fell into, where names
  // written from what a vendor calls something failed at run time.
  //
  // A guessed deny entry would be inert and would read as coverage, so the gap
  // is stated instead of papered over. Closing it needs one look at a real
  // cursor-agent build: add the name to BUILTIN_WEB_TOOLS.cursor in shared.js
  // and to the deny set in permissionsFor, and this line goes away.
  limitations: [
    "Cursor's own web search is not removed from the run — prefer the " +
      "mcp__cma_web__* tools, which need no approval."
  ],

  classifyFailure: (detail) =>
    classifyFailure(detail, { name: "Cursor", loginHint: "cma-agent runtimes:login --runtime cursor" }),

  resolveBin() {
    return locateBin({ cli: this.cli, envVar: this.binEnvVar, extraHomePaths: this.extraHomePaths })
  },

  advice() {
    const { bin, source } = this.resolveBin()
    return locationAdvice({ name: this.name, install: this.install, bin, source })
  }
}
