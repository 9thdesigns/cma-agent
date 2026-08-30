import {
  classifyFailure, emptyUsage, locateBin, locationAdvice, normalizeUsage,
  shortCommand, shortPath
} from "./shared.js"

// ---------------------------------------------------------------------------
// Google's Antigravity CLI (`agy`) — the client Google moved its consumer
// tiers to when Gemini CLI stopped serving them (2026-06-18). A free Google
// account signs in and runs it, which makes this the one runtime here that
// costs nothing to try.
//
// The flag surface below is the headless contract agy documents and third-
// party harnesses drive it with:
//
//   --prompt <text>          headless mode, one prompt, nargs 1
//   --output-format stream-json   strongly-typed NDJSON events
//   --non-interactive        never open the TUI, never wait for a keypress
//   --model <id>             model override (gemini-3.5-flash, gemini-3.1-pro)
//   --mode=accept-edits      auto-approve the file-edit tools and nothing else
//
// `--mode=accept-edits` is the direct analogue of Claude Code's `acceptEdits`
// and Gemini CLI's `auto_edit`: the standard file operations (write_to_file,
// replace_file_content, multi_replace_file_content) run without asking, and
// everything else keeps its rules. In a headless run a tool that still needs
// approval is soft-denied with a note — which is the behaviour we want, and
// why the other flag agy offers (`--dangerously-skip-permissions`, its yolo
// mode) is never used here: it approves shell too, which is handing a coding
// turn the whole machine.
//
// ── The v1 limitation, stated rather than hidden ───────────────────────────
//
// An Antigravity repository turn can read and edit files. It CANNOT run git —
// `run_command` stays behind approval in every mode, and a headless run has
// nobody to approve. Same posture, and same answer, as the Gemini CLI
// adapter: the companion's own `git.push` command (src/repos.js) commits and
// pushes the working tree, driven by the server and bounded by the
// shared-folder allowlist. The model edits; the machine ships.
//
// No MCP wiring either, for the same reason as Gemini: agy discovers MCP
// servers from settings inside its own config directory, and the mechanism to
// relocate that directory is not verified — so nothing is written into a
// directory the user's own agy reads.
// ---------------------------------------------------------------------------

const CLI = {
  prompt: (text) => ["--prompt", text],
  streamFormat: ["--output-format", "stream-json"],
  nonInteractive: "--non-interactive",
  model: (id) => ["--model", id],
  // One token on purpose: sources consistently spell it with `=`, both forms
  // parse, and a single token is what the engine's degraded retry can drop
  // cleanly if an older build rejects it.
  acceptEdits: "--mode=accept-edits"
}

export function baseArgs(job) {
  const args = [...CLI.streamFormat, CLI.nonInteractive]
  if (job.model) args.push(...CLI.model(job.model))
  // Edits without prompting, nothing else — a headless run has no terminal to
  // approve in, so anything not auto-approved simply does not happen.
  if (job.workdir) args.push(CLI.acceptEdits)
  return args
}

// The whole prompt travels as the value of --prompt (nargs 1), so there is no
// positional for anything to swallow. Same ARG_MAX caveat as Gemini: a very
// long history is bounded by argv (~1–2MB), and the server compacts before it
// gets close.
export function streamingArgs(job, prompt = "") {
  return [...CLI.prompt(prompt), ...baseArgs(job)]
}

// No append-system-prompt flag is verified for agy, so the system text rides
// the prompt — visibly fenced, so a model reading it can tell the operator's
// instructions from the conversation.
export function renderPrompt(job, conversation) {
  if (!job.system) return conversation
  return `<system>\n${job.system}\n</system>\n\n${conversation}`
}

// ---------------------------------------------------------------------------
// The event stream: typed NDJSON with three top-level shapes —
//
//   init          run metadata (model)
//   step_update   progress, discriminated by a closed `step_type` vocabulary
//                 (text / thinking / tool activity)
//   result        exactly one per turn: status and token counts
//
// Field names inside step_update are read defensively: this is another
// product's format, closed-source, and a build that renames a field should
// cost us the ticker line, never the answer.
// ---------------------------------------------------------------------------

function stepType(event) {
  if (event?.type !== "step_update") return null
  return String(event.step_type || event.step?.type || "")
}

function stepText(event) {
  const value = event.text ?? event.content ?? event.delta ?? event.step?.text
  return typeof value === "string" && value ? value : null
}

function describeTool(event) {
  const tool = event.tool || event.step?.tool || {}
  const name = String(event.tool_name || tool.name || "")
  const args = tool.args || tool.parameters || event.parameters || {}
  const file = shortPath(args.path || args.file_path || args.TargetFile)

  switch (name) {
    case "write_to_file":            return file ? `Writing ${file}` : "Writing a file"
    case "replace_file_content":
    case "multi_replace_file_content": return file ? `Editing ${file}` : "Editing a file"
    case "read_file":
    case "view_file":                return file ? `Reading ${file}` : "Reading a file"
    case "list_dir":                 return file ? `Looking in ${file}` : "Looking for files"
    case "run_command": {
      const cmd = shortCommand(args.command || args.CommandLine)
      return cmd ? `Running ${cmd}` : "Running a command"
    }
    case "grep_search":
    case "find_by_name": {
      const pattern = String(args.pattern || args.query || args.Query || "").trim().slice(0, 40)
      return pattern ? `Searching for ${pattern}` : "Searching the code"
    }
    default: {
      const pretty = name.replace(/_/g, " ").trim()
      return pretty ? `${pretty.charAt(0).toUpperCase()}${pretty.slice(1)}`.slice(0, 60) : "Working"
    }
  }
}

function describeEvent(event) {
  if (!event || typeof event !== "object") return null

  if (event.type === "init") return "Starting up"

  const kind = stepType(event)
  if (!kind) return null

  if (kind.includes("tool")) return describeTool(event)
  // Reasoning arrives constantly — a liveness signal, not a ticker line.
  if (kind.includes("thinking") || kind.includes("reasoning")) return "Thinking"
  return null
}

// Answer text streams as text-typed step_updates; they double as the
// partial-text channel.
function assistantTextOf(event) {
  const kind = stepType(event)
  if (!kind || !kind.includes("text")) return null
  return stepText(event)
}

function partialTextFrom(event) {
  return assistantTextOf(event)
}

// Token counts on the result event. The exact key spellings vary between
// builds (snake_case and camelCase have both been seen in the wild), so probe
// the places they have been rather than assuming one; an unrecognised shape
// yields zeros and the answer still arrives.
function tokensFrom(result) {
  const candidates = [result?.usage, result?.tokens, result?.stats, result]
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") continue
    const input = candidate.input_tokens ?? candidate.inputTokens
    const output = candidate.output_tokens ?? candidate.outputTokens
    if (input === undefined && output === undefined) continue

    return {
      input_tokens: Number(input || 0),
      output_tokens: Number(output || 0),
      cache_read_input_tokens: Number(
        candidate.cache_read_input_tokens ?? candidate.cacheRead ?? candidate.cacheReadTokens ?? 0
      )
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

    if (event?.type === "error") {
      out.errorStatus = out.errorStatus || String(event.message || event.error || "").slice(0, 300)
    }

    if (event?.type === "result") {
      sawResult = true
      out.stopReason = event.status || event.subtype || null
      out.isError = event.status === "error" || event.is_error === true
      if (event.error?.message || typeof event.error === "string") {
        out.errorStatus = String(event.error?.message || event.error).slice(0, 300)
      }
      if (event.model) out.model = event.model
      out.usage = normalizeUsage(tokensFrom(event))
      // Some builds put the final text on the result; most stream it. Prefer
      // the terminal copy when it exists.
      if (typeof event.result === "string" && event.result) out.content = event.result
    }
  }

  if (!out.content) out.content = assistantText.join("")
  return { ...out, sawResult }
}

export const antigravity = {
  id: "antigravity",
  name: "Antigravity",
  cli: "agy",
  install: "https://antigravity.google/docs/cli",
  binEnvVar: "CMA_AGY_BIN",
  extraHomePaths: [".antigravity/bin/agy"],

  // agy keeps its login in the device keyring / its own config directory, and
  // no environment variable that relocates it is verified — so this build
  // supports exactly one Antigravity login per machine, the ambient one,
  // rather than pretending to isolate profiles it cannot. Same stance, same
  // reason, as Gemini CLI.
  configDirEnvVar: null,
  multiLogin: false,
  ambientProfile: true,
  profilesDirName: "antigravity-profiles",

  versionArgs: ["--version"],
  loginArgs: () => [],
  loginHint: "run `agy` once and complete the Google sign-in",
  probeArgs: () => ["--prompt", "Reply with the single word: ok", "--output-format", "json", "--non-interactive"],

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
    classifyFailure(detail, { name: "Antigravity", loginHint: "run `agy` once to sign in" }),

  // What this runtime cannot do, in a form the CLI can print.
  limitations: [
    "Repository turns can read and edit files, but cannot run git — the machine pushes for them.",
    "The GitHub pull-request and cma web tools are not available: agy only reads MCP config from " +
      "~/.gemini, which is the user's own directory and not ours to write into. Every other " +
      "coding runtime here mounts them.",
    "One Antigravity login per machine.",
    "agy's own web tools are not removed from the run (their names are unverified)."
  ],

  resolveBin() {
    return locateBin({ cli: this.cli, envVar: this.binEnvVar, extraHomePaths: this.extraHomePaths })
  },

  advice() {
    const { bin, source } = this.resolveBin()
    return locationAdvice({ name: this.name, install: this.install, bin, source })
  }
}
