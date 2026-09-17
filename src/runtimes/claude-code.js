import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  builtinPlatformTools, builtinWebTools, classifyFailure, emptyUsage, envForGithub, envForWeb, firstKey,
  FORBIDDEN_GIT, GIT_VERBS, GITHUB_MCP_SERVER, locateBin, locationAdvice, loginCommand,
  maskAccount, mcpServersFor, occupancyOf, WEB_MCP_SERVER, normalizeUsage, shortCommand,
  shortPath
} from "./shared.js"

// ---------------------------------------------------------------------------
// Claude Code.
//
// The CLI surface we depend on is gathered in one object on purpose. These are
// another product's flags, and they can move between versions — when something
// breaks after a Claude Code upgrade, this object is the only thing that should
// need editing. Check the installed build with `claude --help` before changing
// anything here. Verified against Claude Code 2.1.270 (`claude --help` and two
// live `-p` runs — the fixtures in test/runtime_claude_code.test.js are those
// runs' real output).
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
  // The composer's effort dial. Claude Code takes the same five words
  // Ai::Effort::LEVELS uses (plus `ultracode`, which the app never sends) and
  // clamps per model — Opus/Sonnet 4.6 top out at `high`, Haiku ignores it.
  // Registered as a capability flag in engine.js: a build older than the
  // flag runs the turn at its default effort rather than not at all.
  effort: (level) => ["--effort", level],
  // Continue the transcript a previous turn of this same session left on
  // this machine, instead of re-sending the whole conversation as one
  // prompt. See resumePlan for what that buys and when it is safe.
  resume: (sessionId) => ["--resume", sessionId],
  // A ceiling on agentic turns. Only the login probe uses it today.
  maxTurns: (count) => ["--max-turns", String(count)],
  appendSystem: (text) => ["--append-system-prompt", text],
  // Working inside a real repository means Claude Code must be allowed to
  // edit files without stopping to ask — there is no terminal for anyone to
  // answer in. `acceptEdits` is the narrow choice on purpose: edits yes,
  // arbitrary commands no. The directory it is confined to has already been
  // allowlisted by the user via `cma-agent repos:add`.
  permissionMode: (mode) => ["--permission-mode", mode],
  // A further directory this run may work in, beyond its cwd. One flag per
  // directory, and the value is its own argument — never appended to the
  // flag — the same shape every other option here uses.
  addDir: (dir) => ["--add-dir", dir],
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

// The file tools a repository turn may use without asking. Deliberately NOT
// including `TodoWrite` any more: naming a task-tracking tool in
// --allowedTools "also opts the session in" to the task tools on the models
// where Claude Code leaves them out to save context (Opus 4.8+, Sonnet 5,
// Fable — tools-reference "Task tool availability"), so every request on the
// newest models carried five extra tool definitions plus their reminders for
// a checklist nobody reads. The task tools never prompt for permission, so
// nothing is lost on the older models that still have them. `LS` is gone
// from the CLI entirely (inert here) and was dropped for the same reason.
const FILE_TOOLS = ["Read", "Write", "Edit", "MultiEdit", "NotebookEdit", "Glob", "Grep"]

// Ai::Effort::LEVELS, verbatim. A whitelist rather than a pass-through
// because the value lands in argv.
const EFFORT_LEVELS = new Set(["low", "medium", "high", "xhigh", "max"])

export function effortFor(job) {
  const level = String(job?.effort || "").trim().toLowerCase()
  return EFFORT_LEVELS.has(level) ? level : null
}

// ---------------------------------------------------------------------------
// Session continuity.
//
// Every turn used to be a brand-new `claude -p` fed the ENTIRE conversation
// flattened into one user message. Claude Code's own layers (system prompt,
// tools, CLAUDE.md) were cache reads across runs, but the history never was:
// a new, longer single message each time is never a prefix match, so 100% of
// it was re-processed and re-WRITTEN at the 1-hour premium (2x input) on
// every turn, and only that run's internal steps ever read it back.
//
// `--resume <session id>` continues the transcript the previous turn left on
// this machine, so the history becomes a cache READ (0.1x, 0.025x on Fable
// 5.1) while the TTL is warm — roughly 20x cheaper on the history bucket —
// and the model sees its real tool calls and results instead of a text
// rendering of its answers. Not every turn qualifies, and the rules below
// are what keep the cheap path from becoming a wrong one:
//
//   * the server decides WHETHER to offer an id (Ai::LocalCompanionClient
//     only sends one when the system prompt is byte-identical to the one
//     the session was recorded with — Claude Code reuses the recorded
//     prompt until compaction, so a changed prompt must start fresh);
//   * the id must be a UUID — it goes into argv;
//   * the history must be an append-only continuation: at least one
//     assistant turn the transcript already holds, followed only by user
//     turns (the new message, plus the bot's hoisted clock band when there
//     is one). Anything else — an edited history, a deleted answer — is sent
//     the old way, in full;
//   * when the transcript is gone (30-day cleanup, another machine, a
//     different profile) Claude Code exits before its `init` event and the
//     engine retries the turn with the full history — see fallbackJob.
// ---------------------------------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// { sessionId, tail } when this job may resume, null when it must not. The
// tail is the part of the conversation the transcript has not seen.
export function resumePlan(job) {
  const sessionId = String(job?.runtime_session_id || "").trim()
  if (!UUID.test(sessionId)) return null

  const messages = Array.isArray(job.messages) ? job.messages : []
  let lastAssistant = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "assistant") { lastAssistant = i; break }
  }
  // Nothing the transcript could already hold: a first turn is a fresh
  // session whatever id the server had lying around.
  if (lastAssistant < 0) return null

  const tail = messages.slice(lastAssistant + 1)
  if (tail.length === 0 || tail.some((m) => m?.role !== "user")) return null

  return { sessionId, tail }
}

// The prompt a resumed turn is fed: just the new user turn(s), verbatim and
// unframed — the transcript already has every earlier turn as a real
// message, and a "User: … Assistant:" rendering of the whole history on top
// of it would be the history twice. Any job that is not resuming gets the
// engine's rendering back untouched.
export function renderPrompt(job, conversation) {
  const plan = resumePlan(job)
  if (!plan) return conversation

  return plan.tail
    .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
    .join("\n\n")
}

// One more attempt without the transcript, or null.
//
// A resume that cannot find its session fails before anything is spent:
// non-zero exit, no `system/init`, "No conversation found with session ID"
// on stderr. That run must not be reported as a failed turn — the same job
// without the id is exactly what an ordinary turn looks like, and the engine
// runs it as one. Anything past `init` was a real run with a real failure
// (rate limit, API error), and re-sending the whole history would double the
// spend for nothing; an argv rejection is the engine's own degrade path.
export function fallbackJob(job, result = {}) {
  if (!resumePlan(job)) return null

  const events = Array.isArray(result.events) ? result.events : []
  if (events.some((event) => event?.type === "system" && event.subtype === "init")) return null
  if (/unknown option|unrecognized option|unknown argument/i.test(String(result.stderr || ""))) return null

  return { ...job, runtime_session_id: null }
}

// Prefix-matched by Claude Code: `Bash(git commit:*)` covers any git commit
// invocation and nothing else.
const GIT_TOOLS = GIT_VERBS.map((verb) => `Bash(git ${verb}:*)`)
// Off the surface for EVERY job: the git commands that destroy work, the
// built-in web tools (the bot's own web tools are the pre-approved MCP
// channel), and the runtime's own scheduling, sub-agent, workflow, plan-mode
// and question features — Configure My AI owns those needs, on every
// provider alike (shared.js BUILTIN_PLATFORM_TOOLS).
export const FORBIDDEN_TOOLS = [
  ...FORBIDDEN_GIT.map((command) => `Bash(${command}:*)`),
  ...builtinWebTools("claude_code"),
  ...builtinPlatformTools("claude_code")
]

function allowedToolsFor(job) {
  const tools = []
  if (job.workdir) tools.push(...FILE_TOOLS, ...GIT_TOOLS)
  if (job.github?.token) tools.push(`mcp__${GITHUB_MCP_SERVER}`)
  // The web channel is pre-approved by server name, the same way GitHub is —
  // this is what makes a headless fetch possible at all: the built-in
  // WebFetch prompts for a grant nobody is there to give.
  if (job.web?.token) tools.push(`mcp__${WEB_MCP_SERVER}`)
  return tools
}

// Inline JSON rather than a temp file — Claude Code is the one runtime of the
// three that takes MCP configuration as an argument, and an argument leaves
// nothing behind.
function mcpConfigFor(job) {
  return JSON.stringify({ mcpServers: mcpServersFor(job) })
}

// Exported so the argument list a repository turn actually runs with can be
// asserted, rather than trusted. What is allowed here is a security decision;
// it should not be reachable only through a spawned process.
export function baseArgs(job) {
  const args = []
  if (job.model) args.push(...CLI.model(job.model))
  const effort = effortFor(job)
  if (effort) args.push(...CLI.effort(effort))
  const plan = resumePlan(job)
  if (plan) args.push(...CLI.resume(plan.sessionId))
  // Verbatim. The server hands us system text that is already wire-ready —
  // the bot's [[CACHE-BOUNDARY]] markers stripped and its clock band moved
  // to the last user message — and it must reach Claude Code byte-for-byte:
  // this text sits in the cache-sensitive system layer, and one byte of
  // drift between turns re-writes the whole prefix at the 1-hour premium.
  if (job.system) args.push(...CLI.appendSystem(job.system))
  // Only when the job is anchored to a repository. A plain chat completion
  // gets no working directory and no elevated permission mode, so nothing
  // about this widens the ordinary path.
  if (job.workdir) {
    args.push(...CLI.permissionMode("acceptEdits"))
    // A session spanning several repositories has a checkout per repository,
    // and Claude Code confines its file tools and `cd` to the directories it
    // is told about. Without these grants the prompt says "work in the other
    // repository too" and the permission layer refuses it, with nobody
    // present to approve — the turn spends itself reporting that it is
    // blocked. Runner-validated paths only, and only alongside a workdir:
    // a chat with no checkout still gets no directories at all.
    for (const dir of job.extraWorkdirs || []) args.push(...CLI.addDir(dir))
  }

  // The GitHub tools are offered whenever the server sent credentials for
  // them, with or without a checkout: a session with no working tree still
  // can't push code, but it can open, edit, comment on and merge pull
  // requests, and being unable to do that was the original complaint.
  if (job.github?.token || job.web?.token) args.push(...CLI.mcpConfig(mcpConfigFor(job)))

  const allowed = allowedToolsFor(job)
  if (allowed.length > 0) args.push(...CLI.allowedTools(allowed))

  // Unconditional, unlike the allow list: a job with no grants at all still
  // must not be handed WebFetch, which it could never get approved. Stays
  // last, and the prompt still arrives on stdin, so there is no positional
  // for these variadic flags to swallow.
  args.push(...CLI.disallowedTools(FORBIDDEN_TOOLS))

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

// ---------------------------------------------------------------------------
// What a run cost, read off the `result` envelope.
//
// Two scopes on that envelope, and the difference is not cosmetic:
//
//   usage        the MAIN LOOP only. Excludes subagents and every "auxiliary"
//                call — compaction above all. A long repository run that
//                auto-compacts re-reads its whole context once per
//                compaction, and none of that is in here.
//   modelUsage   the whole query pipeline (main loop + subagents +
//                compaction), keyed by the id the CLI resolved to. The docs
//                say to prefer it for token and cost accounting, and so do we.
//
// The totals below are the per-model figures summed, never below what
// `usage` reports for the same bucket — a build that publishes modelUsage
// without one of its fields must not zero a count the main loop has. The
// additive keys are the server contract every local runtime feeds (see
// Api::Agent::V1::JobsController#result_params): absent means the CLI did
// not say, and absent is never written as 0.
//
//   cache_write_1h_tokens  usage.cache_creation.ephemeral_1h_input_tokens —
//                          the share of the writes made at the 1-hour TTL
//                          (2x input, the subscription default for the main
//                          conversation) rather than 5 minutes (1.25x). Only
//                          the main loop reports the split; everything else
//                          writes at 5m anyway.
//   reasoning_tokens       modelUsage[m].thinkingTokens summed (fallback:
//                          usage.output_tokens_details.thinking_tokens).
//                          INSIDE output_tokens, informational.
//   context_window         modelUsage[m].contextWindow of the model that did
//                          the work — the window Claude Code ENFORCED this
//                          session (plan, [1m], env overrides all folded
//                          in), which is what the meter should divide by.
//   total_cost_usd         the CLI's own list-price estimate (1h premium and
//                          geo multiplier included). Informational; never
//                          the wallet's business.
//   num_turns              agentic turns of the main loop ≈ API requests.
//   runtime_session_id     the transcript to --resume next turn.
//   model_label            the id the CLI actually ran (the dated build for
//                          Haiku, the family id for Sonnet 5).
// ---------------------------------------------------------------------------

function finite(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function modelEntries(modelUsage) {
  if (!modelUsage || typeof modelUsage !== "object") return []
  return Object.entries(modelUsage).filter(([, entry]) => entry && typeof entry === "object")
}

// The model that did the work: the entry with the most prompt traffic, ties
// to the first key — which is also the pre-existing behaviour for the
// single-model runs that are the ordinary case.
function mainEntry(entries) {
  let best = null
  let bestLoad = -1
  for (const [id, entry] of entries) {
    const load = (finite(entry.inputTokens) || 0) + (finite(entry.cacheReadInputTokens) || 0) +
                 (finite(entry.cacheCreationInputTokens) || 0)
    if (load > bestLoad) { best = [id, entry]; bestLoad = load }
  }
  return best
}

export function accountingFrom(result, { initModel = null } = {}) {
  if (!result || typeof result !== "object") return { usage: emptyUsage(), model: null }

  const usage = normalizeUsage(result.usage)
  const entries = modelEntries(result.modelUsage)
  const main = mainEntry(entries)

  if (entries.length > 0) {
    const sum = (key) => entries.reduce((total, [, entry]) => total + (finite(entry[key]) || 0), 0)
    usage.input_tokens = Math.max(usage.input_tokens, sum("inputTokens"))
    usage.output_tokens = Math.max(usage.output_tokens, sum("outputTokens"))
    usage.cache_read_input_tokens = Math.max(usage.cache_read_input_tokens, sum("cacheReadInputTokens"))
    usage.cache_creation_input_tokens = Math.max(usage.cache_creation_input_tokens, sum("cacheCreationInputTokens"))

    if (entries.some(([, entry]) => finite(entry.thinkingTokens) !== null)) usage.reasoning_tokens = sum("thinkingTokens")
    if (entries.some(([, entry]) => finite(entry.costUSD) !== null)) usage.total_cost_usd = sum("costUSD")

    const window = main ? finite(main[1].contextWindow) : null
    if (window > 0) usage.context_window = window
  }

  const oneHour = finite(result.usage?.cache_creation?.ephemeral_1h_input_tokens)
  if (oneHour !== null) usage.cache_write_1h_tokens = Math.min(Math.max(oneHour, 0), usage.cache_creation_input_tokens)

  if (usage.reasoning_tokens === undefined) {
    const thinking = finite(result.usage?.output_tokens_details?.thinking_tokens)
    if (thinking !== null) usage.reasoning_tokens = thinking
  }

  const cost = finite(result.total_cost_usd)
  if (cost !== null) usage.total_cost_usd = cost

  const turns = finite(result.num_turns)
  if (turns !== null && turns >= 0) usage.num_turns = turns

  const sessionId = String(result.session_id || "").trim()
  if (sessionId) usage.runtime_session_id = sessionId

  const ran = String(initModel || (main && main[0]) || "").trim()
  if (ran) usage.model_label = ran

  // The family id when the CLI names one (`claude-haiku-4-5` for the dated
  // build it resolved to), so per-model rows group under the id the picker
  // shows rather than splitting dated from undated.
  const model = main ? String(main[1].canonicalModel || main[0]) : null
  return { usage, model }
}

// The subscription's own usage bars, as Claude Code reports them after each
// request (`rate_limit_event`, stream-json only). The one true spend signal
// of a plan-funded runtime: `is_using_overage` marks a turn billed to usage
// credits — real money, and the point where Claude Code drops to the
// 5-minute cache TTL. Carried, not interpreted; the server stores it under
// metadata for the Usage page to show.
export function planUsageFrom(event) {
  const info = event?.rate_limit_info
  if (!info || typeof info !== "object") return null

  const out = {}
  const text = (value) => { const s = String(value || "").trim(); return s || undefined }
  const window = (raw) => {
    if (!raw || typeof raw !== "object") return undefined
    const entry = {}
    const utilization = finite(raw.utilization)
    const resetsAt = finite(raw.resetsAt)
    if (utilization !== null) entry.utilization = utilization
    if (resetsAt !== null) entry.resets_at = resetsAt
    return Object.keys(entry).length > 0 ? entry : undefined
  }

  out.status = text(info.status)
  out.rate_limit_type = text(info.rateLimitType)
  out.overage_status = text(info.overageStatus)
  if (typeof info.isUsingOverage === "boolean") out.is_using_overage = info.isUsingOverage
  out.five_hour = window(info.unifiedWindows?.five_hour)
  out.seven_day = window(info.unifiedWindows?.seven_day)

  for (const key of Object.keys(out)) if (out[key] === undefined) delete out[key]
  return Object.keys(out).length > 0 ? out : null
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
  // `system/init` names the id the CLI resolved the model to, before any
  // usage exists — the buffered envelope has no equivalent, which is why
  // accountingFrom takes it as an argument rather than reading it.
  let initModel = null
  let planUsage = null
  // How full the context window was on the LAST prompt of this run — the
  // number Claude Code's own meter shows, and the only one that answers "does
  // the next message still fit".
  //
  // It cannot come from the `result` event: that usage is the whole run
  // summed, every internal turn added together. A twenty-step run re-sends the
  // conversation twenty times, so reporting that sum as occupancy read as
  // "2,479,706 of 200,000 tokens — 100% context" on a session that never came
  // close to full. Each top-level `assistant` message carries the usage of the
  // prompt that produced it, and the last one is where the window actually
  // stands — including after a compaction, which makes this number FALL.
  let contextTokens = 0

  for (const event of events) {
    if (event?.type === "system" && event.subtype === "init" && event.model) initModel = String(event.model)
    // Last one wins: each is the plan's state after that request, and the
    // most recent is the one worth showing.
    if (event?.type === "rate_limit_event") planUsage = planUsageFrom(event) || planUsage

    if (event?.type === "assistant" && Array.isArray(event.message?.content)) {
      for (const block of event.message.content) {
        if (block?.type === "text" && block.text) assistantText.push(block.text)
      }
      if (event.message.model) out.model = event.message.model
      // Subagents run their own conversation in their own window, so their
      // occupancy says nothing about this one's. `parent_tool_use_id` is what
      // marks them, the same way it does for partial text deltas.
      if (!event.parent_tool_use_id && event.message.usage) {
        const occupancy = occupancyOf(event.message.usage)
        if (occupancy > 0) contextTokens = occupancy
      }
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
      // There's no top-level `model` field — the model that actually ran is
      // the key of `modelUsage` (its canonical id when it names one).
      const accounting = accountingFrom(event, { initModel })
      out.usage = accounting.usage
      out.model = accounting.model || firstKey(event.modelUsage) || out.model
    }
  }

  // Assigned after the loop, not inside it: the `result` event overwrites
  // `usage` wholesale and normally arrives last, so setting this earlier would
  // hand the server the run total under the per-turn name.
  out.usage.context_tokens = contextTokens
  if (planUsage) out.usage.plan_usage = planUsage

  // No terminal `result` event — the process died mid-stream. Whatever the
  // assistant had already said is still worth returning; it beats an empty
  // reply, and the caller decides whether a partial answer is acceptable.
  if (!out.content) out.content = assistantText.join("")
  return { ...out, sawResult }
}

// Which file, if any, this event WROTE.
//
// The same tool_use blocks describeEvent reads, asked a different question:
// not "what should the ticker say" but "what is now on disk that was not
// before". That list is how a document a run produced gets back to the web
// app at all — see documents.js.
//
// Writes only. A Read is not a deliverable, and neither is a Grep.
function writtenPathFrom(event) {
  if (event?.type !== "assistant") return null

  const blocks = event.message?.content
  if (!Array.isArray(blocks)) return null

  for (const block of blocks) {
    if (block?.type !== "tool_use") continue
    if (!["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(block.name)) continue

    const input = block.input || {}
    const path = input.file_path || input.notebook_path || input.path
    if (typeof path === "string" && path.trim()) return path.trim()
  }

  return null
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

  // The same envelope stream-json ends with, minus the per-turn events — so
  // the same accounting, minus the occupancy reading and the plan bars.
  const accounting = accountingFrom({ ...parsed, usage: parsed.usage || parsed.message?.usage })

  return {
    content: typeof content === "string" ? content : JSON.stringify(content),
    usage: accounting.usage,
    model: accounting.model || firstKey(parsed.modelUsage) || parsed.model || parsed.message?.model || null,
    stopReason: parsed.stop_reason || parsed.subtype || null,
    isError: parsed.is_error === true,
    errorStatus: parsed.api_error_status || null
  }
}

// ---------------------------------------------------------------------------
// Which Claude account a login actually resolves to.
//
// Two logins on one machine are only useful if you can tell them apart, and
// "which subscription just paid for that?" is not a question a label can
// answer — a label is what you typed, not what the CLI resolved. On macOS in
// particular the credential lives in the Keychain rather than in the
// per-profile directory, so two profiles CAN collapse into one account while
// their labels keep insisting otherwise. That failure is silent, it bills the
// wrong plan, and reading the account back is the only thing that catches it.
//
// What we read is deliberately narrow. `.claude.json` is Claude Code's own
// settings file and sits BESIDE the credential rather than holding it: the
// only keys touched here are the account's address and its org/account ids.
// Nothing in this file reads a token, and nothing here writes to the profile
// directory — the separation is still the security property.
// ---------------------------------------------------------------------------

// Claude Code keeps `.claude.json` at the root of its config directory, which
// is CLAUDE_CONFIG_DIR when set and the home directory otherwise. The XDG path
// is checked too because some builds honour it; a machine that has neither
// simply has no account to report, which is a fine answer.
function accountFilesFor(configDir) {
  const home = os.homedir()
  const dirs = configDir
    ? [configDir]
    : [process.env.CLAUDE_CONFIG_DIR, home, path.join(process.env.XDG_CONFIG_HOME || path.join(home, ".config"), "claude")]

  return dirs.filter(Boolean).map((dir) => path.join(dir, ".claude.json"))
}

// Pulled out so the parsing can be tested without a home directory to stage.
export function accountFromSettings(parsed) {
  const oauth = parsed?.oauthAccount
  const email = String(oauth?.emailAddress || "").trim()
  if (!email) return null

  return {
    email,
    // Two work accounts at the same company share a domain, so the org id is
    // what actually distinguishes them. Ids only — never a name we'd have to
    // keep in step with, and never anything that authenticates.
    organizationUuid: String(oauth.organizationUuid || "").trim() || null,
    accountUuid: String(oauth.accountUuid || "").trim() || null,
    source: "oauth"
  }
}

// `configDir` is the profile's CLAUDE_CONFIG_DIR, or null for the ambient
// login. Returns null rather than throwing for every "we couldn't tell":
// not knowing the account is a worse report than no report, but it is not a
// failure of the run, and a login that works must never be held back by it.
export function readAccount({ configDir = null } = {}) {
  for (const file of accountFilesFor(configDir)) {
    try {
      const account = accountFromSettings(JSON.parse(fs.readFileSync(file, "utf8")))
      if (account) return account
    } catch {
      // Missing, unreadable or not JSON — try the next candidate.
    }
  }

  // An API key is a different kind of login and worth saying so: it spends
  // per-token billing rather than a Claude plan, which is exactly the mix-up
  // this whole feature exists to prevent.
  if (process.env.ANTHROPIC_API_KEY) return { email: null, source: "api_key" }

  return null
}

// One short line for a terminal or a thinking log: "account: you@acme.com".
export function describeAccount(account) {
  if (!account) return null
  if (account.source === "api_key") return "account: an Anthropic API key"
  return account.email ? `account: ${account.email}` : null
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

  // "Which account is this?", answered by reading Claude Code's own settings
  // file rather than by trusting the label. See readAccount above.
  readAccount,
  describeAccount,
  maskAccount,

  versionArgs: ["--version"],
  loginArgs: () => ["/login"],
  loginHint: loginCommand("claude_code"),
  // The cheapest possible real request: if it answers at all, the login works.
  // One turn and no tools — a probe is a login check, not a session, and
  // every tool definition it carries is plan usage spent on nothing.
  probeArgs: () => [
    CLI.print, "Reply with the single word: ok", ...CLI.outputFormat,
    ...CLI.maxTurns(1), ...CLI.disallowedTools(["*"])
  ],

  // Headless Claude Code takes a single prompt rather than a message array, so
  // prior turns are rendered inline by the engine, and the prompt is fed on
  // stdin — see the note above CLI.allowedTools for why it is never an
  // argument.
  promptOnStdin: true,
  supportsBuffered: true,

  streamingArgs,
  bufferedArgs,
  // Only a resumed turn changes the prompt — see resumePlan.
  renderPrompt,
  // A resume whose transcript is gone is retried as an ordinary turn.
  fallbackJob,
  envFor: (job) => ({ ...envForGithub(job), ...envForWeb(job) }),
  describeEvent,
  collapseEvents,
  partialTextFrom,
  writtenPathFrom,
  parseBuffered,
  // `context.profileSlug` is the login this run actually used — see
  // loginCommand. Without it the message named a command that signs in a
  // different login than the one that just failed.
  classifyFailure: (detail, context = {}) =>
    classifyFailure(detail, { name: "Claude", loginHint: loginCommand("claude_code", context.profileSlug) }),

  resolveBin() {
    return locateBin({ cli: this.cli, envVar: this.binEnvVar, extraHomePaths: this.extraHomePaths })
  },

  advice() {
    const { bin, source } = this.resolveBin()
    return locationAdvice({ name: this.name, install: this.install, bin, source })
  }
}
