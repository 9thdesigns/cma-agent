import fs from "node:fs"
import path from "node:path"

import {
  builtinPlatformTools, builtinWebTools, classifyFailure, emptyUsage, envForGithub, envForWeb,
  FORBIDDEN_GIT, GIT_VERBS, lastTurnOccupancy, locateBin, locationAdvice, loginCommand,
  mcpServersFor, normalizeUsage, shortCommand, shortPath
} from "./shared.js"

// ---------------------------------------------------------------------------
// xAI's Grok Build (`grok`), in headless mode — the runtime a SuperGrok or
// X Premium+ subscription pays for.
//
// The flag surface below is xAI's own published headless contract
// (docs/user-guide/14-headless-mode.md and 22-permissions-and-safety.md in
// xai-org/grok-build), which is the strongest source any adapter here has had
// apart from Claude Code's installed binary:
//
//   grok -p "<prompt>" --output-format streaming-json \
//        --model <id> --yolo --sandbox <profile> \
//        --allow '<rule>' --deny '<rule>' --disallowed-tools <names>
//
//   -p, --single <PROMPT>   headless: one prompt, then exit
//   --output-format         plain | json | streaming-json | streaming-messages-json
//   -m, --model <MODEL>     model override
//   --yolo                  auto-approve tool calls
//   --sandbox <profile>     off | workspace | read-only | strict | devbox
//   --allow / --deny        permission rules, glob-matched: Bash(git push*)
//   --tools / --disallowed-tools   allow- and deny-lists of tool NAMES
//   --max-turns <N>         cap the agentic loop
//   GROK_HOME               config directory (default ~/.grok)
//
// ── Why this one gets the real allowance ───────────────────────────────────
//
// Codex and CodeWhale both have to state the same limitation: the
// forbidden-git deny list has no flag to ride, so a repository turn is bounded
// by a sandbox and a paragraph of system prompt. Grok is the first CLI since
// Claude Code that takes the allowance AS FLAGS, and xAI documents the two
// properties that make them worth trusting:
//
//   * "any matching `deny` rejects the call. `deny` wins over every other
//     rule" — so `--yolo` cannot re-open what we closed;
//   * a project's own `.grok/config.toml` "cannot widen" permissions — so a
//     repository the user shares with us cannot vote itself a shell.
//
// That second one is exactly the hole the Cursor adapter had to work around by
// keeping its permissions file somewhere the repo could not reach.
//
// The rules are NOT registered as capability flags, and that is deliberate: if
// a build ever rejects `--deny`, the right outcome is a failed run, not a
// degraded one that keeps `--yolo` and loses its boundary.
//
// ── MCP and config ─────────────────────────────────────────────────────────
//
// Grok discovers MCP servers from `config.toml` in GROK_HOME, with no inline
// flag — the same shape as codex, and the same consequence: the file must live
// in a directory WE own, so this adapter has no ambient mode. Every Grok login
// is a managed profile signed in once with
// `cma-agent runtimes:login --runtime grok`, and nothing is ever written into
// the `~/.grok` the user's own terminal reads.
//
// The file carries no secret. It names a command; the GitHub and web tokens
// travel by environment, exactly as they do for every other runtime.
//
// ── Stated caveat ──────────────────────────────────────────────────────────
//
// The prompt rides `-p` as an argv value, because that is the shape xAI
// documents; `--prompt-file` exists but its argument is not specified in the
// docs and the engine has no hook to write one before the argv is built. Two
// consequences worth knowing rather than discovering: a very long conversation
// is bounded by ARG_MAX, and the prompt is visible in `ps` on that machine for
// the life of the run. Both are the machine's owner's own process table, which
// is why this is a caveat and not a blocker — but it is why the system text is
// folded into the prompt rather than passed as `--rules`, which would put the
// operator's instructions there too.
// ---------------------------------------------------------------------------

const CLI = {
  prompt: (text) => ["-p", text],
  streamFormat: ["--output-format", "streaming-json"],
  model: (id) => ["--model", id],
  sandbox: (profile) => ["--sandbox", profile],
  yolo: "--yolo",
  noAutoUpdate: "--no-auto-update",
  allow: (rule) => ["--allow", rule],
  deny: (rule) => ["--deny", rule],
  disallowedTools: (names) => ["--disallowed-tools", names.join(",")]
}

// Grok's rule patterns are globs, not Claude Code's `verb:*` — `Bash(git
// commit*)` covers any git commit invocation. The prefixes are documented:
// Bash, Edit, Write, Read, Grep, WebFetch, MCPTool.
const FILE_RULES = ["Read(**)", "Grep(**)", "Edit(**)", "Write(**)"]
const GIT_RULES = GIT_VERBS.map((verb) => `Bash(git ${verb}*)`)

// Denied on every job, with or without a checkout. The git commands that
// destroy work, then the runtime's own web and platform built-ins — Configure
// My AI owns scheduling, sub-agents and the web channel on every provider
// alike (shared.js), and a built-in that needs a permission prompt can never
// succeed in a run with nobody to answer it.
export const DENIED_RULES = FORBIDDEN_GIT.map((command) => `Bash(${command}*)`)
export const DENIED_TOOLS = [...builtinWebTools("grok"), ...builtinPlatformTools("grok")]

// Exported so the allowance a repository turn actually runs with can be
// asserted rather than trusted. What a run may do is a security decision and
// must stay reachable without spawning anything.
export function permissionArgs(job) {
  const args = []

  if (job.workdir) {
    for (const rule of [...FILE_RULES, ...GIT_RULES]) args.push(...CLI.allow(rule))
  }
  // The MCP channels are pre-approved by server, the way they are everywhere
  // else: a headless run cannot be handed a tool it must ask permission for.
  if (job.github?.token) args.push(...CLI.allow("MCPTool(cma_github*)"))
  if (job.web?.token) args.push(...CLI.allow("MCPTool(cma_web*)"))

  for (const rule of DENIED_RULES) args.push(...CLI.deny(rule))
  if (DENIED_TOOLS.length > 0) args.push(...CLI.disallowedTools(DENIED_TOOLS))

  return args
}

export function baseArgs(job) {
  const args = [...CLI.streamFormat, CLI.noAutoUpdate]
  if (job.model) args.push(...CLI.model(job.model))

  if (job.workdir) {
    // Edits and commands without stopping to ask, confined to the working tree
    // by the sandbox and bounded by the deny rules below. `--yolo` alone would
    // be the `--force` mistake the Cursor adapter documents; with a deny list
    // that outranks it, it is the headless equivalent of acceptEdits.
    //
    // `workspace` rather than `strict`: a repository turn runs the project's
    // own tests and its git remote, and strict blocks child network.
    args.push(...CLI.sandbox("workspace"), CLI.yolo)
  } else {
    // A chat completion writes nothing and reaches nothing.
    args.push(...CLI.sandbox("read-only"), CLI.yolo)
  }

  args.push(...permissionArgs(job))
  return args
}

// The prompt goes LAST, so no earlier flag — including one the engine drops on
// a degraded retry — can swallow it. `-p` itself starts with a dash, which is
// what stops the drop loop before it reaches the text.
export function streamingArgs(job, prompt = "") {
  return [...baseArgs(job), ...CLI.prompt(prompt)]
}

// System text is folded into the prompt, visibly fenced, rather than passed as
// `--rules`: see the caveat in the header. Same shape the Codex and Cursor
// adapters use, and for the same reason — never silently glued to the user's
// words.
export function renderPrompt(job, conversation) {
  if (!job.system) return conversation
  return `<system>\n${job.system}\n</system>\n\n${conversation}`
}

// ---------------------------------------------------------------------------
// config.toml — MCP servers, and the two features we turn off at the source.
//
// `subagents.enabled` and `disable_web_search` are documented config keys, and
// setting them here is stronger than naming tools in a deny list: a tool that
// is never registered cannot be reached, asked for, or described in the schema
// the model is handed. The deny list stays as well, because the two answer
// different questions — one is "this build's own feature is off", the other is
// "this call is refused".
//
// Bare keys precede every table header, which TOML requires.
// ---------------------------------------------------------------------------

function tomlString(value) {
  return JSON.stringify(String(value))
}

export function configTomlFor(job) {
  const lines = [
    "# Written by cma-agent before every run. Do not edit — changes are",
    "# overwritten. Login state (auth.json) is grok's own and is not touched.",
    "",
    "# The bot's own web tools are the web channel; grok's built-in search is",
    "# a second, unlogged one.",
    "disable_web_search = true",
    "",
    "[cli]",
    "auto_update = false",
    "",
    "# Sub-agents are Configure My AI's to schedule and account for. A run that",
    "# spawned its own would do the work somewhere the operator cannot see it.",
    "[subagents]",
    "enabled = false"
  ]

  for (const [name, server] of Object.entries(mcpServersFor(job))) {
    lines.push("", `[mcp_servers.${name}]`)
    lines.push(`command = ${tomlString(server.command)}`)
    lines.push(`args = [${server.args.map(tomlString).join(", ")}]`)
  }

  return `${lines.join("\n")}\n`
}

// Rewritten before every spawn, never merged: the file is ours alone, and a
// stale server entry from a job that had a grant this one lacks would offer
// tools that can only fail.
export function writeConfig(job, configDir) {
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(configDir, "config.toml"), configTomlFor(job), { mode: 0o600 })
}

// ---------------------------------------------------------------------------
// Which xAI account a login resolves to.
//
// Grok keeps its credential in auth.json inside GROK_HOME — either the browser
// session's tokens or a raw API key. Read for the same reason the Claude Code
// and Codex adapters read theirs: to answer "which account pays for this", and
// to tell a subscription apart from per-token API billing, which is exactly
// the mix-up the multi-login feature exists to prevent.
// ---------------------------------------------------------------------------

export function accountFromAuth(parsed) {
  if (!parsed || typeof parsed !== "object") return null

  const email = String(parsed.email || parsed.account?.email || parsed.user?.email || "").trim()
  if (email) return { email, source: "oauth" }

  if (parsed.XAI_API_KEY || parsed.api_key) return { email: null, source: "api_key" }
  if (parsed.tokens || parsed.access_token) return { email: null, source: "oauth" }

  return null
}

export function readAccount({ configDir = null } = {}) {
  if (!configDir) return null

  try {
    return accountFromAuth(JSON.parse(fs.readFileSync(path.join(configDir, "auth.json"), "utf8")))
  } catch {
    // Missing, unreadable or not JSON — no account to name, which is not an
    // error: a profile that has never been signed into looks exactly like this.
    return null
  }
}

export function describeAccount(account) {
  if (!account) return null
  if (account.source === "api_key") return "account: an xAI API key"
  return account.email ? `account: ${account.email}` : "account: an xAI login"
}

// ---------------------------------------------------------------------------
// The event stream.
//
// `--output-format streaming-json` is NDJSON with one type-tagged event per
// line. xAI documents the vocabulary — text, thought, tool_call,
// tool_call_update, usage, plan, available_commands, end, error — and says the
// list is non-exhaustive, so this switches on `type` and ignores what it does
// not know.
//
// The per-event FIELD names are not published, so every read below tries the
// spellings the vocabulary implies and falls back rather than throwing. That
// is the same posture the Cursor adapter shipped with, and the same
// instruction applies: run one real job with `--output-format streaming-json`
// and reconcile before trusting the usage numbers.
// ---------------------------------------------------------------------------

function textOf(event) {
  if (event?.type !== "text") return null
  const value = event.text ?? event.content ?? event.delta
  return typeof value === "string" && value ? value : null
}

function toolNameOf(event) {
  return String(event?.name || event?.tool || event?.tool_name || event?.tool_call?.name || "")
}

function toolArgsOf(event) {
  return event?.args || event?.input || event?.arguments || event?.tool_call?.args || {}
}

function describeEvent(event) {
  if (!event || typeof event !== "object") return null

  if (event.type === "thought") return "Thinking"
  if (event.type === "plan") return "Planning"
  if (event.type !== "tool_call") return null

  const args = toolArgsOf(event)
  const file = shortPath(args.path || args.file_path || args.target_file)

  switch (toolNameOf(event)) {
    case "read_file":        return file ? `Reading ${file}` : "Reading a file"
    case "write_file":
    case "create_file":      return file ? `Writing ${file}` : "Writing a file"
    case "edit_file":
    case "search_replace":   return file ? `Editing ${file}` : "Editing a file"
    case "list_dir":         return "Listing files"
    case "grep":
    case "codebase_search":  return "Searching the code"
    case "run_terminal_cmd": {
      const cmd = shortCommand(args.command)
      return cmd ? `Running ${cmd}` : "Running a command"
    }
    case "todo_write":       return "Updating the plan"
    default: {
      const pretty = toolNameOf(event).replace(/_/g, " ").trim()
      return pretty ? `${pretty.charAt(0).toUpperCase()}${pretty.slice(1)}`.slice(0, 60) : "Working"
    }
  }
}

function partialTextFrom(event) {
  return textOf(event)
}

// Which file this event wrote, for the documents channel. A shape we do not
// recognise reports nothing and the run is unaffected — `collectDocuments`
// also finds files by mtime, so a missed event costs nothing.
function writtenPathFrom(event) {
  if (event?.type !== "tool_call") return null
  if (!["write_file", "create_file", "edit_file", "search_replace"].includes(toolNameOf(event))) return null

  const args = toolArgsOf(event)
  const file = args.path || args.file_path || args.target_file
  return typeof file === "string" && file.trim() ? file.trim() : null
}

function collapseEvents(events) {
  const out = {
    content: "", usage: emptyUsage(), model: null,
    stopReason: null, isError: false, errorStatus: null
  }

  let sawResult = false
  let contextTokens = 0
  const text = []

  for (const event of events) {
    const chunk = textOf(event)
    if (chunk) text.push(chunk)

    if (event?.type === "usage") {
      out.usage = normalizeUsage(event.usage || event)
      contextTokens = lastTurnOccupancy(event) || contextTokens
    }

    if (event?.type === "error") {
      out.isError = true
      out.errorStatus = String(event.message || event.error || "").slice(0, 300) || out.errorStatus
    }

    if (event?.type === "end") {
      sawResult = true
      out.stopReason = event.stop_reason || event.stopReason || event.status || "end"
      if (event.model) out.model = event.model
      // `end` is documented as always last and as carrying the run's spend, so
      // it wins over an earlier `usage` event rather than adding to it.
      if (event.usage) out.usage = normalizeUsage(event.usage)
      contextTokens = lastTurnOccupancy(event) || contextTokens
      // A terminal event that repeats the whole answer is the source of truth
      // for it; the streamed chunks were the preview.
      const final = event.text ?? event.result
      if (typeof final === "string" && final) {
        text.length = 0
        text.push(final)
      }
    }
  }

  out.usage.context_tokens = contextTokens
  out.content = text.join("")
  return { ...out, sawResult }
}

export const grok = {
  id: "grok",
  name: "Grok Build",
  cli: "grok",
  install: "https://docs.x.ai/build/cli",
  binEnvVar: "CMA_GROK_BIN",
  // xAI's installer drops the binary in ~/.grok/bin; npm globals the generic
  // sweep already finds.
  extraHomePaths: [".grok/bin/grok"],

  // GROK_HOME is where grok keeps BOTH its login (auth.json) and the
  // config.toml this adapter writes. Because that file has to live in a
  // directory we own, there is no ambient mode — see the header.
  configDirEnvVar: "GROK_HOME",
  profilesDirName: "grok-profiles",
  ambientProfile: false,

  readAccount,
  describeAccount,

  versionArgs: ["--version"],
  loginArgs: () => ["login"],
  loginHint: loginCommand("grok"),
  probeArgs: () => [
    ...CLI.streamFormat, CLI.noAutoUpdate, ...CLI.sandbox("read-only"),
    ...CLI.prompt("Reply with the single word: ok")
  ],

  // The prompt is an argv value — see the caveat in the header.
  promptOnStdin: false,
  // `--output-format json` would work as a fallback, but its terminal object
  // is the same information the stream's `end` event already carries, so there
  // is nothing a buffered retry would recover.
  supportsBuffered: false,

  streamingArgs,
  renderPrompt,

  // Writes config.toml (MCP servers, and the built-ins we turn off) into
  // GROK_HOME before every spawn.
  prepare(job, { configDir }) {
    writeConfig(job, configDir)
  },

  envFor: (job) => ({ ...envForGithub(job), ...envForWeb(job) }),

  describeEvent,
  collapseEvents,
  partialTextFrom,
  writtenPathFrom,

  limitations: [
    "The prompt travels as a command-line argument, so a very long conversation " +
      "is bounded by the machine's ARG_MAX and the prompt is visible in `ps` while the run lasts.",
    "Token accounting comes from an event whose field names xAI has not published — " +
      "the usage figures are best-effort until they are reconciled against a real build."
  ],

  classifyFailure: (detail, context = {}) =>
    classifyFailure(detail, { name: "Grok Build", loginHint: loginCommand("grok", context.profileSlug) }),

  resolveBin() {
    return locateBin({ cli: this.cli, envVar: this.binEnvVar, extraHomePaths: this.extraHomePaths })
  },

  advice() {
    const { bin, source } = this.resolveBin()
    return locationAdvice({ name: this.name, install: this.install, bin, source })
  }
}
