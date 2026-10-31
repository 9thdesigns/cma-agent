import fs from "node:fs"
import path from "node:path"

import {
  builtinPlatformTools, builtinWebTools, classifyFailure, emptyUsage, envForGithub, envForWeb, GITHUB_MCP_SERVER,
  hostWorkspaceToolsFor, lastTurnOccupancy, locateBin, locationAdvice, mcpServersFor, normalizeUsage,
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
//   --resume / -r        string (0.61.0-nightly.20260908 source). "Resume a
//                        previous session. Use \"latest\" for most recent or
//                        index number" — and, per the CLI's own error text, a
//                        session uuid: "--resume {number}, --resume {uuid}, or
//                        --resume latest". Mutually exclusive with
//                        --session-id and --session-file.
//
// What is NOT there: an effort, thinking, reasoning or budget flag. None of
// the 54 `.option(...)` names in the 0.64.0 bundle's yargs definitions (the
// main command and its subcommands) is one, so this adapter sends the
// composer's effort level nowhere — and the server's menu
// knows it (Ai::Effort::RUNTIMES_WITHOUT_DIAL), so a Gemini composer shows no
// dial instead of one whose every stop ran at the CLI's default.
// test/services/ai/effort_menu_test reads this file: the day code here starts
// sending a level, that test asks for the dial back.
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
//
// ── …and the door 0.60 closed ──────────────────────────────────────────────
//
// From Gemini CLI 0.60 (0.64.0's _doLoadSettings → loadSystemFile →
// isFileAndDirectorySecureSync) a system settings file is read only when
// root owns it and every directory above it, none of them writable by group
// or others. Otherwise it is skipped whole, with "Security Warning: Skipping
// system settings file '<path>': … is not owned by root (uid 0)" on stderr —
// and our file lives in the companion's folder in the user's home, owned by
// the user. Measured on the real 0.64.0 bundle: with the companion's folder
// owned by an ordinary uid the shim is skipped and google_web_search and the
// file tools are still declared to the model; with a root-owned chain the
// same shim takes them off; 0.54.4 honours it either way. So on a current
// Gemini CLI run by an ordinary account NOTHING in this file reaches the run
// — not cma_github, not cma_web, not the exclusions — and, because the
// variable REPLACES the machine's system file rather than adding to it, an
// enterprise /etc/gemini-cli/settings.json goes unread on those runs too.
// That needs a different door (a policy file on --policy for the exclusions;
// something not under the system-settings check for the servers), and it is
// said in `limitations` until there is one.
// ---------------------------------------------------------------------------

const CLI = {
  // ONE token, `--prompt=<text>`, never `--prompt <text>`. The CLI's yargs
  // gives --prompt nargs 1 with nargs-eats-options off, so a value that
  // starts with "-" is read as the next FLAG, not as the prompt: a new
  // message that opens with a markdown list ("- fix the login") or a flag
  // name ("--verbose isn't working") died in argv parsing — exit 1, "Not
  // enough arguments following: prompt" (real 0.64.0 bundle). That never
  // bit while every prompt began with "<system>" or "User:"; a resumed turn
  // sends the user's own words first (see renderPrompt), so it did. The `=`
  // form is the one yargs never re-reads as a flag.
  prompt: (text) => [`--prompt=${text}`],
  streamFormat: ["--output-format", "stream-json"],
  model: (id) => ["--model", id],
  // Only ever the session uuid — see resumeIdOf for what is kept off it.
  resume: (id) => ["--resume", id],
  approvalMode: (mode) => ["--approval-mode", mode],
  // Comma-separated, coerced by the CLI. One flag, one value — not variadic,
  // so it cannot swallow anything. It only auto-APPROVES; it removes
  // nothing, so it is no help against a tool we want gone from the surface
  // entirely — that is `tools.exclude` in the settings shim (excludedToolsFor).
  allowedTools: (list) => ["--allowed-tools", list.join(",")]
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

// Only an id the CLI itself minted goes on the wire — a uuid, so a uuid's
// charset — and never the `latest` keyword or a bare index, either of which
// `--resume` reads as SOME session on that machine rather than ours. Anything
// else is not sent and the run starts a fresh session. Both spellings of the
// payload key are read because the server side of this contract is landing
// beside this adapter, not before it.
export function resumeIdOf(job) {
  const id = String(job?.runtime_session_id ?? job?.runtimeSessionId ?? "").trim()
  if (!/^[A-Za-z0-9_-]+$/.test(id) || /^\d+$/.test(id) || id === "latest") return ""
  return id
}

// ---------------------------------------------------------------------------
// Session continuity: what a resumed turn is SENT.
//
// `--resume <id>` reloads the whole recorded conversation into the chat
// before the prompt is sent — runNonInteractive calls
// geminiClient.resumeChat(convertSessionToClientHistory(messages)) and only
// then emits `init` and sends `--prompt` (gemini-cli 0.64.0 bundle). Until
// this, renderPrompt still rendered the ENTIRE conversation into that prompt,
// so every resumed Gemini turn carried its history twice: once as the
// session's real turns and once more as a "User: … Assistant: …" block
// stacked on top of them, re-sent in full each turn and growing with it —
// the continuity feature costing more than no continuity at all. The other
// resuming adapters (claude-code.js plan.tail, codex.js, cursor.js
// newMessagesSince, grok.js, antigravity.js) all send only what is new.
//
// The contract owner's rules (claude-code.js resumePlan), applied unchanged:
//
//   * the server decides WHETHER to offer an id — only when the system text
//     is byte-identical to the one the session was recorded with, which is
//     why a resumed prompt carries no <system> block: the first turn's
//     prompt already holds it;
//   * the id is one resumeIdOf accepts — never `latest` or an index;
//   * the history must be an append-only continuation: at least one
//     assistant turn the session already holds, then only user turns (the
//     new message, plus the bot's hoisted clock band when there is one).
//     Anything else is sent the old way, in full, with no --resume — a
//     tail-only prompt on a session that does not hold the rest would be an
//     answer to half a conversation;
//   * a session that is gone exits before anything is spent, and
//     fallbackJob retries the turn fresh, with the full history.
// ---------------------------------------------------------------------------

// { sessionId, tail } when this job may resume, null when it must not.
export function resumePlan(job) {
  const sessionId = resumeIdOf(job)
  if (!sessionId) return null

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

// One more attempt without the session, or null.
//
// The session-gone path is pinned from the CLI's own main (gemini-cli 0.64.0,
// resolveSessionId): an id the project's chat store does not hold throws
// SessionError — `Invalid session identifier "<id>"` — which is reported as
// "Error resuming session: …" and ends the process with FATAL_INPUT_ERROR
// (exit 42), all BEFORE runNonInteractive emits `init` or sends a byte to
// the model. That is not a failed turn; it is the ordinary turn the person
// would have got without the id (a different machine, a different working
// tree, a cleaned chat store), and before this it reached them as an error
// with nothing behind it. So: a planned resume that died without an `init`
// (and without anything that could only follow one) is run again with the
// id cleared — both spellings, since resumeIdOf reads both. Anything past
// `init` was a real run with a real failure, and running it again in full
// would pay for it twice; an argv rejection is the engine's own degrade path.
const SPENT_EVENTS = new Set(["init", "message", "tool_use", "tool_result", "result"])

export function fallbackJob(job, result = {}) {
  if (!resumePlan(job)) return null

  const events = Array.isArray(result.events) ? result.events : []
  if (events.some((event) => SPENT_EVENTS.has(event?.type))) return null
  if (/unknown option|unrecognized option|unknown argument/i.test(String(result.stderr || ""))) return null

  return { ...job, runtime_session_id: null, runtimeSessionId: null }
}

export function baseArgs(job) {
  const args = [...CLI.streamFormat]
  if (job.model) args.push(...CLI.model(job.model))

  // Continuity through the CLI's own session store. The server hands back
  // the id a previous run reported (init.session_id, sent up as
  // usage.runtime_session_id) and the CLI reloads that conversation itself.
  // The store is per project directory (Storage(cwd).getProjectTempDir()/
  // chats), so an id is only good from the same workdir on the same machine,
  // and an unknown id makes the CLI exit with a fatal input error rather
  // than start fresh — fallbackJob turns that into the fresh run. Only a
  // turn resumePlan accepts resumes, because renderPrompt sends that turn
  // only its tail. Read defensively: an older server sends no such key.
  const plan = resumePlan(job)
  if (plan) args.push(...CLI.resume(plan.sessionId))

  // No tool exclusions on argv, deliberately: they ride the settings shim as
  // `tools.exclude` when one is written (excludedToolsFor says when that
  // reaches the run). Gemini CLI's main command has never had an
  // --exclude-tools option — the only one in the bundle belongs to `gemini
  // mcp add` — in any release read for this (18 of them, 0.1.22 through
  // 0.64.0), and its yargs is strict. So every Gemini turn sent with it died
  // in argv parsing ("Unknown arguments: exclude-tools, excludeTools") and
  // the engine re-ran it degraded: without --approval-mode auto_edit and
  // --allowed-tools (on 0.64.0 a repository turn's model was not even
  // offered write_file or replace), without the exclusions it was sent for,
  // and — the reason this was found — with --resume still on, so a session
  // that was gone failed in runDegraded, which never asks fallbackJob, and
  // the person got "Error resuming session" instead of a fresh turn.
  if (job.workdir) {
    // Edits without prompting, nothing else. A headless run has no terminal to
    // approve in, so anything not auto-approved simply does not happen.
    args.push(...CLI.approvalMode("auto_edit"))
    args.push(...CLI.allowedTools(FILE_TOOLS))
  }

  return args
}

// The whole prompt travels as ONE argument, `--prompt=<text>` (see CLI.prompt
// for why the `=` form), so there is no positional for anything to swallow
// and no ordering hazard of the kind that killed an earlier Claude Code
// release.
//
// Worth knowing: this puts the conversation in argv. On Linux one argument is
// capped at 128 KiB (MAX_ARG_STRLEN) whatever the ~2MB ARG_MAX, and every
// cloud machine is Linux; macOS has only the ~1MB total. The server keeps the
// prompt under the per-argument cap for this runtime on a Linux machine
// (Ai::LocalCompanionClient#argv_bounded).
export function streamingArgs(job, prompt = "") {
  return [...CLI.prompt(prompt), ...baseArgs(job)]
}

// Gemini has no append-system-prompt flag either, so the system text rides the
// prompt — kept visibly separated so a model reading it can tell the
// operator's instructions from the conversation. A resumed turn is fed only
// the new user turn(s), verbatim and unframed: the session already holds
// every earlier message, the system block included — see resumePlan.
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

// Gemini's own tools this job takes off the surface, by Gemini's own names:
// the web tools and the platform-owned built-ins on EVERY job (a headless run
// has nobody to answer a permission prompt, and a tool the model can see
// beats a system prompt telling it not to reach for it — it should be using
// mcp__cma_web__* and the bot's memory_update), plus the file and shell tools
// on a bot turn with no checkout (shared.js HOST_WORKSPACE_TOOLS).
//
// They travel as the shim's `tools.exclude`, the settings key every release
// from 0.3.0 to 0.64.0 reads (0.64.0: mergeExcludeTools(settings) into the
// config's excludeTools, plus a DENY rule per name in the policy engine,
// which takes a denied tool out of the declarations the model is sent),
// UNION-merged with the user's own list from 0.8.0 on. Not --exclude-tools:
// see baseArgs for what that flag did to every turn.
//
// What this does NOT reach, stated rather than implied: the shim is only
// written for a job with servers to mount (writeConfig), and Gemini CLI 0.60
// and later skips it outright unless root owns it and every directory above
// it — see the header. So the exclusions hold on a 0.3–0.59 build when the
// job mounts cma_github or cma_web, and on any build for a companion running
// as root; anywhere else Gemini keeps these tools, as it always has (the
// argv flag never parsed). A shim written for exclusions alone was tried and
// dropped: on 0.60+ it is skipped with a ~400-character "Security Warning
// … run: sudo chown root:root" on stderr, which the engine's 500-character
// failure excerpt shows INSTEAD of the real error (see failureDetail) — on
// every job, where today only a job with a grant pays that. Gemini's own
// route that does not care who owns the file is a policy file on `--policy`
// (0.30+), which first needs engine.js to treat it as a capability flag, so
// a build older than the option degrades instead of failing every turn.
export function excludedToolsFor(job) {
  return [...builtinWebTools("gemini_cli"), ...builtinPlatformTools("gemini_cli"),
          ...hostWorkspaceToolsFor("gemini_cli", job)]
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
  const exclude = [...new Set([...(Array.isArray(base.tools?.exclude) ? base.tools.exclude : []),
                               ...excludedToolsFor(job)])]
  return {
    ...base,
    mcpServers: { ...(base.mcpServers || {}), ...geminiServersFor(job) },
    tools: { ...(base.tools || {}), exclude }
  }
}

// Called before every spawn. Writes our shim when the job has something to
// mount, and removes a stale one when it doesn't — a leftover file would keep
// offering tools whose grant is gone, which is worse than no file. The tool
// exclusions ride along when it is written (excludedToolsFor says why not
// alone).
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

// ---------------------------------------------------------------------------
// Usage. What the `result` event's `stats` means, pinned from the CLI's own
// source at 0.61.0-nightly.20260908 (packages/core/src/output/types.ts and
// stream-json-formatter.ts, telemetry/uiTelemetry.ts, telemetry/types.ts):
//
//   stats = { total_tokens, input_tokens, output_tokens, cached, input,
//             duration_ms, tool_calls,
//             models: { [model]: { total_tokens, input_tokens, output_tokens,
//                                  cached, input } } }
//
//   input_tokens  = Σ promptTokenCount        INCLUSIVE of the cached tokens,
//                                             exactly as Google reports it
//   cached        = Σ cachedContentTokenCount inside input_tokens
//   input         = Σ max(0, prompt − cached) the CLI's own non-cached figure
//   output_tokens = Σ candidatesTokenCount    the visible answer ONLY
//   total_tokens  = Σ totalTokenCount         prompt + candidates + thoughts
//                                             + tool-use prompt (Google's identity)
//
// Two things follow. The shape the server expects is ADDITIVE — input_tokens
// excludes cache reads, which ride beside it — so the value to send is
// `input`, never `input_tokens`: sending the inclusive count made the server
// add the cached share a second time. And thinking is billed as output by
// Google but never appears in stream-json under its own name (the formatter
// drops `thoughts`), so it is recovered from the identity: total − prompt −
// candidates. Only `--output-format json` prints the raw SessionMetrics —
// models[m].tokens {prompt, candidates, total, cached, thoughts, tool, input}
// plus api.totalRequests — where thoughts, tool-use prompt tokens and the
// request count are explicit; that shape is read too.
//
// Everything is the SESSION's sum over every API call the run made. There is
// no per-request figure, no cost and no window size on the wire.
// ---------------------------------------------------------------------------

// One reader for the three spellings the CLI has used for the same numbers:
// Google's API (`promptTokenCount`), stream-json's StreamStats (`input_tokens`
// = the inclusive prompt count, `input` = non-cached) and the raw
// SessionMetrics tokens (`prompt`, `candidates`, `thoughts`, `tool`). Null
// when the object carries neither a prompt nor an output count, so a stats
// object of some other shape yields no numbers rather than wrong ones.
function readCounts(obj) {
  if (!obj || typeof obj !== "object") return null
  const pick = (...keys) => {
    for (const key of keys) {
      if (obj[key] !== undefined && obj[key] !== null) return Number(obj[key]) || 0
    }
    return undefined
  }

  const prompt = pick("promptTokenCount", "input_token_count", "input_tokens", "prompt")
  const candidates = pick("candidatesTokenCount", "output_token_count", "output_tokens", "candidates")
  if (prompt === undefined && candidates === undefined) return null

  return {
    prompt: prompt || 0,
    candidates: candidates || 0,
    cached: pick("cachedContentTokenCount", "cached_content_token_count", "cached_tokens", "cached") || 0,
    thoughts: pick("thoughtsTokenCount", "thoughts_token_count", "thoughts"),
    tool: pick("toolUsePromptTokenCount", "tool_token_count", "tool") || 0,
    total: pick("totalTokenCount", "total_token_count", "total_tokens", "total"),
    input: pick("input")
  }
}

// The additive split of one counts record, the way Google bills it.
//
// Thoughts are explicit when the build prints them. Otherwise they are what
// is left of the total once prompt and answer are out — thoughts plus any
// built-in tool-use prompt tokens, which this identity cannot tell apart.
// The CLI's own web tools are excluded from every run (baseArgs), so that
// share is 0 in practice and the remainder is thinking. With neither a
// thoughts count nor a total, thinking is unknown and stays unreported —
// absent means unknown, never 0.
function additiveOf(c) {
  const fresh = c.input !== undefined ? c.input : Math.max(0, c.prompt - c.cached)
  let thoughts
  if (c.thoughts !== undefined) thoughts = c.thoughts
  else if (c.total !== undefined) thoughts = Math.max(0, c.total - c.prompt - c.candidates - c.tool)

  return {
    // Tool-use prompt tokens are input that Google counts OUTSIDE
    // promptTokenCount (they are in the total, not the prompt).
    input_tokens: fresh + c.tool,
    output_tokens: c.candidates + (thoughts || 0),
    cache_read_input_tokens: c.cached,
    reasoning_tokens: thoughts
  }
}

// The `result` event carries status, stats and an error — but NOT the final
// text. That is the one place Gemini's stream differs materially from the
// other two: the answer has to be assembled from the assistant messages.
//
// Returns the additive counts plus, when the stats name the models that
// served the run, `model_label` (the model that produced the most output —
// `auto` routing can spend a flash-lite classifier call beside the answer)
// and `num_turns` (API requests, only the raw shape counts them). Nothing
// here guesses a number: an unrecognised shape yields no counts and the
// answer still arrives.
function tokensFrom(stats) {
  if (!stats || typeof stats !== "object") return {}

  // Per model first: it is the only place the served models are named, and
  // the sums equal the top-level totals by construction (convertToStreamStats
  // builds the totals from exactly these entries). A raw SessionMetrics entry
  // keeps its numbers under `tokens`; a StreamStats entry is flat.
  const perModel = []
  if (stats.models && typeof stats.models === "object") {
    for (const [name, entry] of Object.entries(stats.models)) {
      if (!entry || typeof entry !== "object") continue
      const counts = readCounts(entry.tokens) || readCounts(entry)
      if (!counts) continue
      const requests = Number(entry.api?.totalRequests)
      perModel.push({ name, counts, requests: Number.isFinite(requests) && requests > 0 ? requests : undefined })
    }
  }

  if (perModel.length > 0) {
    const sum = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 }
    let reasoning
    let turns = 0
    let turnsKnown = true
    let lead = null
    for (const { name, counts, requests } of perModel) {
      const add = additiveOf(counts)
      for (const key of Object.keys(sum)) sum[key] += add[key]
      if (add.reasoning_tokens !== undefined) reasoning = (reasoning || 0) + add.reasoning_tokens
      if (requests === undefined) turnsKnown = false
      else turns += requests
      if (!lead || add.output_tokens > lead.output_tokens) lead = { name, output_tokens: add.output_tokens }
    }
    const out = { ...sum, model_label: lead.name }
    if (reasoning !== undefined) out.reasoning_tokens = reasoning
    if (turnsKnown) out.num_turns = turns
    return out
  }

  // Top-level totals only — a build that prints no per-model breakdown, or
  // the API's own usageMetadata spelling.
  for (const candidate of [stats, stats.tokens, stats.usage, stats.metrics]) {
    const counts = readCounts(candidate)
    if (counts) return additiveOf(counts)
  }

  return {}
}

// The CLI's own window table — packages/core/src/core/tokenLimits.ts:
// DEFAULT_TOKEN_LIMIT 1,048,576 for every Gemini id (the switch's default arm
// included), GEMMA_4_TOKEN_LIMIT 256,000 for the gemma-4 ids. It never
// reaches the wire, so it is mirrored here from the build named above; the
// server prefers a reported window over its own table, and this is the
// window the CLI itself compacts against.
export function contextWindowFor(model) {
  const id = String(model || "").trim().toLowerCase()
  if (!id) return null
  return id.startsWith("gemma-4") ? 256_000 : 1_048_576
}

// The keys of the server's additive contract that this runtime can fill
// beyond the four counts. Every one is optional and only sent when known.
function extrasOf(counts, initModel, sessionId) {
  const extras = {}
  if (counts.reasoning_tokens !== undefined) extras.reasoning_tokens = counts.reasoning_tokens
  if (counts.num_turns !== undefined) extras.num_turns = counts.num_turns

  // What actually ran: the served model from the stats when they name one,
  // else what the CLI announced at init (the resolved id — `auto` and the
  // `pro`/`flash` aliases are already resolved by then).
  const label = counts.model_label || initModel
  if (label) {
    extras.model_label = label
    const window = contextWindowFor(label)
    if (window) extras.context_window = window
  }

  // The id to hand back as `runtime_session_id` — see baseArgs for the
  // `--resume` side of the same contract.
  if (sessionId) extras.runtime_session_id = sessionId
  return extras
}

function collapseEvents(events) {
  const out = {
    content: "", usage: emptyUsage(), model: null,
    stopReason: null, isError: false, errorStatus: null
  }

  let sawResult = false
  let sessionId = null
  const assistantText = []

  for (const event of events) {
    if (event?.type === "init") {
      if (event.model) out.model = event.model
      if (event.session_id) sessionId = String(event.session_id)
    }

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
      const counts = tokensFrom(event.stats)
      out.usage = { ...normalizeUsage(counts), ...extrasOf(counts, out.model, sessionId) }
      // `stats` is the SESSION's accounting — every API call the run made
      // added together, so on a multi-step run it is a multiple of any prompt
      // that existed and must not be read as how full the window is. Gemini
      // CLI's own /stats view is built from the same aggregate. If a build
      // starts reporting the last request separately, this picks it up under
      // any of the usual spellings; until then the value stays 0 and the
      // composer draws no meter rather than a wrong one.
      out.usage.context_tokens = lastTurnOccupancy(event.stats) || lastTurnOccupancy(event)
    }
  }

  out.content = assistantText.join("")
  return { ...out, sawResult }
}

// What of a failed run's stderr is worth showing the person. Gemini CLI
// opens stderr with advisories that are never the reason a run failed —
// "Warning: --allowed-tools cli argument … deprecated" on every repository
// turn (0.54.4 and 0.64.0 both print it), the same for tools.exclude,
// "256-color support not detected", [STARTUP] timing notes, and on 0.60+
// the ~400-character "Security Warning: Skipping system settings file …
// run: sudo chown root:root" (see the header). The engine hands an adapter
// the first 500 characters of stderr, and once baseArgs stopped being
// rejected the repository turn's --allowed-tools came back with its
// deprecation line. Measured on 0.64.0, a repository turn with the web
// grant, refused because its folder was untrusted: the real error starts
// at character 719, so the excerpt was the deprecation line and the
// security warning — the person was told to hand the companion's folder
// to root. Dropping these lines lets whatever real error fits through lead;
// with nothing left the caller says the generic thing rather than repeating
// the noise (that refusal now reads "Gemini exited with an error." — the
// excerpt itself is engine.js's to widen). ANSI colour codes go too (the
// trust error arrives wrapped in red).
const STDERR_NOISE = [
  /^Warning: .*\bdeprecated\b/,
  /^Warning: 256-color support not detected/,
  /^Security Warning: Skipping system (settings|defaults) file/,
  /^\[STARTUP\]/
]

export function failureDetail(detail) {
  return String(detail || "")
    .replace(/\x1b\[[0-9;]*m/g, "")
    .split("\n")
    .filter((line) => !STDERR_NOISE.some((re) => re.test(line.trim())))
    .join("\n")
    .trim()
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
  // A resume whose session this machine no longer holds is retried once as
  // an ordinary full-history turn — see fallbackJob.
  fallbackJob,

  // Writes the system-overrides shim (MCP servers, and the tool exclusions
  // riding with them) before every spawn — see the header. Runs for the
  // ambient login too, which is why the engine calls prepare() whether or
  // not there is a managed config directory.
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
    classifyFailure(failureDetail(detail), { name: "Gemini", loginHint: "run `gemini` once to sign in" }),

  // What this runtime cannot do, in a form the CLI can print. Being able to
  // say "edits yes, git no" beats a user discovering it when a session
  // finishes by asking them to push its work by hand. The GitHub
  // pull-request line that used to sit here is gone: the cma_github and
  // cma_web MCP servers now mount through the system-settings shim, so a
  // Gemini run can open pull requests and read the web — it still cannot run
  // git itself.
  // The third line is the 0.60 settings-file check (see the header): true
  // of every current Gemini CLI run by an ordinary account, so it is printed
  // rather than discovered when a Gemini session cannot open a pull request.
  limitations: [
    "Repository turns can read and edit files, but cannot run git — the machine pushes for them.",
    "One Gemini login per machine.",
    "Gemini CLI 0.60 and later ignores the companion's settings file unless root owns its folder, " +
      "so the GitHub and web tools are not mounted and Gemini keeps its own web and file tools."
  ],

  resolveBin() {
    return locateBin({ cli: this.cli, envVar: this.binEnvVar, extraHomePaths: this.extraHomePaths })
  },

  advice() {
    const { bin, source } = this.resolveBin()
    return locationAdvice({ name: this.name, install: this.install, bin, source })
  }
}
