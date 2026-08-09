import {
  classifyFailure, emptyUsage, envForGithub, firstKey, FORBIDDEN_GIT, GIT_VERBS,
  GITHUB_MCP_SERVER, githubMcpServers, locateBin, locationAdvice, normalizeUsage,
  shortCommand, shortPath
} from "./shared.js"

// ---------------------------------------------------------------------------
// Claude Code.
//
// The CLI surface we depend on is gathered in one object on purpose. These are
// another product's flags, and they can move between versions — when something
// breaks after a Claude Code upgrade, this object is the only thing that should
// need editing. Check the installed build with `claude --help` before changing
// anything here. Verified against Claude Code 2.1.220.
// ---------------------------------------------------------------------------

const CLI = {
  print: "-p",
  outputFormat: ["--output-format", "json"],
  // Turn-by-turn NDJSON.
  //
  // `--verbose` is not optional: without it stream-json does not emit the
  // per-turn events, which are the entire point.
  //
  // `--include-partial-messages` is not optional either, and leaving it off was
  // a real bug. Plain stream-json emits one event per COMPLETED message, so a
  // model thinking hard, or generating a large tool input, is silent on the
  // wire for as long as that takes — which our idle timer read as a dead
  // process and killed mid-edit. Partial messages give token-level deltas, so
  // "no output" finally means what the timer assumes it means.
  streamFormat: ["--output-format", "stream-json", "--verbose", "--include-partial-messages"],
  model: (id) => ["--model", id],
  appendSystem: (text) => ["--append-system-prompt", text],
  // Working inside a real repository means Claude Code must be allowed to
  // edit files without stopping to ask — there is no terminal for anyone to
  // answer in. `acceptEdits` is the narrow choice on purpose: edits yes,
  // arbitrary commands no. The directory it is confined to has already been
  // allowlisted by the user via `cma-agent repos:add`.
  permissionMode: (mode) => ["--permission-mode", mode],
  // VARIADIC, both of them, and one tool per argument — the form Claude Code's
  // own reference shows (`--allowedTools "Bash(git log:*)" "Read"`).
  //
  // These were comma-joined into a single token at first, which assumed the
  // CLI splits on commas. It might; nothing proves it, and if it doesn't the
  // allowance silently matches nothing and every git call goes back to
  // "requires approval". The list form needs no such assumption — and we know
  // for certain these options are variadic, because one of them ate the prompt
  // and killed 0.5.0 outright.
  //
  // Which is also the rule that must not be forgotten: NEVER put a bare
  // positional after these. The prompt goes in on stdin precisely so there is
  // no positional left to swallow.
  allowedTools: (list) => ["--allowedTools", ...list],
  disallowedTools: (list) => ["--disallowedTools", ...list],
  mcpConfig: (json) => ["--mcp-config", json]
}

const FILE_TOOLS = ["Read", "Write", "Edit", "MultiEdit", "NotebookEdit", "Glob", "Grep", "LS", "TodoWrite"]

// Prefix-matched by Claude Code: `Bash(git commit:*)` covers any git commit
// invocation and nothing else.
const GIT_TOOLS = GIT_VERBS.map((verb) => `Bash(git ${verb}:*)`)
const FORBIDDEN_TOOLS = FORBIDDEN_GIT.map((command) => `Bash(${command}:*)`)

function allowedToolsFor(job) {
  const tools = []
  if (job.workdir) tools.push(...FILE_TOOLS, ...GIT_TOOLS)
  if (job.github?.token) tools.push(`mcp__${GITHUB_MCP_SERVER}`)
  return tools
}

// Inline JSON rather than a temp file — Claude Code is the one runtime of the
// three that takes MCP configuration as an argument, and an argument leaves
// nothing behind.
function mcpConfigFor() {
  return JSON.stringify({ mcpServers: githubMcpServers() })
}

// Exported so the argument list a repository turn actually runs with can be
// asserted, rather than trusted. What is allowed here is a security decision;
// it should not be reachable only through a spawned process.
export function baseArgs(job) {
  const args = []
  if (job.model) args.push(...CLI.model(job.model))
  if (job.system) args.push(...CLI.appendSystem(job.system))
  // Only when the job is anchored to a repository. A plain chat completion
  // gets no working directory and no elevated permission mode, so nothing
  // about this widens the ordinary path.
  if (job.workdir) args.push(...CLI.permissionMode("acceptEdits"))

  // The GitHub tools are offered whenever the server sent credentials for
  // them, with or without a checkout: a session with no working tree still
  // can't push code, but it can open, edit, comment on and merge pull
  // requests, and being unable to do that was the original complaint.
  if (job.github?.token) args.push(...CLI.mcpConfig(mcpConfigFor()))

  const allowed = allowedToolsFor(job)
  if (allowed.length > 0) {
    args.push(...CLI.allowedTools(allowed))
    args.push(...CLI.disallowedTools(FORBIDDEN_TOOLS))
  }

  return args
}

export function streamingArgs(job) {
  return [CLI.print, ...CLI.streamFormat, ...baseArgs(job)]
}

export function bufferedArgs(job) {
  return [CLI.print, ...CLI.outputFormat, ...baseArgs(job)]
}

// One short human line per event, for the "Reading foo.rb" ticker the web app
// shows while a run is in flight. Mirrors Code::Agent#humanize_step on the
// server so both paths read the same to a user.
function describeEvent(event) {
  if (!event || typeof event !== "object") return null

  if (event.type === "system" && event.subtype === "init") return "Starting up"

  if (event.type === "assistant") {
    const blocks = event.message?.content
    if (!Array.isArray(blocks)) return null
    for (const block of blocks) {
      if (block?.type !== "tool_use") continue
      const input = block.input || {}
      const file = shortPath(input.file_path || input.notebook_path || input.path)

      switch (block.name) {
        case "Read":         return file ? `Reading ${file}` : "Reading a file"
        case "Edit":
        case "MultiEdit":    return file ? `Editing ${file}` : "Editing a file"
        case "Write":        return file ? `Writing ${file}` : "Writing a file"
        case "NotebookEdit": return file ? `Editing ${file}` : "Editing a notebook"
        case "Bash": {
          // Claude Code's Bash tool carries a human `description` alongside
          // the command. When it is there it beats anything we could derive
          // AND it is already a sentence — "Run the test suite" — so it is
          // used verbatim rather than prefixed with "Running".
          const described = String(input.description || "").trim().slice(0, 60)
          if (described) return described
          const cmd = shortCommand(input.command)
          return cmd ? `Running ${cmd}` : "Running a command"
        }
        case "BashOutput":   return "Checking a running command"
        case "Grep": {
          const pattern = String(input.pattern || "").trim().slice(0, 40)
          return pattern ? `Searching for ${pattern}` : "Searching the code"
        }
        case "Glob": {
          const pattern = String(input.pattern || "").trim().slice(0, 40)
          return pattern ? `Looking for ${pattern}` : "Looking for files"
        }
        case "WebFetch":
        case "WebSearch": {
          let host = ""
          try { host = new URL(String(input.url || "")).host } catch { host = "" }
          return host ? `Reading ${host}` : "Searching the web"
        }
        // Planning and bookkeeping tools. Their arguments are internal state
        // and mean nothing to someone watching, so they get a verb and no noun.
        case "TodoWrite":
        case "TaskCreate":
        case "TaskUpdate":   return "Updating the plan"
        case "Task":         return "Delegating a subtask"
        case "ToolSearch":   return "Looking up a tool"
        case "ExitPlanMode": return "Finishing the plan"
        default: {
          // MCP tools arrive as mcp__server__tool; the middle part is the
          // only half worth showing.
          const name = String(block.name || "")
          const pretty = name.startsWith("mcp__")
            ? name.split("__").slice(1).join(" ").replace(/_/g, " ")
            : name.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase()
          return pretty ? `${pretty.charAt(0).toUpperCase()}${pretty.slice(1)}`.slice(0, 60) : "Working"
        }
      }
    }
    return "Thinking"
  }

  return null
}

// Fold the NDJSON stream into the shape every caller expects, so no caller can
// tell which runtime — or which transport — produced an answer.
function collapseEvents(events) {
  const out = {
    content: "", usage: emptyUsage(), model: null,
    stopReason: null, isError: false, errorStatus: null
  }

  let sawResult = false
  const assistantText = []

  for (const event of events) {
    if (event?.type === "assistant" && Array.isArray(event.message?.content)) {
      for (const block of event.message.content) {
        if (block?.type === "text" && block.text) assistantText.push(block.text)
      }
      if (event.message.model) out.model = event.message.model
    }

    if (event?.type === "result") {
      sawResult = true
      if (typeof event.result === "string") out.content = event.result
      out.stopReason = event.stop_reason || event.subtype || null
      // Claude Code reports in-band failures (API errors, refusals) with
      // `is_error: true` and a **zero exit code**. Trusting the exit code alone
      // would hand the user an error string rendered as the assistant's reply.
      out.isError = event.is_error === true
      out.errorStatus = event.api_error_status || null
      out.usage = normalizeUsage(event.usage)
      // There's no top-level `model` field — the model that actually ran is
      // the key of `modelUsage`.
      out.model = firstKey(event.modelUsage) || out.model
    }
  }

  // No terminal `result` event — the process died mid-stream. Whatever the
  // assistant had already said is still worth returning; it beats an empty
  // reply, and the caller decides whether a partial answer is acceptable.
  if (!out.content) out.content = assistantText.join("")
  return { ...out, sawResult }
}

// Token-level deltas from --include-partial-messages. Only top-level
// text_deltas are the answer: thinking_delta is private scratchwork,
// input_json_delta is tool arguments, and anything carrying a
// parent_tool_use_id belongs to a subagent's side conversation.
function partialTextFrom(event) {
  if (event?.type !== "stream_event" || event.parent_tool_use_id) return null
  const delta = event.event?.delta
  if (delta?.type !== "text_delta" || typeof delta.text !== "string") return null
  return delta.text
}

// Parse Claude Code's `--output-format json` envelope, for the buffered
// fallback. Read defensively — this is another product's output format, and a
// version bump that renames a field should degrade to "we got the text but not
// the token counts" rather than to an empty answer.
function parseBuffered(stdout) {
  const empty = { content: "", usage: emptyUsage(), model: null, stopReason: null, isError: false }
  const trimmed = String(stdout || "").trim()
  if (!trimmed) return empty

  let parsed
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    // Not JSON at all — almost certainly plain text from an older build. The
    // answer is still the answer; we just don't get usage from it.
    return { ...empty, content: trimmed }
  }

  const content =
    parsed.result ??
    parsed.text ??
    parsed.content ??
    (Array.isArray(parsed.messages) ? parsed.messages.at(-1)?.content : null) ??
    ""

  return {
    content: typeof content === "string" ? content : JSON.stringify(content),
    usage: normalizeUsage(parsed.usage || parsed.message?.usage),
    model: firstKey(parsed.modelUsage) || parsed.model || parsed.message?.model || null,
    stopReason: parsed.stop_reason || parsed.subtype || null,
    isError: parsed.is_error === true,
    errorStatus: parsed.api_error_status || null
  }
}

export const claudeCode = {
  id: "claude_code",
  name: "Claude Code",
  cli: "claude",
  install: "https://claude.com/product/claude-code",
  binEnvVar: "CMA_CLAUDE_BIN",
  // ~/.claude/local is Claude Code's own older install location and is not a
  // generic bin directory, so it has to be named.
  extraHomePaths: [".claude/local/claude"],

  // Claude Code reads its login from CLAUDE_CONFIG_DIR, so a directory per
  // profile is what keeps a work account and a personal account apart.
  //
  // Caveat worth knowing: on macOS, Claude Code stores credentials in the
  // system Keychain, and whether a per-profile config directory fully isolates
  // them depends on the Claude Code version. `cma-agent runtimes:scan` reports
  // the account each profile actually resolves to so you can see at a glance
  // whether two profiles have collapsed into the same login — rather than
  // finding out when the wrong account gets billed.
  configDirEnvVar: "CLAUDE_CONFIG_DIR",
  profilesDirName: "claude-profiles",

  versionArgs: ["--version"],
  loginArgs: () => ["/login"],
  loginHint: "cma-agent runtimes:login --runtime claude_code",
  // The cheapest possible real request: if it answers at all, the login works.
  probeArgs: () => [CLI.print, "Reply with the single word: ok", ...CLI.outputFormat],

  // Headless Claude Code takes a single prompt rather than a message array, so
  // prior turns are rendered inline by the engine, and the prompt is fed on
  // stdin — see the note above CLI.allowedTools for why it is never an
  // argument.
  promptOnStdin: true,
  supportsBuffered: true,

  streamingArgs,
  bufferedArgs,
  envFor: (job) => envForGithub(job),
  describeEvent,
  collapseEvents,
  partialTextFrom,
  parseBuffered,
  classifyFailure: (detail) =>
    classifyFailure(detail, { name: "Claude", loginHint: "cma-agent runtimes:login --runtime claude_code" }),

  resolveBin() {
    return locateBin({ cli: this.cli, envVar: this.binEnvVar, extraHomePaths: this.extraHomePaths })
  },

  advice() {
    const { bin, source } = this.resolveBin()
    return locationAdvice({ name: this.name, install: this.install, bin, source })
  }
}
