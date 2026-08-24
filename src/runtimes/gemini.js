import {
  builtinWebTools, classifyFailure, emptyUsage, locateBin, locationAdvice, normalizeUsage,
  shortCommand, shortPath
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
// For the same reason there is no GitHub MCP wiring here: Gemini discovers MCP
// servers from a settings.json inside its own config directory, and the env
// var that relocates that directory is not something this file is willing to
// guess at. `cma-agent runtimes:doctor` reports the gap rather than pretending.
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
  envFor: () => ({}),
  describeEvent,
  collapseEvents,
  partialTextFrom,
  classifyFailure: (detail) =>
    classifyFailure(detail, { name: "Gemini", loginHint: "run `gemini` once to sign in" }),

  // What this runtime cannot do, in a form the CLI can print. Being able to
  // say "edits yes, git no" beats a user discovering it when a session
  // finishes by asking them to push its work by hand.
  limitations: [
    "Repository turns can read and edit files, but cannot run git — the machine pushes for them.",
    "The GitHub pull-request tools are not available; use a Claude Code or Cursor provider for those.",
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
