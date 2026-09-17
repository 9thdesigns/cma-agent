import { spawn } from "node:child_process"
import {
  classifyFailure, emptyUsage, locateBin, locationAdvice, shortCommand, shortPath
} from "./shared.js"

// ---------------------------------------------------------------------------
// Google's Antigravity CLI (`agy`) — the client Google moved its consumer
// tiers to when Gemini CLI stopped serving them (2026-06-18). A free Google
// account signs in and runs it, which makes this the one runtime here that
// costs nothing to try. Runs are funded by that account's plan quota and are
// never priced by the platform; what this adapter owes the server is an
// ACCURATE picture of what each run spent.
//
// Provenance, because it matters here more than for the other adapters: no
// `agy` build was available to this codebase when the adapter was written or
// rewritten. Every flag and field below comes from the official CHANGELOG
// (google-antigravity/antigravity-cli, 1.0.0 → 1.2.2), from the flag table
// agy's own shell completion generates off `--help`, and from stream captures
// third-party harnesses published for builds 1.1.13 through 1.2.2. The first
// version of this file guessed instead, and passed a flag agy does not have
// (`--non-interactive`) — every run and every login probe died at argument
// parsing, and the invented event shape would have reported empty answers
// and zero tokens had they not. Anything still unverified is marked so.
//
// The headless invocation (root flags; agy has no subcommand for print mode):
//
//   --prompt <text>               headless mode, one prompt, nargs 1 (`-p`)
//   --output-format stream-json   typed NDJSON, one event per stdout line
//   --print-timeout <duration>    agy's own turn clock; DEFAULT 5m0s, and a
//                                 turn past it is cut short — see printTimeout
//   --model <slug>                the slugs `agy models` prints — see modelFor
//   --add-dir <path>              scope the run to the checkout (agy keeps its
//                                 own workspace mapping; cwd alone is not it)
//   --conversation <id>           resume a conversation agy already holds
//   --disable-slash-commands      a prompt starting with `/` is a prompt, not
//                                 a slash command (1.1.9+)
//   --mode=accept-edits           skip the interactive edit review. NOT a
//                                 headless write grant — see the note below
//   --output-format json models   the live catalogue, and the login probe:
//                                 root flag BEFORE the subcommand (the other
//                                 order fails "flags provided but not defined")
//
// ── Writes, stated rather than hidden ──────────────────────────────────────
//
// `--mode=accept-edits` looks like Claude Code's `acceptEdits` and is not:
// it skips the diff review, and the PERMISSION check for `write_file` still
// applies. A headless run has nobody to approve, so agy auto-denies the
// write (exit 0, status SUCCESS, empty response, `denied_actions:
// [write_file]`, a stderr note naming the missing rule). The real grant is an
// allow rule — `write_file(<folder>)` under `permissions.allow` in
// ~/.gemini/antigravity-cli/settings.json — and that file is the user's own;
// this companion never writes into it. So a repository turn can read the
// checkout on every machine and edit it only where the user has added that
// one rule. The other grant agy offers (`--dangerously-skip-permissions`)
// approves shell too, which is handing a coding turn the whole machine, and
// is never used here.
//
// git is behind approval in every mode, so the companion's own `git.push`
// command (src/repos.js) ships the work, as it does for Gemini CLI. No MCP
// wiring: agy discovers MCP servers from its own config directory, and the
// mechanism to relocate that directory is unverified.
// ---------------------------------------------------------------------------

const CLI = {
  prompt: (text) => ["--prompt", text],
  streamFormat: ["--output-format", "stream-json"],
  jsonFormat: ["--output-format", "json"],
  model: (id) => ["--model", id],
  printTimeout: (duration) => ["--print-timeout", duration],
  addDir: (dir) => ["--add-dir", dir],
  conversation: (id) => ["--conversation", id],
  disableSlash: "--disable-slash-commands",
  // One token on purpose, and last in argv: it is the one flag the engine's
  // degraded retry strips (CAPABILITY_FLAGS), and the stripper treats the
  // tokens after a flag as its values until the next `-`.
  acceptEdits: "--mode=accept-edits",
  models: "models"
}

// agy's print mode has a clock of its own. A turn that outlives
// --print-timeout (default 5m0s) is cut: before 1.1.28 as
// {"status":"ERROR","error":"timeout waiting for response"}, since 1.1.28 as
// a partial answer with a stderr warning. Five minutes is shorter than one
// test suite. The companion's contract is silence (IDLE_TIMEOUT_MS) plus a
// far-off reaping ceiling (MAX_RUN_MS), so agy's clock is set to that ceiling
// and can never fire first. The same environment override the engine honours
// is read here rather than imported — engine.js imports the runtimes, and a
// runtime importing engine.js back would be a cycle. `0` is NOT "disabled"
// for agy (it means "instantly"), which is why the floor is one minute.
const DEFAULT_MAX_RUN_MS = 4 * 60 * 60 * 1000

export function printTimeout(env = process.env) {
  const configured = Number(env.CMA_MAX_RUN_MS)
  const ms = Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_MAX_RUN_MS
  return `${Math.max(1, Math.ceil(ms / 60000))}m`
}

// ---------------------------------------------------------------------------
// Model slugs and the effort dial.
//
// agy serves its Gemini families as effort TIERS with their own slugs —
// `gemini-3.7-flash-low|medium|high`, `gemini-3.1-pro-low|high` — and that
// slug is what `--model` wants. A bare family (`gemini-3.7-flash`) is taken
// by 1.1.13 and refused by 1.2.2 ("requires --effort"); the tiered slug is
// taken by both, so it is always what goes on the wire, and `--effort` is
// never sent.
//
// The platform's dial (job.effort, Ai::Effort's low…max) picks the tier
// WITHIN the family the user chose. It never changes the family: Flash to
// Pro is a different quota rung, and an effort setting must not quietly buy
// the dearer one. Claude and GPT-OSS ids under Antigravity carry no dial
// (`claude-opus-4-6-thinking` is one fixed model) and pass through as picked.
// The tier only changes how much the model thinks, never the rate the plan
// meters it at, which is why swapping it is safe in both directions.
// ---------------------------------------------------------------------------
const TIERED_FAMILY = /^(gemini-\d+\.\d+-(flash|pro))(?:-(low|medium|high))?$/
const FAMILY_TIERS = { flash: ["low", "medium", "high"], pro: ["low", "high"] }
// agy's own picker default for Flash since 1.1.26; Pro's UI default is High.
const DEFAULT_TIER = { flash: "medium", pro: "high" }
const EFFORT_TIER = { low: "low", medium: "medium", high: "high", xhigh: "high", max: "high" }

export function modelFor(model, effort) {
  const id = String(model || "").trim()
  if (!id) return null

  const match = TIERED_FAMILY.exec(id)
  if (!match) return id

  const [, family, kind, picked] = match
  const tiers = FAMILY_TIERS[kind]
  const wanted = EFFORT_TIER[String(effort || "").trim().toLowerCase()]
  // A tier the family does not have (Pro has no medium) keeps what the user
  // picked rather than guessing a direction; a bare family gets the default.
  const tier = (wanted && tiers.includes(wanted) ? wanted : null) || picked || DEFAULT_TIER[kind]
  return `${family}-${tier}`
}

// ---------------------------------------------------------------------------
// Conversation continuity.
//
// Every event agy emits names its conversation (`conversation_id`), and
// `--conversation <id>` continues one agy already holds: the transcript stays
// with agy and the turn sends only what is new, instead of the whole history
// re-rendered into --prompt (O(history) → O(delta) on the wire, and agy's
// own prompt cache keeps the prefix). The id is reported back as
// usage.runtime_session_id; the server offers it again as
// job.runtime_session_id only when it judged the resume safe (the claude_code
// audit doc, §4), and it still sends the FULL messages list — so a resumed
// turn trims to the turns after the last assistant reply, bare, because the
// system text was part of the first turn and agy holds it.
//
// Read defensively: an older server never sends the key; a history with no
// assistant reply, or nothing new after the last one, has nothing to resume
// WITH and the turn runs fresh; and the id goes on argv, so only a plain
// token is accepted. Under a resume `result.usage` is cumulative for the
// whole conversation — collapseEvents sums the per-step figures instead.
// What an unknown id does on a real build (the CHANGELOG describes a fresh
// conversation with a warning) has not been exercised here; the id the
// stream names is the one reported, so the next turn follows whatever agy
// actually did.
// ---------------------------------------------------------------------------
function newMessagesSince(job) {
  const messages = Array.isArray(job?.messages) ? job.messages : []
  let lastAssistant = -1
  messages.forEach((message, index) => { if (message?.role === "assistant") lastAssistant = index })
  return lastAssistant < 0 ? [] : messages.slice(lastAssistant + 1)
}

export function resumeIdOf(job) {
  const id = String(job?.runtime_session_id ?? "").trim()
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(id)) return null
  return newMessagesSince(job).length > 0 ? id : null
}

function renderMessages(messages) {
  return messages
    .map((message) => (typeof message.content === "string" ? message.content : JSON.stringify(message.content)))
    .join("\n\n")
}

export function baseArgs(job) {
  const args = [...CLI.streamFormat, ...CLI.printTimeout(printTimeout()), CLI.disableSlash]

  const model = modelFor(job.model, job.effort)
  if (model) args.push(...CLI.model(model))

  const resume = resumeIdOf(job)
  if (resume) args.push(...CLI.conversation(resume))

  if (job.workdir) args.push(...CLI.addDir(job.workdir), CLI.acceptEdits)
  return args
}

// The whole prompt travels as the value of --prompt (nargs 1), so there is no
// positional for anything to swallow. Same ARG_MAX caveat as Gemini: a very
// long history is bounded by argv (~1–2MB, and 128 KiB per single argument
// on Linux), and the server compacts before it gets close. agy 1.1.15+ can
// take the prompt on stdin (`--input-format stream-json`), which lifts that
// ceiling; not adopted until it is exercised on a real build.
export function streamingArgs(job, prompt = "") {
  return [...CLI.prompt(prompt), ...baseArgs(job)]
}

// No system-prompt flag exists for agy (probed and rejected on 1.1.0:
// `--system-prompt`, `--append-system-prompt`), so the system text rides the
// prompt — visibly fenced, so a model reading it can tell the operator's
// instructions from the conversation, and FIRST, so the byte-stable part of
// every turn is the prefix agy's server-side prompt cache can hit. On a
// resumed conversation only the new turns go, bare — see resumeIdOf.
export function renderPrompt(job, conversation) {
  if (resumeIdOf(job)) return renderMessages(newMessagesSince(job))
  if (!job.system) return conversation
  return `<system>\n${job.system}\n</system>\n\n${conversation}`
}

// ---------------------------------------------------------------------------
// The event stream, as agy emits it: one JSON object per line, discriminated
// by `event` (not `type`), with the payload nested under a key named after
// the event —
//
//   {"event":"init","conversation_id":"c3b6…",
//    "init":{"model":"gemini-3.7-flash-medium","cwd":"/repo","tools":[…],
//            "permission_mode":"request-review"}}
//   {"event":"step_update","conversation_id":"c3b6…",
//    "step_update":{"step_index":3,"state":"ACTIVE","step_type":"tool",
//                   "tool_name":"view_file",
//                   "tool_info":{"name":"view_file","parameters":{"AbsolutePath":"/repo/a.txt"}}}}
//   {"event":"step_update",…,"step_update":{"step_index":4,"state":"ACTIVE",
//                   "step_type":"agent_response","text_delta":"Hello "}}
//   {"event":"step_update",…,"step_update":{"step_index":4,"state":"DONE",
//                   "step_type":"agent_response","text_delta":"\n","duration_seconds":2.1,
//                   "usage":{"input_tokens":2561,"output_tokens":554,"thinking_tokens":120,
//                            "cache_read_tokens":8174,"total_tokens":3115}}}
//   {"event":"result","conversation_id":"c3b6…",
//    "result":{"status":"SUCCESS","response":"Hello\n","error":"","duration_seconds":9.8,
//              "num_turns":1,"usage":{…},"denied_actions":[]}}
//
// step_type is a closed vocabulary (CHANGELOG 1.1.8): user_input,
// agent_response, tool, checkpoint, subagent, system_message, error_message;
// state is ACTIVE | DONE | ERROR. Answer text arrives ONLY as `text_delta` on
// agent_response steps, in chunks — concatenated, never deduplicated. Tool
// parameters use Antigravity's PascalCase names (AbsolutePath, TargetFile,
// CommandLine, DirectoryPath, Query, Pattern).
//
// Read defensively all the same: this is another product's format, and a
// build that renames a field should cost us the ticker line, never the
// answer.
// ---------------------------------------------------------------------------

function kindOf(event) {
  return event && typeof event === "object" ? String(event.event || "") : ""
}

function payloadOf(event, kind) {
  if (kindOf(event) !== kind) return null
  const payload = event[kind]
  return payload && typeof payload === "object" ? payload : null
}

const stepOf = (event) => payloadOf(event, "step_update")
const resultOf = (event) => payloadOf(event, "result")
const initOf = (event) => payloadOf(event, "init")

function stepType(step) {
  return String(step?.step_type || "").toLowerCase()
}

function stepDelta(step) {
  const text = step?.text_delta
  return typeof text === "string" && text ? text : null
}

// ---------------------------------------------------------------------------
// Token counts.
//
// agy reports the same five fields on every DONE agent_response step and on
// the result: input_tokens, output_tokens, thinking_tokens, cache_read_tokens,
// total_tokens (cache_write_tokens is declared by one third-party adapter and
// has never been seen in a capture — read when present, 0 otherwise). Two
// facts about them decide the mapping, both from real-build arithmetic:
//
//   cache_read_tokens is ADDITIVE. kivio, agy 1.1.26: input=5969 out=554
//   cache=8132 total=6523 — total = input + output, the cache count sits
//   OUTSIDE input_tokens and exceeds it on a warm prompt. That is Anthropic's
//   convention and the companion's canonical shape, so it maps straight onto
//   cache_read_input_tokens with nothing subtracted.
//
//   thinking_tokens is INSIDE output_tokens. kernelbench: input + output ==
//   total with thinking present; multica: "must not be added again". It is
//   carried as reasoning_tokens for the Usage page and never added to
//   anything.
//
// And one about WHERE they appear: each step's usage is that model call;
// `result.usage` is cumulative for the CONVERSATION, which under
// --conversation includes every earlier turn (DwarfAI 1.1.26: turn-2 step
// 4,739 vs result 21,524). So the run's spend is the sum of its steps, and
// the result is the fallback for a build whose steps carry no usage.
// ---------------------------------------------------------------------------
function usageFrom(raw) {
  if (!raw || typeof raw !== "object") return null
  if (raw.input_tokens === undefined && raw.output_tokens === undefined) return null

  const usage = {
    input_tokens: Number(raw.input_tokens || 0),
    output_tokens: Number(raw.output_tokens || 0),
    cache_read_input_tokens: Number(raw.cache_read_tokens || 0),
    cache_creation_input_tokens: Number(raw.cache_write_tokens || 0)
  }
  // Present only when the wire said so: absent means "not reported", and
  // the server treats it that way, which a 0 would not.
  if (raw.thinking_tokens !== undefined) usage.reasoning_tokens = Number(raw.thinking_tokens || 0)
  return usage
}

const COUNTS = ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"]

function sumUsage(entries) {
  if (entries.length === 0) return null
  const total = Object.fromEntries(COUNTS.map((key) => [key, 0]))
  let reasoning = null
  for (const entry of entries) {
    for (const key of COUNTS) total[key] += entry[key]
    if (entry.reasoning_tokens !== undefined) reasoning = (reasoning || 0) + entry.reasoning_tokens
  }
  if (reasoning !== null) total.reasoning_tokens = reasoning
  return total
}

function spendOf(usage) {
  return COUNTS.reduce((sum, key) => sum + (usage?.[key] || 0), 0)
}

// How full the window was on one prompt: every input-side count of that
// call, the same arithmetic as shared.js#occupancyOf.
function occupancy(usage) {
  return usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens
}

// The window is not on agy's wire. For the Gemini line it is the API's own
// figure — 1,048,576 on every 3.x slug, where the official Vertex pricing
// page and LiteLLM agree — and the meter prefers a reported window over its
// own table. Claude and GPT-OSS under Antigravity have no verified figure
// (one registry says 250,000 for Claude), so they report nothing rather than
// a guess, and the server keeps its own number.
const GEMINI_CONTEXT_WINDOW = 1_048_576

export function contextWindowFor(model) {
  return /^gemini-/.test(String(model || "")) ? GEMINI_CONTEXT_WINDOW : null
}

const OK_STATUSES = new Set(["SUCCESS", "OK"])

function deniedNames(result) {
  const denied = Array.isArray(result?.denied_actions) ? result.denied_actions : []
  return denied
    .map((entry) => String(entry?.action || entry?.display_name || entry?.name || entry || "").trim())
    .filter(Boolean)
}

// The message for a turn agy finished without doing anything, because every
// action it wanted was permission-gated. Names the rule that fixes it, so the
// user reads one line instead of a transcript of nothing.
function deniedMessage(names) {
  const list = names.join(", ")
  const edit = names.some((name) => /write|replace|edit/i.test(name))
  return `Antigravity auto-denied ${list} — headless runs need an allow rule under permissions.allow ` +
         `in ~/.gemini/antigravity-cli/settings.json` +
         (edit ? " (for edits: write_file(<the shared folder>))." : ".")
}

function collapseEvents(events) {
  const out = {
    content: "", usage: emptyUsage(), model: null,
    stopReason: null, isError: false, errorStatus: null
  }

  let result = null
  let conversationId = null
  let stepError = null
  let lastResponse = null           // usage of the last agent_response step
  const deltas = []
  const stepUsage = new Map()       // step_index → usage; last value per index wins

  for (const event of events) {
    if (!event || typeof event !== "object") continue
    if (event.conversation_id) conversationId = String(event.conversation_id)

    const init = initOf(event)
    if (init) {
      if (init.model) out.model = String(init.model)
      continue
    }

    const step = stepOf(event)
    if (step) {
      const kind = stepType(step)
      if (kind === "agent_response") {
        const text = stepDelta(step)
        if (text) deltas.push(text)
        const usage = usageFrom(step.usage)
        if (usage) {
          stepUsage.set(step.step_index ?? `anonymous-${stepUsage.size}`, usage)
          lastResponse = usage
        }
      } else if (kind === "error_message" || String(step.state || "").toUpperCase() === "ERROR") {
        const detail = step.text_delta ?? step.error ?? step.message ?? step.tool_info?.error
        if (!stepError && typeof detail === "string" && detail) stepError = detail.slice(0, 300)
      }
      continue
    }

    const res = resultOf(event)
    if (res) {
      result = res
      if (res.conversation_id) conversationId = String(res.conversation_id)
      continue
    }

    if (kindOf(event) === "error") {
      const detail = event.error?.message ?? event.error ?? event.message
      if (!out.errorStatus && detail) out.errorStatus = String(detail).slice(0, 300)
    }
  }

  const streamed = deltas.join("")

  if (result) {
    const status = String(result.status || "").toUpperCase()
    const response = typeof result.response === "string" ? result.response : ""
    const error = typeof result.error === "string"
      ? result.error
      : String(result.error?.message || "")
    const timedOut = status === "TIMEOUT" || /timeout waiting for response/i.test(error)
    const denied = deniedNames(result)

    out.stopReason = status ? status.toLowerCase() : null

    if (OK_STATUSES.has(status) || (!status && !error)) {
      // The terminal copy of the answer when there is one; the streamed
      // deltas are the same text and stand in when a build leaves it out.
      out.content = response || streamed
      if (error) out.errorStatus = error.slice(0, 300)
    } else if (response) {
      // `status` describes the CONVERSATION, not the turn: a 503 agy retried
      // mid-turn leaves ERROR beside a complete answer (shipit, 1.2.2), and a
      // resumed conversation can carry the previous turn's error. The answer
      // is the answer; the status becomes a note.
      out.content = response
      out.errorStatus = (error || status).slice(0, 300)
    } else {
      out.isError = true
      out.errorStatus = timedOut
        ? `Antigravity's own turn clock expired before the answer (--print-timeout ${printTimeout()}). ${error}`.trim()
        : (error || stepError || out.errorStatus || `Antigravity reported ${status || "no status"}.`).slice(0, 300)
    }

    // SUCCESS, exit 0, nothing said, and a list of actions agy refused: the
    // turn wanted to edit and could not. Reported as the permission failure
    // it is, with the rule that fixes it, instead of "produced no answer".
    if (!out.content && !out.isError && denied.length > 0) {
      out.isError = true
      out.errorStatus = deniedMessage(denied)
    }
  } else {
    out.content = streamed
    if (!out.content && stepError) {
      out.isError = true
      out.errorStatus = stepError
    }
  }

  // The run's spend: the steps summed, because that is right whether or not
  // this turn continued a conversation. One exception, read off the result
  // itself: on a fresh conversation (num_turns ≤ 1) the result can never
  // legitimately exceed the sum, so a larger result means a build whose steps
  // did not all carry usage, and the complete figure wins.
  const summed = sumUsage([...stepUsage.values()])
  const reported = usageFrom(result?.usage)
  const resumed = Number(result?.num_turns) > 1
  let spend = summed
  if (!spend || (!resumed && reported && spendOf(reported) > spendOf(summed))) spend = reported || summed
  if (spend) Object.assign(out.usage, spend)

  // Occupancy is the LAST prompt on its own — the last agent_response step's
  // input side — never the totals above (shared.js#lastTurnOccupancy explains
  // why the cumulative object must not be read as a turn). 0 when no step
  // reported usage, and 0 draws no meter.
  if (lastResponse) out.usage.context_tokens = occupancy(lastResponse)

  // The additive contract keys (see PHASE2-runtimes): sent only when the wire
  // said something, so absence keeps meaning "unknown".
  if (result && result.num_turns !== undefined && Number.isFinite(Number(result.num_turns))) {
    out.usage.num_turns = Number(result.num_turns)
  }
  if (conversationId) out.usage.runtime_session_id = conversationId
  if (out.model) out.usage.model_label = out.model
  const window = contextWindowFor(out.model)
  if (window) out.usage.context_window = window

  return { ...out, sawResult: result !== null }
}

// ---------------------------------------------------------------------------
// The ticker.
// ---------------------------------------------------------------------------

function toolNameOf(step) {
  return String(step.tool_name || step.tool_info?.name || "")
}

function toolParamsOf(step) {
  const params = step.tool_info?.parameters ?? step.tool_info?.args ?? step.parameters
  return params && typeof params === "object" ? params : {}
}

function fileOf(params) {
  return shortPath(
    params.AbsolutePath || params.TargetFile || params.DirectoryPath || params.SearchDirectory ||
    params.path || params.file_path || ""
  )
}

const WRITE_TOOLS = new Set(["write_to_file", "write_file", "replace_file_content", "multi_replace_file_content"])

function describeTool(step) {
  const name = toolNameOf(step)
  const params = toolParamsOf(step)
  const file = fileOf(params)

  switch (name) {
    case "write_to_file":
    case "write_file":                  return file ? `Writing ${file}` : "Writing a file"
    case "replace_file_content":
    case "multi_replace_file_content":  return file ? `Editing ${file}` : "Editing a file"
    case "view_file":
    case "view_code_item":
    case "view_file_outline":
    case "read_file":                   return file ? `Reading ${file}` : "Reading a file"
    case "list_dir":                    return file ? `Looking in ${file}` : "Looking for files"
    case "run_command": {
      const cmd = shortCommand(params.CommandLine || params.command || "")
      return cmd ? `Running ${cmd}` : "Running a command"
    }
    case "grep_search":
    case "find_by_name":
    case "codebase_search": {
      const pattern = String(params.Query || params.Pattern || params.query || params.pattern || "")
        .trim().slice(0, 40)
      return pattern ? `Searching for ${pattern}` : "Searching the code"
    }
    case "read_url":                    return "Reading a page"
    case "search_web":                  return "Searching the web"
    default: {
      const pretty = name.replace(/_/g, " ").trim()
      return pretty ? `${pretty.charAt(0).toUpperCase()}${pretty.slice(1)}`.slice(0, 60) : "Working"
    }
  }
}

function describeEvent(event) {
  if (initOf(event)) return "Starting up"

  const step = stepOf(event)
  if (!step) return null

  const kind = stepType(step)
  if (kind === "tool") return describeTool(step)
  if (kind === "subagent") return "Delegating to a sub-agent"
  // Not in agy's step vocabulary today; kept so a build that adds it reads
  // as liveness rather than silence.
  if (kind.includes("thinking") || kind.includes("reasoning")) return "Thinking"
  // agent_response is the partial-text channel; checkpoint, user_input,
  // system_message and error_message are not things a person is waiting on.
  return null
}

function partialTextFrom(event) {
  const step = stepOf(event)
  return step && stepType(step) === "agent_response" ? stepDelta(step) : null
}

// A file this run wrote, for document collection. Only a DONE write-tool
// step counts: the ACTIVE one is intent, the ERROR one is a denial.
function writtenPathFrom(event) {
  const step = stepOf(event)
  if (!step || stepType(step) !== "tool") return null
  if (String(step.state || "").toUpperCase() !== "DONE") return null
  if (!WRITE_TOOLS.has(toolNameOf(step))) return null

  const params = toolParamsOf(step)
  const target = String(params.TargetFile || params.AbsolutePath || params.path || "").trim()
  return target || null
}

// ---------------------------------------------------------------------------
// The catalogue and the login probe — one zero-token call for both.
//
// `agy --output-format json models` answers without starting an agent turn,
// spending quota, or leaving a conversation behind (CHANGELOG 1.1.11/1.1.12),
// and needs a signed-in account — which is exactly what a login probe wants
// to know. The old probe spent a model turn asking for the word "ok".
//
// Envelope, verified on a 1.1.13 capture:
//   {"status":"SUCCESS","response":"<id>\t<label>\n…",
//    "command":{"name":"models","data":{"models":[{"id":"gemini-3.7-flash-high",
//                                                    "label":"Gemini 3.7 Flash (High)"},…]}}}
// Progress goes to stderr since 1.1.12; before that a status line preceded
// the payload on stdout, which is why the envelope is the LAST parseable
// line rather than the first. An unsigned-in agy printed "Please sign in…"
// and exited 0 on 1.1.0 — the exit code alone proves nothing.
// ---------------------------------------------------------------------------
const PROBE_TIMEOUT_MS = 20000
const MODELS_TIMEOUT_MS = 30000

export function envelopeFrom(stdout) {
  const lines = String(stdout || "").split("\n").map((line) => line.trim()).filter(Boolean)
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].startsWith("{")) continue
    try {
      const parsed = JSON.parse(lines[i])
      if (parsed && typeof parsed === "object") return parsed
    } catch {
      // A status line that happens to start with a brace. Keep looking.
    }
  }
  return null
}

const SLUG = /^[a-z0-9][a-z0-9._-]+$/

export function modelsFrom(stdout) {
  const envelope = envelopeFrom(stdout)
  const ids = []

  const listed = envelope?.command?.data?.models
  if (Array.isArray(listed)) {
    for (const entry of listed) {
      const id = String(entry?.id || "").trim()
      if (id) ids.push(id)
    }
  }

  // Plain `agy models` (and the envelope's own `response`): "<id>\t<label>"
  // rows, possibly after a status line.
  if (ids.length === 0) {
    const text = typeof envelope?.response === "string" ? envelope.response : String(stdout || "")
    for (const line of text.split("\n")) {
      if (!line.includes("\t")) continue
      const id = line.split("\t")[0].trim()
      if (SLUG.test(id)) ids.push(id)
    }
  }

  return Array.from(new Set(ids)).sort()
}

const SIGN_IN = /sign(ed)? in|log ?in|not authenticated|unauthenticated|unauthori[sz]ed|credential|expired|oauth/i
const UNKNOWN_FLAG = /flags? provided but not defined/i

export function probeOutcome({ code, stdout, stderr } = {}) {
  const envelope = envelopeFrom(stdout)
  const status = String(envelope?.status || "").toUpperCase()
  const error = String(envelope?.error || "")
  const text = `${stderr || ""}\n${stdout || ""}`

  if (OK_STATUSES.has(status)) {
    if (modelsFrom(stdout).length > 0) return { status: "ready" }
    return SIGN_IN.test(text) ? { status: "logged_out" } : { status: "ready" }
  }
  if (SIGN_IN.test(error) || SIGN_IN.test(text)) return { status: "logged_out" }
  if (UNKNOWN_FLAG.test(text)) {
    return { status: "unknown", detail: "this agy build predates `--output-format json models`; upgrade Antigravity" }
  }
  if (code === 0) return { status: "ready" }
  return { status: "unknown", detail: (error || stderr || "").trim().slice(0, 200) }
}

// A subcommand run to completion. stdin is closed at once: agy's subcommands
// hung on an inherited open stdin before 1.1.23.
function runAgy(bin, args, { timeoutMs }) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(bin, args, { env: process.env, stdio: ["pipe", "pipe", "pipe"] })
    } catch (spawnError) {
      return resolve({ code: -1, stdout: "", stderr: "", spawnError })
    }

    let stdout = ""
    let stderr = ""
    let timedOut = false
    let settled = false

    const finish = (code, spawnError) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code, stdout, stderr, timedOut, spawnError })
    }
    const timer = setTimeout(() => {
      timedOut = true
      try { child.kill("SIGKILL") } catch { /* already gone */ }
    }, timeoutMs)

    try { child.stdin.on("error", () => {}); child.stdin.end() } catch { /* the error event carries it */ }
    child.stdout.on("data", (chunk) => { stdout += chunk })
    child.stderr.on("data", (chunk) => { stderr += chunk })
    child.on("error", (error) => finish(-1, error))
    child.on("close", (code) => finish(code))
  })
}

// Rate limits and expired logins in agy's own words, on top of the shared
// vocabulary: the Gemini backend's RESOURCE_EXHAUSTED / 429, agy's "quota
// reached" and "Out of credits", and "Please sign in". The engine hands this
// `result.error` or stderr — never model prose, which is where false
// cooldowns come from.
const AGY_RATE_LIMITED = /resource_exhausted|\b429\b|quota (?:reached|exhausted)|out of credits/i
const AGY_SIGN_IN = /please sign in|not signed in|sign in again/i

function classifyAgyFailure(detail) {
  const text = String(detail || "")
  if (AGY_RATE_LIMITED.test(text)) {
    return new Error(`Your Antigravity plan is rate limited or out of included usage right now. ${text}`)
  }
  if (AGY_SIGN_IN.test(text)) {
    return new Error(`That Antigravity login needs signing in again (run \`agy\` once to sign in). ${text}`)
  }
  return classifyFailure(text, { name: "Antigravity", loginHint: "run `agy` once to sign in" })
}

export const antigravity = {
  id: "antigravity",
  name: "Antigravity",
  cli: "agy",
  install: "https://antigravity.google/docs/cli",
  binEnvVar: "CMA_AGY_BIN",
  // The official installer writes ~/.local/bin/agy, which HOME_BIN_DIRS
  // already sweeps; the earlier vendor-specific guess here was never read off
  // an install.
  extraHomePaths: [],

  // agy keeps its login in the device keyring / its own config directory.
  // Hidden root flags to relocate that directory exist in the flag table
  // (`--gemini_dir`, `--app_data_dir`) but are unverified against a real
  // sign-in, so this build supports exactly one Antigravity login per
  // machine, the ambient one, rather than pretending to isolate profiles it
  // cannot. Same stance, same reason, as Gemini CLI.
  configDirEnvVar: null,
  multiLogin: false,
  ambientProfile: true,
  profilesDirName: "antigravity-profiles",

  versionArgs: ["--version"],
  loginArgs: () => [],
  loginHint: "run `agy` once and complete the Google sign-in",
  // Root flag first: `agy models --output-format json` is rejected.
  probeArgs: () => [...CLI.jsonFormat, CLI.models],

  // The prompt is the value of --prompt, not stdin — see streamingArgs.
  promptOnStdin: false,
  supportsBuffered: false,

  streamingArgs,
  renderPrompt,
  envFor: () => ({}),
  describeEvent,
  collapseEvents,
  partialTextFrom,
  writtenPathFrom,
  classifyFailure: (detail) => classifyAgyFailure(detail),

  // What this runtime cannot do, in a form the CLI can print.
  limitations: [
    "Repository turns can read the shared folder; editing it needs one rule in your own " +
      "~/.gemini/antigravity-cli/settings.json — write_file(<that folder>) under permissions.allow — " +
      "because agy's headless mode auto-denies writes and this companion never edits that file.",
    "Repository turns cannot run git — the machine pushes for them.",
    "The GitHub pull-request and cma web tools are not available: agy only reads MCP config from " +
      "its own ~/.gemini directory, which is the user's own and not ours to write into. Every " +
      "other coding runtime here mounts them.",
    "One Antigravity login per machine.",
    "agy's own web tools (read_url, search_web) stay on the surface — there is no flag to remove " +
      "them; headless mode auto-denies the permission-gated ones, after the model has asked."
  ],

  resolveBin() {
    return locateBin({ cli: this.cli, envVar: this.binEnvVar, extraHomePaths: this.extraHomePaths })
  },

  advice() {
    const { bin, source } = this.resolveBin()
    return locationAdvice({ name: this.name, install: this.install, bin, source })
  },

  // Signed in and usable? Read off the models envelope, not the exit code.
  async probe() {
    const { bin } = this.resolveBin()
    if (!bin) return { status: "not_installed" }

    const result = await runAgy(bin, this.probeArgs(), { timeoutMs: PROBE_TIMEOUT_MS })
    if (result.spawnError) {
      return { status: "unknown", detail: String(result.spawnError.message || result.spawnError).slice(0, 200) }
    }
    if (result.timedOut) return { status: "unknown", detail: "agy did not answer within 20s" }
    return probeOutcome(result)
  },

  // The machine's own catalogue — the only trustworthy source of agy's slugs
  // (backend ids, CLI slugs and labels all differ, and the generations rotate
  // monthly). Reported per device; the seed in AiCredential::LOCAL_RUNTIMES
  // is the fallback until the server prefers a reported list.
  //
  // Not flagged `reportsModels` yet: the server stores a reported list per
  // device but merges it into the picker only for BYO-model runtimes
  // (Ollama), so flipping this today would only cost the seed. The call is
  // wired and tested against the 1.1.13 capture; flip it when the server
  // prefers a reported list for a seeded runtime (audit doc, "what remains").
  reportsModels: false,
  async listModels() {
    const { bin } = this.resolveBin()
    if (!bin) return []

    const result = await runAgy(bin, [...CLI.jsonFormat, CLI.models], { timeoutMs: MODELS_TIMEOUT_MS })
    return result.spawnError || result.timedOut ? [] : modelsFrom(result.stdout)
  }
}
