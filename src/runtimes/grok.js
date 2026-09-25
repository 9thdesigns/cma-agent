import fs from "node:fs"
import path from "node:path"

import {
  builtinPlatformTools, builtinWebTools, classifyFailure, emptyUsage, envForGithub, envForWeb,
  FORBIDDEN_GIT, GIT_VERBS, locateBin, locationAdvice, loginCommand,
  mcpServersFor, normalizeUsage, occupancyOf, shortCommand, shortPath
} from "./shared.js"

// ---------------------------------------------------------------------------
// xAI's Grok Build (`grok`), in headless mode — the runtime a SuperGrok or
// X Premium+ subscription pays for.
//
// The flag surface below is xAI's own published headless contract — the user
// guide that ships with the CLI's source (xai-org/grok-build,
// crates/codegen/xai-grok-pager/docs/user-guide/14-headless-mode.md and
// 22-permissions-and-safety.md) and the clap definitions in
// src/app/cli.rs of the same tree (read at pager-bin 1.0.24):
//
//   grok -p "<prompt>" --output-format streaming-json \
//        --model <id> [--effort <level>] [--resume <uuid>] \
//        --yolo --sandbox <profile> \
//        --allow '<rule>' --deny '<rule>' --disallowed-tools <names>
//
//   -p, --single <PROMPT>   headless: one prompt, then exit
//   --output-format         plain | json | streaming-json | streaming-messages-json
//   -m, --model <MODEL>     model override
//   --effort <LEVEL>        alias of --reasoning-effort; see effortArg
//   -r, --resume <ID>       continue a session this GROK_HOME + cwd holds
//   --yolo                  auto-approve tool calls (alias of --always-approve)
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
  effort: (level) => ["--effort", level],
  // Only ever a session uuid — see resumePlan for what is kept off it.
  resume: (id) => ["--resume", id],
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
  args.push(...effortArg(job))

  const plan = resumePlan(job)
  if (plan) args.push(...CLI.resume(plan.sessionId))

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

// ---------------------------------------------------------------------------
// The effort dial.
//
// Ai::Effort's scale is low / medium / high / xhigh / max. Grok takes
// `--effort <level>` (alias of `--reasoning-effort`) with the canonical levels
// none / minimal / low / medium / high / xhigh / max — but a level the active
// model's menu does not offer is a HARD failure of the run, not a warning
// (headless.rs apply_headless_model_and_effort → EffortTokenError::UnknownToken
// → bail), and the CLI's built-in menu, used whenever the server sends no
// per-model list, is xhigh / high / medium / low (slash/commands/effort_levels.rs).
// `max` therefore travels as `xhigh` — the same rule Ai::Effort applies to
// xAI's API, where xhigh is the top of the vocabulary. A model that does not
// support effort at all ignores the flag with a stderr warning, so the flag is
// safe to send on every model; a menu that lacks even these four is the one
// case left, and fallbackJob retries that run once without the dial.
// ---------------------------------------------------------------------------

export const EFFORT_LEVELS = Object.freeze({
  low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "xhigh"
})

export function effortArg(job) {
  const level = EFFORT_LEVELS[String(job?.effort || "").trim().toLowerCase()]
  return level ? CLI.effort(level) : []
}

// ---------------------------------------------------------------------------
// Session continuity.
//
// `--resume <id>` continues the transcript a previous turn left under this
// profile's GROK_HOME (sessions/<url-encoded cwd>/<id>/ — same home, same
// working directory, which the server's continuity record already keys on).
// The history then costs a cache READ instead of being re-sent and re-read as
// a fresh prompt, and the model sees its real tool calls rather than a text
// rendering of them. The rules are the contract owner's (claude-code.js
// resumePlan), applied unchanged:
//
//   * the server decides WHETHER to offer an id — only when the system text
//     is byte-identical to the one the session was recorded with;
//   * the id must be a UUID: it goes into argv, and Grok resolves any
//     non-UUID value as a session TITLE for the current directory;
//   * the history must be an append-only continuation — at least one
//     assistant turn the transcript already holds, then only user turns.
//     Anything else is sent the old way, in full;
//   * a session that is gone makes `--resume` error before anything is
//     spent, and fallbackJob retries the turn with the full history.
// ---------------------------------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// { sessionId, tail } when this job may resume, null when it must not.
export function resumePlan(job) {
  const sessionId = String(job?.runtime_session_id || "").trim()
  if (!UUID.test(sessionId)) return null

  const messages = Array.isArray(job.messages) ? job.messages : []
  let lastAssistant = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "assistant") { lastAssistant = i; break }
  }
  if (lastAssistant < 0) return null

  const tail = messages.slice(lastAssistant + 1)
  if (tail.length === 0 || tail.some((m) => m?.role !== "user")) return null
  return { sessionId, tail }
}

// System text is folded into the prompt, visibly fenced, rather than passed as
// `--rules`: see the caveat in the header. Same shape the Codex and Cursor
// adapters use, and for the same reason — never silently glued to the user's
// words. A resumed turn is fed only the new user turn(s): the transcript
// already holds every earlier message (system text included), and the
// engine's rendering of the whole history on top of it would be the history
// twice.
export function renderPrompt(job, conversation) {
  const plan = resumePlan(job)
  if (plan) {
    return plan.tail
      .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
      .join("\n\n")
  }
  if (!job.system) return conversation
  return `<system>\n${job.system}\n</system>\n\n${conversation}`
}

// One more attempt with less, or null. The engine calls this when a run
// exits non-zero; both cases here fail BEFORE anything is spent, so the retry
// is the ordinary turn the user would otherwise have got:
//
//   * the CLI rejected the effort level — its message is literally prefixed
//     `--effort/--reasoning-effort:` (headless.rs) — so the same job without
//     the dial is retried;
//   * a planned resume died — no `usage`, `end`, text or tool call ever came
//     — so the same job with the full history is retried.
//
// A run that produced any of those events was a real run with a real
// failure, and an argv rejection is the engine's own degrade path.
const EFFORT_REJECTED = /--effort\/--reasoning-effort:/
const SPENT_EVENTS = new Set(["usage", "end", "text", "tool_call"])

function spent(event) {
  if (SPENT_EVENTS.has(event?.type)) return true
  // An error line that carries the run's spend fields is a run that spent.
  return event?.type === "error" && Boolean(event.usage)
}

export function fallbackJob(job, result = {}) {
  const events = Array.isArray(result.events) ? result.events : []
  if (events.some(spent)) return null

  const stderr = String(result.stderr || "")
  if (/unknown option|unrecognized option|unknown argument/i.test(stderr)) return null

  const said = [stderr, ...events.filter((e) => e?.type === "error").map((e) => String(e.message || ""))].join("\n")
  if (effortArg(job).length > 0 && EFFORT_REJECTED.test(said)) return { ...job, effort: null }
  if (resumePlan(job)) return { ...job, runtime_session_id: null }
  return null
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
// `--output-format streaming-json` is NDJSON with one type-tagged object per
// line, projected from the agent's ACP session updates. The shapes below are
// the serde structs in crates/codegen/xai-grok-pager/src/headless/reducer/acp.rs
// (pager-bin 1.0.24) and the projector in
// crates/codegen/xai-grok-shell/src/extensions/notification.rs, not an
// inference from the vocabulary:
//
//   {"type":"text","data":"…"}                      a chunk of the answer
//   {"type":"thought","data":"…"}
//   {"type":"tool_call","toolCallId":…,"title":"Read","kind":"read",
//        "status":"in_progress","toolName":"read_file","rawInput":{…},
//        "content":[],"locations":[{"path":…}]}
//   {"type":"tool_call_update","toolCallId":…,"status":…,"rawOutput":…}
//   {"type":"usage","messageId":…,"stopReason":"tool_use",
//        "usage":{"input_tokens":812,"output_tokens":45,
//                 "cache_read_input_tokens":0,"cache_creation_input_tokens":0,
//                 "reasoning_tokens":0},"signature":…}      ONE PER MODEL RESPONSE
//   {"type":"end","stopReason":"end_turn","sessionId":…,"requestId":…,
//        "usage":{…same five + total_tokens…},"num_turns":7,
//        "modelUsage":{"grok-4.6":{"inputTokens":…,"outputTokens":…,
//             "cacheReadInputTokens":…,"cacheCreationInputTokens":…,
//             "modelCalls":7,"costUSD":…}},
//        "total_cost_usd":…,"total_cost_usd_ticks":…,
//        "usage_is_incomplete":true,"cost_is_partial":true}   ALWAYS LAST
//   {"type":"error","message":"…"}  (+ the same spend fields when any)
//   plus plan, available_commands, max_turns_reached, auto_compact_*,
//   auto_continue_completed, image_compressed, memory_flush_*; the list is
//   declared non-exhaustive, so this switches on `type` and ignores the rest.
//
// The token conventions are the canonical additive ones, in Anthropic's
// spelling: `input_tokens` is the UNCACHED prompt share ("full − cache_read −
// cache_creation"), the two cache buckets sit beside it, and
// `reasoning_tokens` is INSIDE `output_tokens` — the documented identity is
// total_tokens = input + cache_read + cache_creation + output, and the doc's
// own example (7,210 + 41,000 + 0 + 1,893 = 50,103 with 412 reasoning) leaves
// it no room outside. That is the opposite of xAI's chat/completions API,
// where reasoning sits outside completion_tokens, and it is why nothing here
// folds or subtracts: the numbers go to normalizeUsage as they are.
//
// Per call versus the run: each `usage` line is one model response, and
// `end.usage` is the run's aggregate ledger (main agent plus the sub-agents
// that finished before the turn ended; compaction and other side-model calls
// excluded). The run total is `end.usage` — or `error`'s copy of it — and the
// per-response lines are summed only as the fallback for a run that never got
// there. Never both: adding the lines to the aggregate would be the
// double count this effort exists to remove. The LAST `usage` line is the
// last prompt, which is exactly the context-meter reading (input + both cache
// buckets, since input is uncached).
//
// Not on this format: a context window (only the streaming-messages-json
// reducer carries `modelUsage[current].contextWindow`) and a model id other
// than the `modelUsage` keys. Both are sent only when a build puts them on
// the wire; absent means unknown, never 0.
// ---------------------------------------------------------------------------

// ── Reading a line whose payload moved ──────────────────────────────────────
//
// Everything above describes a FLAT projection: the discriminator and the
// payload share one object, so `{"type":"text","data":"…"}` carries the answer
// in `data` and a `tool_call` carries `toolName` beside its own `type`. That is
// what pager-bin 1.0.24 wrote and what the tests below pin.
//
// It is not the only thing a build can write, and the failure when it changes
// is silent in the worst way. A projector that keeps the tag and nests the ACP
// payload one level down — `data` holding the ContentBlock object
// `{"type":"text","text":"…"}` rather than a bare string, or a `toolCall`
// member holding the call — parses, line for line, as a run that thought,
// worked, planned and then SAID NOTHING: `data` is no longer a string so no
// answer is ever collected, and `toolName`/`kind`/`title` are no longer where
// they were looked for, so every tool call describes itself as the bare word
// "Working". A whole turn is spent and the person is told "Grok Build finished
// without producing an answer", which is true and explains nothing.
//
// So a field is read from the event, then from a nested payload, then one
// hop further (`data.toolCall`, `params.update`). The flat shape is unchanged
// (the first lookup finds everything). A nested one now reads. Neither
// invents a value the line did not carry.
const NESTED_KEYS = ["data", "toolCall", "tool_call", "update", "payload", "params", "content", "result", "event"]
// ACP ContentBlock `type` values. A nested object with one of these is the
// payload, not a second event envelope — walking `type` on it would turn a
// thought's `{type:"text",text:"…"}` into a `text` event and collect
// reasoning as the answer.
const CONTENT_BLOCK_TYPES = new Set(["text", "image", "audio", "resource", "resource_link"])

function nestedOf(event) {
  for (const key of NESTED_KEYS) {
    const value = event?.[key]
    if (value && typeof value === "object" && !Array.isArray(value)) return value
  }
  return null
}

// The objects a field might live on: the event, its nested payload, and one
// more hop. 0.22.0 stopped at a single nest; a projector that wraps the ACP
// object twice (`data: { toolCall: { toolName } }` or `params: { update }`)
// still produced "Working" and an empty answer. Bounded, never a walk of the
// whole line.
function sourcesOf(event) {
  const out = []
  const seen = new Set()
  const push = (obj) => {
    if (!obj || typeof obj !== "object" || Array.isArray(obj) || seen.has(obj)) return
    seen.add(obj)
    out.push(obj)
  }
  push(event)
  const nested = nestedOf(event)
  push(nested)
  if (nested) push(nestedOf(nested))
  for (const obj of [...out]) {
    for (const key of ["toolCall", "tool_call", "update", "params"]) push(obj?.[key])
  }
  return out
}

// The first of `names` present on the event itself, else on a nested
// payload. `null` when no spelling carries anything.
function fieldOf(event, ...names) {
  for (const source of sourcesOf(event)) {
    for (const name of names) {
      const value = source[name]
      if (value !== undefined && value !== null && value !== "") return value
    }
  }
  return null
}

// Flatten an ACP `session/update` (or a line that only tagged itself with
// `sessionUpdate`) into the projected `{type, …}` shape the rest of this
// file already reads. A no-op for every documented streaming-json line.
function normalizeEvent(event) {
  if (!event || typeof event !== "object") return event
  if (event.method === "session/update" && event.params?.update && typeof event.params.update === "object") {
    const update = event.params.update
    return { ...update, type: update.sessionUpdate || update.type || "session_update" }
  }
  if (typeof event.sessionUpdate === "string" && !event.type) {
    return { ...event, type: event.sessionUpdate }
  }
  return event
}

function eventTypeOf(event) {
  const normalized = normalizeEvent(event)
  const tagged = String(normalized?.type || "")
  if (tagged && !CONTENT_BLOCK_TYPES.has(tagged)) return tagged
  const nested = nestedOf(normalized)
  const inner = String(nested?.sessionUpdate || nested?.type || "")
  return inner && !CONTENT_BLOCK_TYPES.has(inner) ? inner : tagged
}

// An ACP content block, a list of them, or the bare string the flat projection
// sends. Bounded depth: `content` may wrap `content` once (a message holding
// blocks), and anything deeper is a shape we do not claim to read.
function textFromContent(value, depth = 0) {
  if (typeof value === "string") return value
  if (depth >= 3) return ""
  if (Array.isArray(value)) return value.map((entry) => textFromContent(entry, depth + 1)).join("")
  if (!value || typeof value !== "object") return ""
  if (typeof value.text === "string") return value.text
  // Serde adjacent tagging of `Text { data: String }` / `Thought { data }`:
  // `{"type":"text","data":{"data":"hello"}}`. 0.22.0 read ContentBlock
  // `{type,text}` and missed this, so the answer was still empty.
  if (typeof value.data === "string") return value.data
  if (typeof value.delta === "string") return value.delta
  if (value.content !== undefined) return textFromContent(value.content, depth + 1)
  if (value.data !== undefined) return textFromContent(value.data, depth + 1)
  return ""
}

// The answer, and only the answer. `thought` is deliberately not in this set:
// reasoning is not what the person asked for and must never be collected as
// though it were. The ACP `sessionUpdate` spellings are here beside the
// projected one because a build that stops projecting emits those names
// verbatim, and the cost of reading both is nothing.
const TEXT_TYPES = new Set(["text", "agent_message_chunk", "assistant_message_chunk"])
const THOUGHT_TYPES = new Set(["thought", "agent_thought_chunk"])
const TEXT_KEYS = ["data", "text", "delta", "content", "message"]

function chunkOf(event, types) {
  const normalized = normalizeEvent(event)
  if (!types.has(eventTypeOf(normalized))) return null

  for (const key of TEXT_KEYS) {
    const chunk = textFromContent(normalized[key])
    if (chunk) return chunk
  }
  const chunk = textFromContent(nestedOf(normalized))
  return chunk || null
}

function textOf(event) {
  return chunkOf(event, TEXT_TYPES)
}

function thoughtOf(event) {
  return chunkOf(event, THOUGHT_TYPES)
}

function toolNameOf(event) {
  return String(fieldOf(event, "toolName", "tool_name", "name") || "")
}

function toolKindOf(event) {
  return String(fieldOf(event, "kind") || "")
}

function toolTitleOf(event) {
  return String(fieldOf(event, "title") || "")
}

function toolInputOf(event) {
  const input = fieldOf(event, "rawInput", "raw_input", "input", "arguments")
  return input && typeof input === "object" && !Array.isArray(input) ? input : {}
}

// The file a tool call names: its own input first, then the ACP `locations`
// list, which every kind of call may carry.
function toolPathOf(event) {
  const input = toolInputOf(event)
  for (const value of [input.path, input.file_path, input.target_file]) {
    if (typeof value === "string" && value.trim()) return value.trim()
  }
  const locations = fieldOf(event, "locations")
  const location = (Array.isArray(locations) ? locations : [])
    .find((entry) => typeof entry?.path === "string" && entry.path.trim())
  return location ? location.path.trim() : null
}

function commandOf(event) {
  const input = toolInputOf(event)
  for (const value of [input.command, input.cmd]) {
    if (typeof value === "string" && value.trim()) return value
  }
  // ACP titles a shell call with the command line; nothing else is that.
  return toolKindOf(event) === "execute" ? toolTitleOf(event) : ""
}

// The tool names xAI documents (read_file, grep, list_dir, todo_write, bash,
// search_replace, web_search, web_fetch) and, for anything else, the ACP
// `kind` every call is tagged with — read, edit, delete, move, search,
// execute, think, fetch — which says what a call is doing without its name.
function describeEvent(event) {
  if (!event || typeof event !== "object") return null
  event = normalizeEvent(event)

  switch (eventTypeOf(event)) {
    // Reasoning is streamed into the thinking log as its own text (see
    // `partialThoughtFrom`). Returning "Thinking" here is what filled a Grok
    // turn with that word between every real action — Claude's log is the
    // tool steps, and this ticker is the same surface.
    case "thought":
    case "agent_thought_chunk":   return null
    case "plan":                  return "Planning"
    case "auto_compact_started":  return "Compacting the conversation"
    case "tool_call":             break
    default:                      return null
  }

  const file = shortPath(toolPathOf(event))
  const running = () => {
    const cmd = shortCommand(commandOf(event))
    return cmd ? `Running ${cmd}` : "Running a command"
  }

  const name = toolNameOf(event)
  switch (name) {
    case "read_file":      return file ? `Reading ${file}` : "Reading a file"
    case "write_file":
    case "create_file":    return file ? `Writing ${file}` : "Writing a file"
    case "search_replace":
    case "edit_file":      return file ? `Editing ${file}` : "Editing a file"
    case "list_dir":       return "Listing files"
    case "grep":           return "Searching the code"
    // xAI's own docs: the shell tool is `run_terminal_cmd`, not `bash`.
    case "bash":
    case "shell":
    case "run_terminal_cmd":
    case "run_terminal_command":
                           return running()
    case "todo_write":     return "Updating the plan"
    default:               break
  }

  switch (toolKindOf(event)) {
    case "read":    return file ? `Reading ${file}` : "Reading a file"
    case "edit":
    case "delete":
    case "move":    return file ? `Editing ${file}` : "Editing files"
    case "search":  return "Searching the code"
    case "execute": return running()
    case "fetch":   return "Fetching a page"
    case "think":   return null
    default:        break
  }

  // MCP tools arrive as mcp__server__tool; the middle parts are the only
  // half worth showing. Same rule Claude Code's adapter uses.
  if (name.startsWith("mcp__") || name.startsWith("mcp_")) {
    const pretty = name.replace(/^mcp__?/, "").split("__").join(" ").replace(/_/g, " ").trim()
    return pretty ? `${pretty.charAt(0).toUpperCase()}${pretty.slice(1)}`.slice(0, 60) : "Calling a tool"
  }

  const pretty = (name || toolTitleOf(event)).replace(/_/g, " ").trim()
  return pretty ? `${pretty.charAt(0).toUpperCase()}${pretty.slice(1)}`.slice(0, 60) : "Working"
}

function partialTextFrom(event) {
  return textOf(event)
}

function partialThoughtFrom(event) {
  return thoughtOf(event)
}

// Which file this event wrote, for the documents channel. `search_replace` is
// the editing tool xAI names; the ACP kind covers every other write. A shape
// we do not recognise reports nothing and the run is unaffected —
// `collectDocuments` also finds files by mtime, so a missed event costs
// nothing.
const WRITE_TOOLS = new Set(["search_replace", "write_file", "create_file", "edit_file"])
const WRITE_KINDS = new Set(["edit", "delete", "move"])

function writtenPathFrom(event) {
  event = normalizeEvent(event)
  if (eventTypeOf(event) !== "tool_call") return null
  if (!WRITE_TOOLS.has(toolNameOf(event)) && !WRITE_KINDS.has(toolKindOf(event))) return null
  return toolPathOf(event)
}

function count(value) {
  const n = Math.floor(Number(value))
  return Number.isFinite(n) && n > 0 ? n : 0
}

// The spend fields `end` and `error` carry (project_result_usage in the CLI
// source). `usage` is already additive; the extras are read only when the
// build wrote them.
// The `usage` object, wherever the build put it. Read through fieldOf for the
// same reason the tool fields are: a nested payload must not cost the run its
// whole ledger, which is what a bare `event.usage` returns nothing for.
function usageOf(event) {
  const raw = fieldOf(event, "usage")
  return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : null
}

function spendFrom(event) {
  const raw = usageOf(event)
  if (!raw) return null

  const spend = { usage: normalizeUsage(raw), reasoning: null, numTurns: null, costUsd: null, modelUsage: null }
  if ("reasoning_tokens" in raw) spend.reasoning = count(raw.reasoning_tokens)

  const turns = fieldOf(event, "num_turns", "numTurns")
  if (turns !== null) spend.numTurns = count(turns)

  const cost = fieldOf(event, "total_cost_usd", "totalCostUsd")
  if (typeof cost === "number" && Number.isFinite(cost) && cost >= 0) spend.costUsd = cost

  const modelUsage = fieldOf(event, "modelUsage", "model_usage")
  if (modelUsage && typeof modelUsage === "object") spend.modelUsage = modelUsage
  return spend
}

// The model the run actually spent on: the `modelUsage` row with the most
// calls (the rows are in first-use order, so a tie goes to the first).
function modelLabelFrom(modelUsage) {
  let label = null
  let most = -1
  for (const [name, row] of Object.entries(modelUsage || {})) {
    const calls = count(row?.modelCalls)
    if (name && calls > most) { label = name; most = calls }
  }
  return label
}

// `contextWindow` is the streaming-messages-json spelling, on the current
// model's row only; this format has no window today. Read so a build that
// adds it is picked up, 0 when it is not there.
function contextWindowFrom(modelUsage, label) {
  return count(modelUsage?.[label]?.contextWindow)
}

const MAX_WARNINGS = 5

function collapseEvents(events) {
  const out = {
    content: "", usage: emptyUsage(), model: null,
    stopReason: null, isError: false, errorStatus: null, warnings: []
  }
  const warn = (text) => {
    if (text && out.warnings.length < MAX_WARNINGS) out.warnings.push(String(text).slice(0, 300))
  }

  let sawResult = false
  let contextTokens = 0
  let spend = null
  let sessionId = null
  const text = []
  // The per-response lines: the fallback total, and the count of responses.
  const calls = { usage: emptyUsage(), reasoning: 0, reported: false, seen: 0 }

  for (const raw of events) {
    if (!raw || typeof raw !== "object") continue
    const event = normalizeEvent(raw)

    const chunk = textOf(event)
    if (chunk) text.push(chunk)

    switch (eventTypeOf(event)) {
      case "usage": {
        const raw = usageOf(event)
        if (!raw) break
        const call = normalizeUsage(raw)
        for (const key of Object.keys(calls.usage)) calls.usage[key] += call[key]
        if ("reasoning_tokens" in raw) {
          calls.reasoning += count(raw.reasoning_tokens)
          calls.reported = true
        }
        calls.seen += 1
        contextTokens = occupancyOf(call) || contextTokens
        break
      }
      case "end":
      case "error": {
        if (eventTypeOf(event) === "end") {
          sawResult = true
          out.stopReason = String(fieldOf(event, "stopReason", "stop_reason") || "end")
        } else {
          out.isError = true
          out.errorStatus = String(fieldOf(event, "message", "error") || "").slice(0, 300) || out.errorStatus
        }
        const id = fieldOf(event, "sessionId", "session_id")
        if (typeof id === "string" && id.trim()) sessionId = id.trim()
        // `end` is documented as always last and as carrying the run's spend,
        // so its figures REPLACE anything seen before rather than adding to it.
        spend = spendFrom(event) || spend
        if (fieldOf(event, "usage_is_incomplete", "usageIsIncomplete") === true) {
          warn("Grok reported its token count as incomplete (a sub-agent was still running), so the totals may under-count.")
        }
        break
      }
      case "max_turns_reached":
        warn("Grok stopped at its turn limit before the task was finished.")
        break
      case "auto_compact_failed":
        warn(`Grok could not compact the conversation: ${String(event.error || "").slice(0, 200)}`)
        break
      default:
        break
    }
  }

  // The run total: the CLI's own aggregate when it sent one, else the sum of
  // its per-response lines — never both. Zeros mean "not reported".
  const total = spend ? spend.usage : calls.usage
  out.usage = { ...total, context_tokens: contextTokens }

  const reasoning = spend ? spend.reasoning : (calls.reported ? calls.reasoning : null)
  if (reasoning !== null) out.usage.reasoning_tokens = reasoning

  // `num_turns` is the CLI's own count of main-agent rounds; without an
  // aggregate, the count of completed responses is what its Messages reducer
  // itself falls back to.
  if (spend?.numTurns !== null && spend?.numTurns !== undefined) out.usage.num_turns = spend.numTurns
  else if (!spend && calls.seen > 0) out.usage.num_turns = calls.seen

  // Present only when the CLI reported a COMPLETE cost (API-key traffic;
  // absent on a subscription): informational, never a charge.
  if (spend?.costUsd !== null && spend?.costUsd !== undefined) out.usage.total_cost_usd = spend.costUsd

  const label = modelLabelFrom(spend?.modelUsage)
  if (label) {
    out.model = label
    out.usage.model_label = label
    const window = contextWindowFrom(spend.modelUsage, label)
    if (window > 0) out.usage.context_window = window
  }

  // The id to hand back as `runtime_session_id` — see resumePlan for the
  // `--resume` side of the same contract.
  if (sessionId) out.usage.runtime_session_id = sessionId

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
  // The browser sign-in at grok.com — the SUBSCRIPTION path, and the only one
  // this runtime is for. `--device-auth` is xAI's documented no-browser
  // variant: it prints a URL and a code to enter on another device, which is
  // what a paired server or an SSH session needs.
  loginArgs: ({ deviceAuth = false } = {}) => (deviceAuth ? ["login", "--device-auth"] : ["login"]),
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
  // A resume whose transcript is gone, or an effort level the model's menu
  // lacks, is retried once as an ordinary turn — see fallbackJob.
  fallbackJob,

  // Writes config.toml (MCP servers, and the built-ins we turn off) into
  // GROK_HOME before every spawn.
  prepare(job, { configDir }) {
    writeConfig(job, configDir)
  },

  // XAI_API_KEY is removed, not merely left unset, and that is the difference
  // between a promise and a hope.
  //
  // This runtime exists to spend a SuperGrok or X Premium+ plan. xAI's own
  // credential order is: a per-model key, then the active session token, then
  // `XAI_API_KEY` from the environment. The first two are the profile's, and
  // the third is whatever the machine's owner exported for their own work —
  // inherited by every process they spawn, this one included. So a profile
  // whose session had lapsed would not fail; it would quietly fall through to
  // per-token billing on a different account, which is exactly the mix-up a
  // consumer Grok plan cannot even be used for (SuperGrok does not fund
  // console.x.ai).
  //
  // Undefined rather than empty: Node omits an undefined value from the child
  // environment, where an empty string would be a key that is present and
  // blank. A run now either uses the login the user made through
  // `cma-agent runtimes:login --runtime grok` or stops and says it needs one.
  envFor: (job) => ({ ...envForGithub(job), ...envForWeb(job), XAI_API_KEY: undefined }),

  describeEvent,
  collapseEvents,
  partialTextFrom,
  partialThoughtFrom,
  writtenPathFrom,

  limitations: [
    "The prompt travels as a command-line argument, so a very long conversation " +
      "is bounded by the machine's ARG_MAX and the prompt is visible in `ps` while the run lasts.",
    "Token figures are the CLI's own run ledger; a run whose sub-agent was still running when the " +
      "turn ended is flagged by Grok as incomplete and may under-count. The context window is not on this " +
      "stream, so the meter falls back to the platform's table."
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
