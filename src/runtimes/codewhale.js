import fs from "node:fs"
import path from "node:path"

import {
  classifyFailure, emptyUsage, envForGithub, envForWeb, locateBin, locationAdvice,
  mcpServersFor, shortCommand, shortPath
} from "./shared.js"

// ---------------------------------------------------------------------------
// CodeWhale (`codewhale`) — the DeepSeek-first terminal agent, formerly
// DeepSeek TUI, now provider-neutral and community-maintained. What it spends
// is whatever the user configured inside CodeWhale itself: a DeepSeek API
// key for most people, or a local model for free. No credential of theirs
// ever reaches this companion, and the platform never meters a run.
//
// The headless surface below is CodeWhale's own published launch contract for
// `codewhale exec` (docs/AGENT_RUNTIME.md in its repository, cross-checked
// against the clap definitions in crates/tui/src/lib.rs at v0.9.13):
//
//   codewhale [globals] exec [flags] -- "<prompt>"
//
//   globals:  --workspace <dir>       the directory the run may work in
//             --skip-onboarding       never open the setup wizard headless
//             --no-project-config     ignore workspace-local config overlays
//   exec:     --output-format stream-json    NDJSON event stream
//             --model <id>                   model override (an EXEC flag —
//                                            the root parser has no --model,
//                                            and rejects one placed before
//                                            the subcommand)
//             --reasoning-effort <level>     low | medium | high | xhigh | max
//             --append-system-prompt <text>  caller-supplied system text
//             --auto                         run without stopping to ask
//             --sandbox <level>       read-only | workspace-write | danger-full-access
//             --disallowed-tools a,b  take tools off the surface entirely
//
// Version floor: 0.9.9 (the `schema`/`schema_version` envelope on every
// event; per-turn usage receipts since 0.9.4; `--append-system-prompt` and
// `--disallowed-tools` since 0.8.60; `--reasoning-effort` is in the 0.9.13
// parser and undated by the CHANGELOG). The `--model` placement is read off
// the clap definitions — `ExecArgs` has the flag, the root `Cli` does not —
// and has not been run against a real binary from here.
//
// `--no-project-config` is deliberate and load-bearing: a repository shared
// with this companion must not be able to reconfigure the harness that runs
// over it (swap the provider, lift the sandbox) by carrying a config file.
//
// The sandbox levels are codex-vocabulary on purpose (CodeWhale uses the same
// Landlock/Seatbelt/AppContainer machinery), and the mapping is the same one
// the codex adapter uses: workspace-write for a repository turn, read-only
// for a plain chat. `--auto` is safe ONLY because the sandbox bounds it —
// bare, it would be cursor's `--force` problem all over again.
//
// ── Chat turns and the tool surface ────────────────────────────────────────
//
// Without `--auto`, `exec` still offers its whole tool catalogue and DENIES
// every call the model makes (Event::ApprovalRequired → deny_tool_call): each
// attempt costs a model step and the schemas ride on every request. A plain
// chat has no shared folder — the process cwd is whatever `cma-agent start`
// ran from — so `--auto` is not the answer there. The native file, shell and
// delegation tools are taken off the surface instead (`--disallowed-tools`,
// names read off crates/tui/src/core/engine/tool_catalog.rs), which is what
// keeps a chat turn from spending its budget on tools it may never run.
//
// ── Usage accounting: the counts are INCLUSIVE ─────────────────────────────
//
// `turn_usage.input_tokens` is the WHOLE prompt, the DeepSeek convention:
// `prompt_cache_hit_tokens` (and, on the Anthropic wire, the
// `prompt_cache_write_tokens`) are INSIDE it, never on top of it. CodeWhale's
// own shape lock says so (crates/tui/tests/integration/exec_turn_usage.rs:
// prompt_tokens 20 = hit 12 + miss 8 → input_tokens 20), and its documented
// example is 1200 = 900 hits + 300 misses. The server's four counts are
// additive (Anthropic's shape: cache tokens sit outside input), so this
// adapter converts before anything reaches the shared normalizer —
// otherwise every cache hit was reported twice, and an agentic run that is
// 90% hits showed nearly double its real traffic.
//
// Sub-agent spend never appears as a `turn_usage` event: in-process children
// fold into the run's authoritative total, which reaches the stream only in
// the terminal `metadata.meta` receipt. So Σ turn_usage ≤ the receipt, with
// equality only when nothing was delegated — and the receipt wins when it is
// larger.
//
// ── MCP wiring ─────────────────────────────────────────────────────────────
//
// CODEWHALE_MCP_CONFIG names the MCP file for a run — CodeWhale's own,
// documented way to hand a harness its servers — so the file lives in OUR
// profile directory and nothing is ever written into ~/.codewhale, whose
// config the user's own CodeWhale reads. Same shape as Cursor's mcp.json
// ({ mcpServers: { name: { command, args } } }), same secret discipline: the
// file names a command, the tokens travel by environment. (CodeWhale spawns
// MCP servers with the run's environment — the same inheritance bet the
// Cursor adapter already makes; if a build ever sanitizes it, the tools
// mount and fail auth loudly rather than silently.)
//
// ── Stated limitation ──────────────────────────────────────────────────────
//
// The forbidden-git deny list has no verified flag to ride:
// `--disallowed-tools` takes CodeWhale's tool names (read/write/edit/bash/…),
// not per-command patterns, so denying "bash" on a repository turn would
// also deny the test suite. The workspace-write sandbox and the system
// prompt are the bounds, and `limitations` says so.
// ---------------------------------------------------------------------------

const CLI = {
  exec: "exec",
  separator: "--",
  streamFormat: ["--output-format", "stream-json"],
  auto: "--auto",
  sandbox: (level) => ["--sandbox", level],
  workspace: (dir) => ["--workspace", dir],
  model: (id) => ["--model", id],
  reasoningEffort: (level) => ["--reasoning-effort", level],
  appendSystem: (text) => ["--append-system-prompt", text],
  // One token: the flag is comma-delimited on CodeWhale's side.
  disallowedTools: (names) => ["--disallowed-tools", names.join(",")],
  skipOnboarding: "--skip-onboarding",
  noProjectConfig: "--no-project-config"
}

// The stream envelope every event carries since 0.9.9. A different schema
// name or a NEWER version is noted, not fatal: the fields this adapter reads
// are the documented ones, and a build that adds more must still hand back
// the answer and the counts it does report.
export const STREAM_SCHEMA = "codewhale.exec-stream"
export const STREAM_SCHEMA_VERSION = 1

// Ai::Effort's vocabulary, which CodeWhale's `--reasoning-effort` parser
// accepts verbatim (it also takes off/auto/ultra, which the platform never
// sends). Anything else is omitted rather than guessed, so the user's own
// configured tier applies — the same outcome as an older server that sends
// no effort at all.
export const EFFORT_LEVELS = new Set(["low", "medium", "high", "xhigh", "max"])

// The native tools a plain chat cannot use anyway (no shared folder, no
// `--auto`), so they should not cost schema tokens or denied steps.
export const CHAT_DISALLOWED_TOOLS = ["read", "write", "edit", "bash", "agent"]

// The outcomes CodeWhale itself exits non-zero on (exec_agent.rs). Anything
// else in `meta.status` is a run that finished with an answer.
const FAILED_STATUSES = new Set(["failed", "canceled", "cancelled", "interrupted"])

// Globals precede the subcommand — that is the documented shape, not a
// preference.
//
// `--workspace` goes FIRST, and that ordering is load-bearing: it is a
// capability flag, and the engine's degraded retry drops a rejected
// capability flag plus every non-flag token after it. Anywhere later in the
// list, the token after `--workspace <dir>` would be the bare `exec`
// subcommand, and stripping would eat it — the same class of ordering hazard
// that once cost Claude Code its prompt. Here the next token is always
// another flag, so only the directory goes with it.
export function globalArgs(job) {
  const args = []
  if (job.workdir) args.push(...CLI.workspace(job.workdir))
  args.push(CLI.skipOnboarding, CLI.noProjectConfig)
  return args
}

export function effortArgs(job) {
  const level = String(job.effort || "").trim().toLowerCase()
  return EFFORT_LEVELS.has(level) ? CLI.reasoningEffort(level) : []
}

export function execArgs(job) {
  const args = [...CLI.streamFormat]
  if (job.model) args.push(...CLI.model(job.model))
  args.push(...effortArgs(job))
  if (job.system) args.push(...CLI.appendSystem(job.system))

  if (job.workdir) {
    // Work without stopping to ask, confined to the workspace by the sandbox.
    args.push(CLI.auto)
    args.push(...CLI.sandbox("workspace-write"))
  } else {
    // A chat completion writes nothing — and reads nothing either, since it
    // has no folder to read: see the header.
    args.push(...CLI.sandbox("read-only"))
    args.push(...CLI.disallowedTools(CHAT_DISALLOWED_TOOLS))
  }

  return args
}

// The prompt is a positional after `--`, which is the documented contract and
// also the safest of the three shapes: nothing after a `--` is ever parsed as
// a flag, so nothing can swallow it.
export function streamingArgs(job, prompt = "") {
  return [...globalArgs(job), CLI.exec, ...execArgs(job), CLI.separator, prompt]
}

// Where the MCP file lives inside the directory the engine hands us (our
// profile directory, ambient login included). One function because prepare()
// writes it and envFor() names it, and the two must agree.
export function mcpPathIn(dir) {
  return path.join(dir, "mcp.json")
}

// Written before every spawn when the job has something to mount; a stale
// file from a job that had a grant this one lacks is removed rather than left
// offering tools that can only fail.
export function writeConfig(job, file) {
  const servers = mcpServersFor(job)

  if (Object.keys(servers).length === 0) {
    if (fs.existsSync(file)) fs.rmSync(file, { force: true })
    return
  }

  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  fs.writeFileSync(file, `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`, { mode: 0o600 })
}

// ---------------------------------------------------------------------------
// The event stream. CodeWhale documents a closed set of NDJSON event types:
//
//   content | tool_use | tool_result | agent_spawned | sandbox_denied |
//   workflow_event | session_capture | service_released | turn_usage |
//   metadata | done | error
//
// `content` carries answer text as it is produced (the partial channel),
// `turn_usage` the per-model-call token counts, `metadata` the terminal
// receipt (everything nested under `meta`, including the cumulative totals,
// the model that actually ran and the outcome), `done` the terminal marker.
// ---------------------------------------------------------------------------

function contentTextOf(event) {
  if (event?.type !== "content") return null
  const value = event.content ?? event.text ?? event.delta
  return typeof value === "string" && value ? value : null
}

function describeEvent(event) {
  if (!event || typeof event !== "object") return null

  if (event.type === "sandbox_denied") return "Blocked by the sandbox"

  if (event.type === "agent_spawned") {
    const model = String(event.model || "").trim()
    return model ? `Delegating to ${model}`.slice(0, 60) : "Delegating a subtask"
  }

  if (event.type === "tool_use") {
    const name = String(event.name || event.tool_name || event.tool || "")
    const args = event.input || event.args || event.parameters || {}
    const file = shortPath(args.path || args.file_path)

    switch (name) {
      case "read":       return file ? `Reading ${file}` : "Reading a file"
      case "write":      return file ? `Writing ${file}` : "Writing a file"
      case "edit":       return file ? `Editing ${file}` : "Editing a file"
      case "bash": {
        const cmd = shortCommand(args.command)
        return cmd ? `Running ${cmd}` : "Running a command"
      }
      case "agent":      return "Delegating a subtask"
      case "todo_write": return "Updating the plan"
      default: {
        const pretty = name.replace(/_/g, " ").trim()
        return pretty ? `${pretty.charAt(0).toUpperCase()}${pretty.slice(1)}`.slice(0, 60) : "Working"
      }
    }
  }

  // `metadata` is the LAST event before `done` — the receipt, not a start.
  return null
}

function partialTextFrom(event) {
  return contentTextOf(event)
}

// Which file this event wrote, for the documents channel. Write/edit tool
// calls name their path; a shape we don't recognise reports nothing.
function writtenPathFrom(event) {
  if (event?.type !== "tool_use") return null
  const name = String(event.name || event.tool_name || event.tool || "")
  if (!["write", "edit"].includes(name)) return null

  const args = event.input || event.args || event.parameters || {}
  const file = args.path || args.file_path
  return typeof file === "string" && file.trim() ? file.trim() : null
}

function count(value) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0
}

// Inclusive → additive, for one `turn_usage` event or the `meta` receipt
// (both spell their counts the same way):
//
//   input_tokens        = input − hit − write   (the fresh, cache-miss part)
//   cache_read          = prompt_cache_hit_tokens
//   cache_creation      = prompt_cache_write_tokens   (Anthropic wire only)
//   output_tokens       = output_tokens   (reasoning is INSIDE it, not added)
//   context_tokens      = input_tokens as reported — the whole prompt, which
//                         is exactly the window occupancy of that call
//
// Optional fields are OMITTED by CodeWhale when the provider did not report
// them — never null, never zero-filled — and an omitted field is 0 for that
// turn here, never a guess. `prompt_cache_miss_tokens` is not read: on the
// Responses wire the total also carries uncategorized tokens, and the
// subtraction keeps fresh + hit + write equal to the prompt CodeWhale
// reported. `reasoning_replay_tokens` is a client-side ESTIMATE of bytes
// already inside the prompt and is never added.
export function additiveUsageFrom(counts = {}) {
  const input = count(counts.input_tokens)
  const hit = count(counts.prompt_cache_hit_tokens)
  const write = count(counts.prompt_cache_write_tokens)

  return {
    input_tokens: Math.max(input - hit - write, 0),
    output_tokens: count(counts.output_tokens),
    cache_creation_input_tokens: write,
    cache_read_input_tokens: hit,
    context_tokens: input
  }
}

function hasCounts(counts) {
  return counts?.input_tokens != null || counts?.output_tokens != null
}

// What a run spent, in tokens the provider saw: every input-side count plus
// the output. Used to decide whether the terminal receipt saw more than the
// per-call events did (delegated children), never for occupancy.
function spentOf(usage) {
  return usage.input_tokens + usage.cache_read_input_tokens +
    usage.cache_creation_input_tokens + usage.output_tokens
}

function schemaNoteFor(event) {
  const { schema, schema_version: version } = event
  // Builds before 0.9.9 carried no envelope at all; that is not a mismatch.
  if (schema == null && version == null) return null
  if (schema !== STREAM_SCHEMA) return `CodeWhale emitted stream schema ${JSON.stringify(schema)}, not ${STREAM_SCHEMA}`
  if (Number(version) > STREAM_SCHEMA_VERSION) {
    return `CodeWhale stream schema_version ${version} is newer than the ${STREAM_SCHEMA_VERSION} this companion reads; unknown fields were ignored`
  }
  return null
}

function collapseEvents(events) {
  const out = {
    content: "", usage: emptyUsage(), model: null,
    stopReason: null, isError: false, errorStatus: null,
    // Local-only, for tests and diagnostics: the runner posts content, model,
    // stop_reason, usage and files — nothing here reaches the server.
    runtimeMeta: { usageSource: null, provider: null, routeSource: null, status: null,
                   terminationReason: null, warnings: [], schemaNote: null }
  }

  let sawResult = false
  const text = []
  const errors = []
  const fromTurns = emptyUsage()
  let turns = 0
  let reasoningFromTurns = null
  let meta = null
  let sessionId = null

  for (const event of events) {
    if (!event || typeof event !== "object") continue

    out.runtimeMeta.schemaNote ||= schemaNoteFor(event)

    const chunk = contentTextOf(event)
    if (chunk) text.push(chunk)

    switch (event.type) {
      case "turn_usage": {
        // Documented PER MODEL CALL — the totals are every call added
        // together, and the occupancy is the LAST call on its own: how full
        // the window was on the prompt that just went out, a level, not a
        // sum. If a build ever emitted cumulative counts under this name the
        // totals would double-count; the event name, CodeWhale's docs and its
        // integration tests all say per call.
        turns += 1
        const turn = additiveUsageFrom(event)
        fromTurns.input_tokens += turn.input_tokens
        fromTurns.output_tokens += turn.output_tokens
        fromTurns.cache_creation_input_tokens += turn.cache_creation_input_tokens
        fromTurns.cache_read_input_tokens += turn.cache_read_input_tokens
        fromTurns.context_tokens = turn.context_tokens
        if (event.reasoning_tokens != null) {
          reasoningFromTurns = (reasoningFromTurns || 0) + count(event.reasoning_tokens)
        }
        break
      }
      case "metadata":
        // The real event nests everything under `meta`.
        if (event.meta && typeof event.meta === "object") meta = event.meta
        break
      case "session_capture":
        if (typeof event.saved_session_id === "string" && event.saved_session_id.trim()) {
          sessionId = event.saved_session_id.trim()
        }
        break
      case "error":
        errors.push(String(event.error || event.message || "").slice(0, 300))
        break
      case "done":
        sawResult = true
        out.stopReason = event.status || "done"
        break
      default:
        break
    }
  }

  // The receipt's totals include what delegated children spent; the per-call
  // events do not. Whichever saw more is the truth. Occupancy stays the last
  // per-call reading either way — the receipt is cumulative, and cumulative
  // is the one thing occupancy must never be read from.
  let usage = { ...fromTurns }
  let usageSource = turns > 0 ? "turn_usage" : null
  if (hasCounts(meta)) {
    const fromMeta = additiveUsageFrom(meta)
    if (turns === 0 || spentOf(fromMeta) > spentOf(fromTurns)) {
      usage = { ...fromMeta, context_tokens: fromTurns.context_tokens }
      usageSource = "metadata"
    }
  }

  // Informational: reasoning is already inside output_tokens. Absent when no
  // event reported it — absent means unknown, never 0.
  const reasoning = usageSource === "metadata" && meta.reasoning_tokens != null
    ? count(meta.reasoning_tokens)
    : reasoningFromTurns
  if (reasoning != null) usage.reasoning_tokens = reasoning
  if (turns > 0) usage.num_turns = turns
  // The id `codewhale exec --resume <id>` takes next time. Reported, not yet
  // consumed: the engine renders the whole conversation into the prompt, and
  // resuming on top of that would replay the history twice.
  if (sessionId) usage.runtime_session_id = sessionId

  if (meta) {
    if (typeof meta.model === "string" && meta.model.trim()) {
      out.model = meta.model.trim()
      usage.model_label = out.model
    }
    out.runtimeMeta.provider = meta.provider ?? null
    out.runtimeMeta.routeSource = meta.route_source ?? null
    out.runtimeMeta.status = meta.status ?? null
    out.runtimeMeta.terminationReason = meta.termination_reason ?? null
  }
  out.runtimeMeta.usageSource = usageSource

  // `error` events carry warnings as well as failures (a retried request, a
  // deprecation notice); the terminal receipt's `status` is the outcome
  // CodeWhale itself exits on. Without a receipt — the process died mid-stream
  // — any error event is the outcome.
  const status = typeof meta?.status === "string" ? meta.status.toLowerCase() : null
  const failed = status ? FAILED_STATUSES.has(status) : errors.length > 0
  if (failed) {
    out.isError = true
    out.errorStatus = String(meta?.error || errors.at(-1) || `CodeWhale ended with status ${status}`).slice(0, 300)
  } else {
    out.runtimeMeta.warnings = errors.filter(Boolean)
  }

  out.usage = usage
  out.content = text.join("")
  return { ...out, sawResult }
}

export const codewhale = {
  id: "codewhale",
  name: "CodeWhale",
  cli: "codewhale",
  install: "https://github.com/Hmbown/CodeWhale",
  binEnvVar: "CMA_CODEWHALE_BIN",
  // Cargo installs land in ~/.cargo/bin, which the generic sweep does not
  // cover; npm globals it already finds.
  extraHomePaths: [".cargo/bin/codewhale"],

  // CODEWHALE_HOME is CodeWhale's own, documented way to relocate its config,
  // so two provider setups (a work DeepSeek key and a personal one) isolate
  // the same way two Claude logins do. The empty slug stays ambient: most
  // machines have one setup, in ~/.codewhale, and it should work untouched.
  configDirEnvVar: "CODEWHALE_HOME",
  profilesDirName: "codewhale-profiles",

  versionArgs: ["--version"],
  // "Login" is CodeWhale's own onboarding: it prompts for a provider and key
  // in its TUI. We hand over the terminal, same as every other runtime.
  loginArgs: () => [],
  loginHint: "run `codewhale` once and add your DeepSeek API key (or point it at your own model)",
  probeArgs: () => [
    CLI.skipOnboarding, CLI.noProjectConfig, CLI.exec, ...CLI.streamFormat,
    ...CLI.sandbox("read-only"), ...CLI.disallowedTools(CHAT_DISALLOWED_TOOLS),
    CLI.separator, "Reply with the single word: ok"
  ],

  // The prompt is a positional after `--` — see streamingArgs.
  promptOnStdin: false,
  supportsBuffered: false,

  streamingArgs,

  // Writes the MCP file CODEWHALE_MCP_CONFIG points at — see the header. Runs
  // for the ambient login too, which is why the engine calls prepare()
  // whether or not there is a managed config directory.
  prepare(job, { filesDir }) {
    writeConfig(job, mcpPathIn(filesDir()))
  },

  // The MCP variable is set only when the file was actually written: pointing
  // CodeWhale at a path that does not exist would be an error where "no MCP"
  // is the honest state.
  //
  // CODEWHALE_TELEMETRY=0 is CodeWhale's documented run-scoped kill switch
  // (docs/TELEMETRY.md: "stops collection, erases nothing"): a run this
  // companion drives is the platform's traffic, not the user's own usage,
  // and it should not be posted to telemetry.codewhale.net on their behalf.
  envFor: (job, { filesDir } = {}) => {
    const env = { ...envForGithub(job), ...envForWeb(job), CODEWHALE_TELEMETRY: "0" }
    if (filesDir && Object.keys(mcpServersFor(job)).length > 0) {
      env.CODEWHALE_MCP_CONFIG = mcpPathIn(filesDir())
    }
    return env
  },

  describeEvent,
  collapseEvents,
  partialTextFrom,
  writtenPathFrom,
  classifyFailure: (detail) =>
    classifyFailure(detail, {
      name: "CodeWhale",
      loginHint: "run `codewhale` once and check its provider configuration"
    }),

  limitations: [
    "The forbidden-git deny list is not enforced by a CodeWhale flag — the workspace-write " +
      "sandbox and the system prompt are the bounds.",
    "What a run can spend is whatever provider CodeWhale itself is configured with — " +
      "a DeepSeek API key bills per token, not a monthly plan."
  ],

  resolveBin() {
    return locateBin({ cli: this.cli, envVar: this.binEnvVar, extraHomePaths: this.extraHomePaths })
  },

  advice() {
    const { bin, source } = this.resolveBin()
    return locationAdvice({ name: this.name, install: this.install, bin, source })
  }
}
