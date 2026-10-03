import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  classifyFailure, emptyUsage, envForGithub, envForWeb, locateBin, locationAdvice, loginCommand,
  maskAccount, mcpServersFor, normalizeUsage, shortCommand, shortPath
} from "./shared.js"

// ---------------------------------------------------------------------------
// OpenAI's Codex CLI (`codex`), in its non-interactive form: `codex exec`.
//
// The flag surface below is what a real build's exec mode actually parses —
// read out of exec-mode experiments against codex 0.114.0 and re-checked
// against codex-rs/exec/src/cli.rs on main (2026-09-13); the parts that
// matter here have been stable across the Rust rewrite:
//
//   codex exec -            prompt on stdin (a positional would also work,
//                           but stdin has no ARG_MAX and cannot be swallowed)
//   --json                  JSONL event stream on stdout
//   --model <id>            model override
//   --sandbox <level>       read-only | workspace-write | danger-full-access
//   --full-auto             approval=never + sandbox=workspace-write
//   --cd <dir>              working directory
//   --skip-git-repo-check   run outside a directory codex itself trusts
//   -c key=value            config override (dotted TOML path)
//   resume <thread_id> -    continue an earlier thread (options go BEFORE
//                           the subcommand: `codex exec [OPTIONS] resume …`)
//
// Approvals need no mapping at all: exec mode downgrades every approval
// policy to `never` because there is no TTY to ask in, so the sandbox level
// IS the whole permission story. That maps cleanly onto ours:
//
//   repository turn  --full-auto            edits confined to the workspace
//   plain chat       --sandbox read-only    answers, writes nothing
//
// `--skip-git-repo-check` is passed on repository turns because the trust
// decision it asks about has already been made — the directory was
// allowlisted by the user via `cma-agent repos:add` — and a headless run has
// nobody to answer codex's own version of the question.
//
// ── The stated limitation ──────────────────────────────────────────────────
//
// The forbidden-git deny list (force-push and friends) has no codex flag to
// ride. Claude Code takes per-command disallows and Cursor takes a
// permissions file; codex's equivalent is its execpolicy machinery, whose
// format is not verified here, and a guessed policy file would be inert
// coverage. So a codex repository turn is bounded by the workspace-write
// sandbox and the system prompt's rules, and `limitations` says so instead
// of pretending otherwise.
// ---------------------------------------------------------------------------

const CLI = {
  exec: "exec",
  json: "--json",
  stdin: "-",
  resume: "resume",
  model: (id) => ["--model", id],
  sandbox: (level) => ["--sandbox", level],
  fullAuto: "--full-auto",
  cd: (dir) => ["--cd", dir],
  skipGitRepoCheck: "--skip-git-repo-check",
  config: (pair) => ["-c", pair]
}

// ---------------------------------------------------------------------------
// The effort dial.
//
// Ai::Effort's five stops are Codex's own vocabulary: `model_reasoning_effort`
// takes low | medium | high | xhigh | max verbatim (ReasoningEffort in
// codex-rs/protocol/src/openai_models.rs), so the mapping is the identity and
// the flag is one `-c` override. Absent means the model's own default — on
// gpt-5.6-sol and gpt-6-astra that is `low`, on the rest `medium` — which is
// exactly the dial's contract: an untouched dial adds nothing to the run.
//
// The only clamp is the top stop. `max` exists on the 5.6 line and GPT-6;
// gpt-5.5, gpt-5.4, gpt-5.3-codex and the plain gpt-5 family stop at xhigh
// (models.json supported_reasoning_levels), and asking those for `max` is a
// rejected request rather than a harder-thinking one. An id this table does
// not know passes through unclamped: the CLI accepts any spelling
// (ReasoningEffort::Custom) and the backend clamps a level it does not serve.
// ---------------------------------------------------------------------------

const EFFORT_LEVELS = new Set(["low", "medium", "high", "xhigh", "max"])
const EFFORT_STOPS_AT_XHIGH = /^gpt-5(?:\.[0-5])?(?:-|$)/

export function effortFor(job) {
  const level = String(job?.effort || "").trim().toLowerCase()
  if (!EFFORT_LEVELS.has(level)) return null

  const model = String(job?.model || "").trim().toLowerCase()
  if (level === "max" && EFFORT_STOPS_AT_XHIGH.test(model)) return "xhigh"
  return level
}

// ---------------------------------------------------------------------------
// Thread continuity.
//
// Every `codex exec` is a new thread: the whole rendered conversation is
// re-tokenised as fresh input (a cache WRITE on the 5.6 line) on the first
// call of every turn. `codex exec resume <thread_id>` keeps the thread on the
// machine instead — Codex holds the history, its `prompt_cache_key` (the
// thread id) stays constant, and the prior context is a cache read. The
// server hands the id back as `runtime_session_id` when it has one from a
// previous run on this login; read defensively, because an older server
// never sends it and a newer one may send it for a run that happened on a
// different machine (Codex then fails the turn and says so in-band).
//
// The id is a UUID (or a thread name) and lands in argv, so anything outside
// a safe token — spaces, a leading dash that clap would read as `--last` — is
// ignored rather than passed.
// ---------------------------------------------------------------------------

const THREAD_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

export function resumeThreadId(job) {
  const raw = job?.runtime_session_id ?? job?.runtimeSessionId
  const id = String(raw || "").trim()
  return THREAD_ID.test(id) ? id : null
}

export function baseArgs(job) {
  const args = []
  if (job.model) args.push(...CLI.model(job.model))

  if (job.workdir) {
    // Edits without prompting, confined to the working tree. `--full-auto` is
    // codex's own composite for exactly this posture.
    args.push(CLI.fullAuto)
    args.push(...CLI.cd(job.workdir))
    args.push(CLI.skipGitRepoCheck)
    // workspace-write blocks the network by default, which would strand the
    // git fetch/pull/push a repository turn ships its work with. The override
    // is the documented [sandbox_workspace_write] table as a -c dotted path.
    args.push(...CLI.config("sandbox_workspace_write.network_access=true"))
  } else {
    // A chat completion writes nothing. read-only is the narrow choice, and
    // it also needs no repo check because nothing touches a tree.
    args.push(...CLI.sandbox("read-only"))
    args.push(CLI.skipGitRepoCheck)
  }

  const effort = effortFor(job)
  if (effort) args.push(...CLI.config(`model_reasoning_effort=${effort}`))

  return args
}

// The prompt travels on stdin (`exec -`), never as a positional — same
// reasoning as the Claude Code adapter: stdin has no ARG_MAX ceiling and
// nothing can swallow it. `-` must stay LAST so no flag value can absorb it.
// On a resumed thread the subcommand sits between the options and the `-`:
// `codex exec [OPTIONS] resume <id> -` is the grammar cli.rs states.
export function streamingArgs(job) {
  const args = [CLI.exec, CLI.json, ...baseArgs(job)]
  const thread = resumeThreadId(job)
  if (thread) args.push(CLI.resume, thread)
  args.push(CLI.stdin)
  return args
}

// Codex has no --append-system-prompt in exec mode we are willing to lean on
// (`-c developer_instructions=…` exists but puts the whole system text into
// argv, visible in `ps`), so the system text rides the prompt the way Cursor's
// and Gemini's do — visibly fenced, never silently glued.
//
// A resumed thread already holds the system block and every earlier message,
// so it gets ONLY the newest user message: re-sending the transcript would
// double it inside Codex's own history and pay for it again as fresh input.
// The server keeps the system text byte-stable across turns and hoists its
// volatile clock band into the last user message, which is exactly what rides.
export function renderPrompt(job, conversation) {
  if (resumeThreadId(job)) {
    const latest = latestUserMessage(job.messages)
    if (latest) return latest
  }

  if (!job.system) return conversation
  return `<system>\n${job.system}\n</system>\n\n${conversation}`
}

function latestUserMessage(messages) {
  if (!Array.isArray(messages)) return null

  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (!message || message.role !== "user") continue
    const content = typeof message.content === "string" ? message.content : JSON.stringify(message.content)
    if (content && content.trim()) return content
  }

  return null
}

// ---------------------------------------------------------------------------
// MCP wiring.
//
// Codex discovers MCP servers from config.toml inside CODEX_HOME — there is
// no inline flag — so, like Cursor, the file lives in a directory WE own and
// never in the user's ~/.codex, whose config their own terminal reads. That
// is also why this adapter has no ambient mode (`ambientProfile: false`):
// the managed directory is the only place this file may go, so even the
// default login is a managed one, signed in once via
// `cma-agent runtimes:login --runtime codex`.
//
// The file names a command and carries no secret: the GitHub and web tokens
// travel by environment, exactly as they do for every other runtime.
// ---------------------------------------------------------------------------

function tomlString(value) {
  return JSON.stringify(String(value))
}

export function configTomlFor(job) {
  const lines = [
    "# Written by cma-agent before every run. Do not edit — changes are",
    "# overwritten. Login state (auth.json) is codex's own and is not touched."
  ]

  for (const [name, server] of Object.entries(mcpServersFor(job))) {
    lines.push(`[mcp_servers.${name}]`)
    lines.push(`command = ${tomlString(server.command)}`)
    lines.push(`args = [${server.args.map(tomlString).join(", ")}]`)
  }

  return `${lines.join("\n")}\n`
}

// Called before every spawn with the profile's config directory (which is
// what CODEX_HOME points at). Always rewritten, never merged: the file is
// ours alone, and a stale server entry from a job that had a grant this one
// lacks would offer tools that can only fail.
export function writeConfig(job, configDir) {
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(configDir, "config.toml"), configTomlFor(job), { mode: 0o600 })
}

// ---------------------------------------------------------------------------
// Which ChatGPT account a login resolves to.
//
// Codex keeps its credential in auth.json inside CODEX_HOME — either a raw
// API key or the ChatGPT OAuth tokens. The account address lives in the JWT's
// payload, which decodes with nothing but base64: no signature check, because
// nothing here authenticates — this only answers "which account pays", the
// same question the Claude Code adapter answers from .claude.json.
// ---------------------------------------------------------------------------

function jwtEmail(idToken) {
  const payload = String(idToken || "").split(".")[1]
  if (!payload) return null

  try {
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))
    const email = String(decoded.email || "").trim()
    return email || null
  } catch {
    return null
  }
}

// Exported for tests: the parsing, without a filesystem to stage.
export function accountFromAuth(parsed) {
  if (!parsed || typeof parsed !== "object") return null

  const email = jwtEmail(parsed.tokens?.id_token)
  if (email) return { email, source: "oauth" }

  // An API key is a different kind of login and worth saying so: it spends
  // per-token billing rather than a ChatGPT plan — exactly the mix-up this
  // feature exists to prevent.
  if (parsed.OPENAI_API_KEY) return { email: null, source: "api_key" }

  return null
}

export function readAccount({ configDir = null } = {}) {
  const dirs = configDir
    ? [configDir]
    : [process.env.CODEX_HOME, path.join(os.homedir(), ".codex")]

  for (const dir of dirs.filter(Boolean)) {
    try {
      const account = accountFromAuth(JSON.parse(fs.readFileSync(path.join(dir, "auth.json"), "utf8")))
      if (account) return account
    } catch {
      // Missing, unreadable or not JSON — try the next candidate.
    }
  }

  return null
}

export function describeAccount(account) {
  if (!account) return null
  if (account.source === "api_key") return "account: an OpenAI API key"
  return account.email ? `account: ${account.email}` : null
}

// ---------------------------------------------------------------------------
// Usage: Codex counts INCLUSIVELY, the companion reports ADDITIVELY.
//
// `turn.completed.usage` (codex-rs/exec/src/exec_events.rs) is
//
//   { input_tokens, cached_input_tokens, cache_write_input_tokens,
//     output_tokens, reasoning_output_tokens }
//
// where `input_tokens` is the GROSS prompt count with `cached_input_tokens`
// AND `cache_write_input_tokens` inside it, and `reasoning_output_tokens` is
// inside `output_tokens`. Codex's own parser fixture is the proof: a Responses
// usage of input 100 = cached 40 + cache_write 60, output 10 (reasoning 5)
// totals 110, not 210. The companion's shape — normalizeUsage and the
// server's arithmetic behind it — is Anthropic's, where `input_tokens`
// EXCLUDES the cache and the cache buckets are added on top. Passing Codex's
// numbers through unconverted made the server add the cached share a second
// time: a run of input 24,763 / cached 24,448 / output 122 was recorded as
// 49,333 tokens against a true 24,885, and the "cached" share read ~50%
// where Codex's own figure is 98%. The conversion happens here, before
// anything reaches normalizeUsage, so the server's sum equals Codex's own.
//
// `reasoning_tokens` rides as information only — it is already inside the
// output count and must never be added to it — and is sent only when the
// build reported one (absent = unknown, never 0). The object is also
// THREAD-cumulative: every API call of the run summed, and across
// `exec resume` every earlier run of the thread too — see the occupancy note
// in collapseEvents for why that makes it unusable as a context reading.
// ---------------------------------------------------------------------------

export function additiveUsage(raw) {
  const usage = raw && typeof raw === "object" ? raw : {}
  const count = (key) => Math.max(0, Math.floor(Number(usage[key]) || 0))

  const gross = count("input_tokens")
  const cached = count("cached_input_tokens")
  const written = count("cache_write_input_tokens")

  const out = normalizeUsage({
    input_tokens: Math.max(0, gross - cached - written),
    cache_read_input_tokens: cached,
    cache_creation_input_tokens: written,
    output_tokens: count("output_tokens")
  })

  if ("reasoning_output_tokens" in usage) out.reasoning_tokens = count("reasoning_output_tokens")
  return out
}

// How full the window was on ONE prompt, read from a per-request usage object
// in Codex's shape. Because that shape is inclusive, the gross `input_tokens`
// IS the prompt — cached and written tokens are already inside it — so adding
// the cache buckets on top (what the shared occupancyOf does, correctly, for
// the additive runtimes) would over-read by the cached share. Probes the
// spellings the per-request figure has been given or asked for
// (openai/codex#17539) and answers 0 when none is present.
function lastPromptOccupancy(source) {
  if (!source || typeof source !== "object") return 0

  const candidates = [
    source.last_usage, source.lastUsage,
    source.last_token_usage, source.lastTokenUsage,
    source.usage?.last, source.usage?.last_usage,
    source.info?.last_token_usage, source.info?.lastTokenUsage
  ]

  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") continue
    const prompt = Math.max(0, Math.floor(Number(candidate.input_tokens) || 0))
    if (prompt > 0) return prompt
  }

  return 0
}

// Codex runs every slug in its bundled catalogue at a 272,000-token window
// (models.json `context_window`; it auto-compacts at 90% of it) unless a
// config override lifts it, and this adapter never passes one. The API's
// window for the same ids is 1,050,000, which is what the server's own
// tables say — a Codex run is measured against the smaller number, and the
// smaller number is what the context meter needs. Any figure a build puts on
// the wire (`model_context_window` is the field TokenUsageInfo carries
// internally) wins over the constant.
export const CODEX_CONTEXT_WINDOW = 272_000

function windowFrom(source) {
  if (!source || typeof source !== "object") return 0

  for (const candidate of [
    source.model_context_window, source.context_window,
    source.usage?.model_context_window, source.info?.model_context_window
  ]) {
    const window = Math.floor(Number(candidate) || 0)
    if (window > 0) return window
  }

  return 0
}

// ---------------------------------------------------------------------------
// The event stream.
//
// codex exec --json emits JSONL: thread.started, turn.started, then
// item.started/item.completed pairs, closing with turn.completed (usage) or
// turn.failed (error). Items carry a `type` discriminator — agent_message,
// reasoning, command_execution, file_change, mcp_tool_call, web_search,
// error — and the fields are read defensively because they are another
// product's format.
//
// An `error` item is NOT a failed run. The JSONL writer
// (event_processor_with_jsonl_output.rs) emits warnings, config warnings,
// deprecation notices ("GPT-5.4 is no longer available…") and model reroutes
// ("model rerouted: gpt-5.4 -> gpt-5.6-terra (Deprecated)") as exactly that
// item while the turn keeps running and still closes with turn.completed.
// Treating every one as fatal threw away finished answers — and the plan
// usage they had already spent. Only turn.failed and the top-level `error`
// event end a run; the notices ride along as `warnings` and become the
// failure only when the turn never completed or produced nothing.
// ---------------------------------------------------------------------------

const MAX_WARNINGS = 10
const REROUTE = /model rerouted:\s*(\S+)\s*->\s*(\S+)/i

function itemOf(event) {
  if (!event || typeof event !== "object") return null
  if (!["item.started", "item.updated", "item.completed"].includes(event.type)) return null
  return event.item && typeof event.item === "object" ? event.item : null
}

function noticeText(item) {
  return String(item.message || item.text || "").trim().slice(0, 300)
}

function describeItem(item) {
  switch (item.item_type || item.type) {
    case "command_execution": {
      const cmd = shortCommand(item.command)
      return cmd ? `Running ${cmd}` : "Running a command"
    }
    case "file_change": {
      const first = Array.isArray(item.changes) ? item.changes[0] : null
      const file = shortPath(first?.path || item.path)
      return file ? `Editing ${file}` : "Editing files"
    }
    case "mcp_tool_call": {
      const pretty = [item.server, item.tool].filter(Boolean).join(" ").replace(/_/g, " ")
      return pretty ? `${pretty.charAt(0).toUpperCase()}${pretty.slice(1)}`.slice(0, 60) : "Calling a tool"
    }
    case "web_search":   return "Searching the web"
    case "todo_list":    return "Updating the plan"
    case "reasoning":    return "Thinking"
    case "agent_message": return null // the answer, not a step
    // A notice is worth a ticker line: it is the only place a user learns
    // that the id they picked was rerouted or retired mid-run.
    case "error": {
      const notice = noticeText(item)
      return notice ? `Codex: ${notice.slice(0, 72)}` : null
    }
    default:             return null
  }
}

function describeEvent(event) {
  if (!event || typeof event !== "object") return null

  if (event.type === "thread.started" || event.type === "turn.started") return "Starting up"

  const item = itemOf(event)
  if (!item) return null
  return describeItem(item)
}

// Which file this event wrote, for the documents channel. file_change items
// carry a changes list; a shape we don't recognise reports nothing and the
// run is unaffected.
function writtenPathFrom(event) {
  if (event?.type !== "item.completed") return null

  const item = itemOf(event)
  if (!item || (item.item_type || item.type) !== "file_change") return null

  const first = Array.isArray(item.changes) ? item.changes[0] : null
  const file = first?.path || item.path
  return typeof file === "string" && file.trim() ? file.trim() : null
}

function collapseEvents(events) {
  const out = {
    content: "", usage: emptyUsage(), model: null,
    stopReason: null, isError: false, errorStatus: null, warnings: []
  }

  let sawResult = false
  const answers = []
  let threadId = null
  let contextWindow = 0
  // How full the window was on the LAST prompt, which `turn.completed.usage`
  // cannot answer: that object is the THREAD's cumulative token count, so on
  // a long run it grows past the window (openai/codex#17539 reports 6.9M
  // cumulative input against a 272K window). Codex tracks the per-request
  // figure internally as ThreadTokenUsage.last and the interactive TUI draws
  // its own context meter from it; the exec JSONL writer drops it on the way
  // out (that issue asked for it and was closed without it).
  //
  // So this reads the per-request field where a build emits one — under any
  // of the spellings that shape has been given — and reports 0 where none is
  // present. 0 means "unknown" and the composer draws no meter, which is the
  // correct reading of a Codex run today rather than a placeholder for one.
  let contextTokens = 0

  for (const event of events) {
    if (event?.type === "thread.started") {
      const id = String(event.thread_id || event.threadId || "").trim()
      if (id) threadId = id
      contextWindow = windowFrom(event) || contextWindow
    }

    // `token_count` carries the same accounting on builds that emit it, with
    // the per-request figure nested under `info`. No exec build has emitted
    // it so far; the branch costs nothing and would be exact if one did.
    if (event?.type === "token_count") {
      contextTokens = lastPromptOccupancy(event) || contextTokens
      contextWindow = windowFrom(event) || contextWindow
    }

    if (event?.type === "item.completed") {
      const item = itemOf(event)
      if (item && (item.item_type || item.type) === "agent_message") {
        const text = item.text ?? item.content ?? item.message
        if (typeof text === "string" && text) answers.push(text)
      }
      if (item && (item.item_type || item.type) === "error") {
        const notice = noticeText(item)
        if (notice && out.warnings.length < MAX_WARNINGS) out.warnings.push(notice)
        // A reroute names the model that actually answered — the one wire
        // fact about the model exec JSON carries, since no event states it.
        const rerouted = REROUTE.exec(notice)
        if (rerouted) out.model = rerouted[2].replace(/[),.]+$/, "")
      }
    }

    if (event?.type === "turn.completed") {
      sawResult = true
      out.stopReason = "completed"
      out.usage = additiveUsage(event.usage)
      contextTokens = lastPromptOccupancy(event) || contextTokens
      contextWindow = windowFrom(event) || contextWindow
    }

    if (event?.type === "turn.failed") {
      sawResult = true
      out.isError = true
      out.stopReason = "failed"
      out.errorStatus = String(event.error?.message || event.error || "").slice(0, 300) || out.errorStatus
    }

    if (event?.type === "error") {
      out.isError = true
      out.errorStatus = String(event.message || "").slice(0, 300) || out.errorStatus
    }
  }

  // After the loop, for the same reason as everywhere else here: the terminal
  // event replaces `usage` wholesale, and that object is the cumulative one.
  out.usage.context_tokens = contextTokens

  // The additive keys of the companion → server contract, all optional and
  // sent only when known. An older server drops them at its whitelist.
  if (threadId) out.usage.runtime_session_id = threadId
  if (out.model) out.usage.model_label = out.model
  if (sawResult && !out.isError) out.usage.context_window = contextWindow || CODEX_CONTEXT_WINDOW

  // The answer is the final agent message; earlier ones are progress notes on
  // a multi-step run. Falling back to the join keeps a partial run's words.
  out.content = answers.at(-1) || answers.join("")

  // A notice explains a run that never closed or closed empty better than
  // "finished without producing an answer" would — that is the one case the
  // notice IS the failure.
  if (!out.isError && out.warnings.length > 0 && (!sawResult || !out.content)) {
    out.isError = true
    out.errorStatus = out.warnings.at(-1)
  }

  return { ...out, sawResult }
}

export const codex = {
  id: "codex",
  name: "Codex CLI",
  cli: "codex",
  install: "https://developers.openai.com/codex/cli",
  binEnvVar: "CMA_CODEX_BIN",
  extraHomePaths: [".codex/bin/codex"],

  // CODEX_HOME is where codex keeps BOTH its login (auth.json) and the
  // config.toml this adapter writes. Because that file must live in a
  // directory we own (see the MCP note above), there is no ambient mode:
  // even the default profile is a managed directory, and signing in once
  // with `cma-agent runtimes:login --runtime codex` is a required step. The
  // upside is real isolation — a work ChatGPT and a personal one cannot
  // collapse into each other the way keychain-backed logins can.
  configDirEnvVar: "CODEX_HOME",
  profilesDirName: "codex-profiles",
  ambientProfile: false,

  readAccount,
  describeAccount,
  maskAccount,

  versionArgs: ["--version"],
  loginArgs: () => ["login"],
  loginHint: loginCommand("codex"),
  probeArgs: () => [CLI.exec, CLI.json, CLI.skipGitRepoCheck, "Reply with the single word: ok"],

  // stdin via `exec -` — see streamingArgs.
  promptOnStdin: true,
  // exec's stream already ends with the terminal turn event; there is no
  // separate buffered format worth falling back to.
  supportsBuffered: false,

  streamingArgs,
  renderPrompt,
  envFor: (job) => ({ ...envForGithub(job), ...envForWeb(job) }),

  // Writes config.toml (MCP servers) into CODEX_HOME before every spawn.
  prepare(job, { configDir }) {
    writeConfig(job, configDir)
  },

  describeEvent,
  collapseEvents,
  writtenPathFrom,

  limitations: [
    "The forbidden-git deny list (force-push, hard reset) is not enforced by a codex " +
      "flag yet — the workspace-write sandbox and the system prompt are the bounds.",
    "Codex's own web search stays off (it is opt-in and never passed) — the " +
      "mcp__cma_web__* tools are the web channel."
  ],

  classifyFailure: (detail, context = {}) =>
    classifyFailure(detail, { name: "Codex", loginHint: loginCommand("codex", context.profileSlug) }),

  resolveBin() {
    return locateBin({ cli: this.cli, envVar: this.binEnvVar, extraHomePaths: this.extraHomePaths })
  },

  advice() {
    const { bin, source } = this.resolveBin()
    return locationAdvice({ name: this.name, install: this.install, bin, source })
  }
}
