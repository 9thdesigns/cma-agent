import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  classifyFailure, emptyUsage, envForGithub, envForWeb, FORBIDDEN_GIT, isExecutable, loginCommand,
  locateBin, locationAdvice, mcpServersFor, normalizeUsage, occupancyOf, shortCommand, shortPath
} from "./shared.js"

// ---------------------------------------------------------------------------
// Cursor's headless agent (`cursor-agent`, also installed as `agent`).
//
// Worth having alongside Claude Code for one reason: the catalogue. A single
// Cursor subscription reaches Cursor's own Composer models AND the frontier
// models from Anthropic, OpenAI, Google and xAI, under Cursor's own model ids.
//
// Nothing here has been run against a real build by this codebase's authors.
// Every flag, event and field is verified against dated third-party captures
// of real builds (2026.05 → 2026.08) and Cursor's own published SDK types.
// The usage shape it reports is tabled in docs/internal/provider-wire-contracts.md.
// As with every other product's CLI, when an upgrade breaks a run this file
// is the first thing to check against `cursor-agent --help`.
//
// ── Three differences from Claude Code that are NOT cosmetic ────────────────
//
// 1. Permissions. There is no per-invocation tool allowlist. What the CLI has
//    is `--force` — its own help text: "force allow commands unless explicitly
//    denied" — an OS sandbox (`--sandbox enabled`, also its default), and a
//    permissions file, `cli-config.json`, whose `permissions.deny` entries are
//    the only thing that stops a command under --force. Under --force an ALLOW
//    list is moot: everything not denied runs.
//
//    So a repository turn here runs with EVERY shell command allowed except
//    the denied ones, inside Cursor's sandbox. That is wider than the Claude
//    Code path's enumerated git verbs, and it is stated rather than dressed
//    up: an earlier version of this adapter wrote an allow list into
//    `permissions.json`, a file the CLI reads allow-only and which --force
//    makes irrelevant, and called that the boundary. It never was one.
//
//    Verified (third-party probes on real builds): cli-config.json is the file
//    the CLI enforces from, and an exact full-command `Shell(<command>)` deny
//    entry blocks that command under --force. NOT verified: whether
//    `Shell(git push --force)` also blocks `git push --force origin main`
//    (prefix or glob matching). The deny list is written in both spellings so
//    it is as wide as the CLI will honour. See permissionsFor / writeConfig.
//
// 2. There is no inline `--mcp-config` we can rely on. Cursor discovers MCP
//    servers from mcp.json on disk. We write one into our own config
//    directory (it names a command and carries no secret — the GitHub token
//    travels by environment, exactly as for Claude Code) and pass
//    `--approve-mcps`, without which a headless run cannot load a server at
//    all. Whether CURSOR_CONFIG_DIR relocates the mcp.json lookup is
//    unverified — one 2026.06 capture says it does not — so the platform's
//    GitHub and web tools may simply be absent from a Cursor run today.
//
// 3. There is no `--append-system-prompt`. Cursor reads rules from AGENTS.md,
//    .cursorrules and .cursor/rules/*.md — all of which live in the user's
//    repository. Writing into a folder somebody shared with us to read is not
//    something to do quietly, so the system text is prepended to the prompt
//    instead. Nothing is written into the user's repo or into their ~/.cursor.
// ---------------------------------------------------------------------------

const CLI = {
  print: "-p",
  streamFormat: ["--output-format", "stream-json"],
  // A headless run in a directory Cursor has not trusted yet stops on a
  // "Workspace Trust Required" prompt nobody can answer. `--trust` (a 2026
  // flag, "only with --print") answers it up front. A build older than
  // spring 2026 rejects it and the run fails visibly rather than hanging.
  trust: "--trust",
  // "Force allow commands unless explicitly denied" — bounded ONLY by the
  // deny list in cli-config.json plus the sandbox. See the header.
  force: "--force",
  sandbox: ["--sandbox", "enabled"],
  // Load the MCP servers named on disk without an interactive approval.
  approveMcps: "--approve-mcps",
  resume: (id) => ["--resume", id],
  model: (id) => ["--model", id],
  workspace: (dir) => ["--workspace", dir]
}

// ── Permissions ─────────────────────────────────────────────────────────────

// Both spellings of each forbidden command. The exact full-command form is
// the one a probe proved blocks under --force; the glob form is what Cursor's
// documentation describes for "this command with any arguments" and is
// unproven — inert at worst, wider at best.
function denyEntries() {
  return FORBIDDEN_GIT.flatMap((command) => [`Shell(${command})`, `Shell(${command} *)`])
}

// Exported so the boundary a repository turn actually runs with can be
// asserted without spawning anything. This is a security decision and it
// should not be reachable only through a child process.
export function permissionsFor() {
  return {
    permissions: {
      // Empty on purpose, for both kinds of turn. A repository turn runs
      // under --force, where an allow list changes nothing; a chat turn runs
      // without --force and without a workspace, and nothing there should be
      // pre-approved at all.
      allow: [],
      deny: denyEntries()
    }
  }
}

// The whole file, in the shape a probe against the installed bundle proved
// the CLI reads (`version`, `editor`, `permissions.{allow,deny}`; partial
// files are deep-merged over the CLI's defaults).
export function cliConfigFor(job) {
  return { version: 1, editor: { vimMode: false }, ...permissionsFor(job) }
}

// Everything we put on disk goes in OUR directory, never in ~/.cursor and
// never in the user's repository. `configDir` is the per-profile directory the
// engine hands us, which is also what CURSOR_CONFIG_DIR points at — so the
// files are found without a flag, and removed with the profile.
export function writeConfig(job, configDir) {
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 })

  fs.writeFileSync(
    path.join(configDir, "cli-config.json"),
    `${JSON.stringify(cliConfigFor(job), null, 2)}\n`,
    { mode: 0o600 }
  )
  // The file earlier versions wrote. The CLI reads it allow-only and --force
  // ignores allow lists, so it never bounded anything; a leftover would only
  // mislead whoever reads the profile directory.
  fs.rmSync(path.join(configDir, "permissions.json"), { force: true })

  // Only when there is something to connect. A chat completion with no GitHub
  // credentials gets no MCP file at all rather than an empty one.
  const mcpPath = path.join(configDir, "mcp.json")
  const servers = mcpServersFor(job)
  if (Object.keys(servers).length > 0) {
    fs.writeFileSync(
      mcpPath,
      `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`,
      { mode: 0o600 }
    )
  } else if (fs.existsSync(mcpPath)) {
    // A previous run left one behind and this job has no GitHub grant. Removing
    // it is the difference between "the tools aren't offered" and "the tools
    // are offered and fail", and it keeps a stale endpoint from being reachable.
    fs.rmSync(mcpPath, { force: true })
  }
}

// ── The effort dial ─────────────────────────────────────────────────────────
//
// Cursor has no --effort flag; effort is part of the model id
// (`claude-opus-5-low`, `gpt-5.5-extra-high`). So the dial is applied by
// rewriting the id to the sibling at the wanted level — and only ever to a
// sibling a real `cursor-agent --list-models` listed. This table IS that
// listing (build 2026.08.25-3e8eec8, 204 ids, identical in four independent
// captures; a later capture added claude-fable-5-1 and gemini-3.8-flash),
// keyed by the id with its effort token and any `-fast` removed.
//
// `max` is never chosen. On Anthropic ids Cursor's `-max` is the Max-mode
// variant (1M context, billed at the vendor's long-context tier — up to 6x),
// not just an effort level, and `-fast` is a priced priority tier. The dial
// must never move someone onto a pricier variant they did not pick; it can
// only select among the low / medium / high / xhigh siblings. A `-max` or
// `-fast` the user chose themselves is kept.
const L_M_H = ["low", "medium", "high"]
const L_M_H_X = ["low", "medium", "high", "xhigh"]
const L_M_H_X_MAX = ["low", "medium", "high", "xhigh", "max"]
const N_L_M_H_X = ["none", "low", "medium", "high", "xhigh"]
const N_L_M_H_X_MAX = ["none", "low", "medium", "high", "xhigh", "max"]

export const EFFORT_VARIANTS = Object.freeze({
  // Older grammar: claude-<ver>-<family>-<effort>; the `-thinking` forms of
  // these end in "thinking" and carry no effort token to rewrite.
  "claude-4.5-opus": ["high"],
  "claude-4.6-opus": ["high", "max"],
  "claude-4.6-sonnet": ["medium"],
  // Newer grammar: claude-<family>-<ver>[-thinking]-<effort>[-fast].
  "claude-fable-5": L_M_H_X_MAX,
  "claude-fable-5-thinking": L_M_H_X_MAX,
  "claude-fable-5-1": L_M_H_X_MAX,
  "claude-fable-5-1-thinking": L_M_H_X_MAX,
  "claude-opus-4-7": L_M_H_X_MAX,
  "claude-opus-4-7-thinking": L_M_H_X_MAX,
  "claude-opus-4-8": L_M_H_X_MAX,
  "claude-opus-4-8-thinking": L_M_H_X_MAX,
  "claude-opus-5": L_M_H,
  "claude-opus-5-thinking": L_M_H_X_MAX,
  "claude-sonnet-5": L_M_H_X_MAX,
  "claude-sonnet-5-thinking": L_M_H_X_MAX,
  "cursor-grok-4.5": L_M_H,
  "cursor-grok-4.6": L_M_H_X,
  "gemini-3.6-flash": ["minimal", "low", "medium", "high"],
  "gemini-3.7-flash": L_M_H,
  "gemini-3.8-flash": L_M_H,
  "glm-5.2": ["high", "max"],
  "gpt-5.1": ["low", "high"],
  "gpt-5.2": ["low", "high", "xhigh"],
  "gpt-5.3-codex": ["low", "high", "xhigh"],
  "gpt-5.4": L_M_H_X,
  "gpt-5.4-mini": N_L_M_H_X,
  "gpt-5.4-nano": N_L_M_H_X,
  "gpt-5.5": ["none", "low", "medium", "high", "extra-high"],
  "gpt-5.6-luna": N_L_M_H_X_MAX,
  "gpt-5.6-sol": N_L_M_H_X_MAX,
  "gpt-5.6-terra": N_L_M_H_X_MAX,
  "kimi-k3": ["low", "high", "max"]
})

const EFFORT_TOKEN = /-(none|minimal|low|medium|high|xhigh|extra-high|max)(-fast)?$/
// Ai::Effort::LEVELS — the only words the server sends.
const DIAL = new Set(["low", "medium", "high", "xhigh", "max"])

// The sibling at `want`, or null for "leave the id alone".
//
// Exact or nothing for low / medium / high: a level the family does not
// offer is not approximated in either direction, because a bare id like
// `gpt-5.2` IS the family's default and guessing which way to move would be
// inventing a preference. xhigh takes the family's own spelling of it
// (`extra-high` on gpt-5.5) and falls back to high; max is xhigh's rule —
// never `-max` itself, see above.
function pickFor(want, offered) {
  const has = (level) => offered.includes(level)
  if (want === "xhigh" || want === "max") {
    if (has("xhigh")) return "xhigh"
    if (has("extra-high")) return "extra-high"
    return has("high") ? "high" : null
  }
  return has(want) ? want : null
}

export function effortModel(id, level) {
  const want = String(level || "").trim().toLowerCase()
  if (!id || !DIAL.has(want)) return id

  const match = id.match(EFFORT_TOKEN)
  const base = match ? id.slice(0, match.index) : id
  const current = match ? match[1] : null
  const fast = (match && match[2]) || ""
  // The user's own `-max` stands when the dial agrees with it.
  if (current === "max" && want === "max") return id

  const offered = EFFORT_VARIANTS[base]
  let pick = null
  if (offered) {
    pick = pickFor(want, offered)
  } else if (current && (want === "low" || want === "medium" || want === "high")) {
    // A family this table has not seen. Swap the token only among the three
    // levels every family on the build offered; never invent an xhigh or
    // max sibling for an id nobody has listed.
    pick = want
  }

  if (!pick || pick === current) return id
  return `${base}-${pick}${fast}`
}

// ── Session continuity ──────────────────────────────────────────────────────
//
// Every `result` (and `system/init`) event names the Cursor session the run
// happened in. It is reported as usage.runtime_session_id, and when the
// server hands one back as job.runtime_session_id the run resumes that
// session instead of starting a fresh one with the whole history flattened
// into the prompt. Resumed, the prompt is only what is new since the last
// assistant turn — Cursor already holds the rest, and the system text was
// part of the first turn (the server keeps it byte-stable across turns).
//
// Read defensively: an older server never sends the key, and a key with no
// new message to send (nothing after the last assistant turn) means there
// is nothing to resume WITH, so the turn runs fresh.
function newMessagesSince(job) {
  const messages = Array.isArray(job.messages) ? job.messages : []
  let lastAssistant = -1
  messages.forEach((message, index) => { if (message?.role === "assistant") lastAssistant = index })
  return messages.slice(lastAssistant + 1)
}

export function resumeSessionId(job) {
  const id = typeof job.runtime_session_id === "string" ? job.runtime_session_id.trim() : ""
  // It goes on argv: nothing that could read as a flag or as more than one word.
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(id)) return null
  return newMessagesSince(job).length > 0 ? id : null
}

function renderMessages(messages) {
  return messages
    .map((message) => (typeof message.content === "string" ? message.content : JSON.stringify(message.content)))
    .join("\n\n")
}

export function baseArgs(job) {
  const args = []
  if (job.model) args.push(...CLI.model(effortModel(job.model, job.effort)))
  // Bounded by the deny list prepare() has already written, and the sandbox.
  if (job.workdir) {
    args.push(CLI.force, ...CLI.sandbox, ...CLI.workspace(job.workdir))
  }
  if (Object.keys(mcpServersFor(job)).length > 0) args.push(CLI.approveMcps)
  return args
}

// The prompt is on STDIN, never on argv. `-p` with no positional reads it
// from stdin; on argv a single string is capped at 128 KiB on Linux, so a
// code session whose history passed that failed to spawn at all (E2BIG), and
// the whole conversation showed in `ps`. The engine knows from
// `promptOnStdin`; the second parameter is accepted and ignored so a caller
// written for the positional form cannot leak the prompt onto argv.
export function streamingArgs(job) {
  const args = [CLI.print, ...CLI.streamFormat, CLI.trust]
  const session = resumeSessionId(job)
  if (session) args.push(...CLI.resume(session))
  return [...args, ...baseArgs(job)]
}

// Cursor has no system-prompt flag, so the system text rides the prompt. Kept
// visibly separated rather than glued on, so a model reading it can tell the
// operator's instructions from the conversation. On a resumed session only
// the new messages go, bare — see resumeSessionId.
export function renderPrompt(job, conversation) {
  if (resumeSessionId(job)) return renderMessages(newMessagesSince(job))
  if (!job.system) return conversation
  return `<system>\n${job.system}\n</system>\n\n${conversation}`
}

// ── Usage ───────────────────────────────────────────────────────────────────
//
// The result event's usage is Cursor's SDK shape, camelCase and ADDITIVE:
//   {"inputTokens":1227,"outputTokens":13,"cacheReadTokens":10624,"cacheWriteTokens":0}
// (a real capture, build 2026.05.04, for the prompt "what is 1+1" — the
// 10,624 cached tokens are Cursor's own system prompt, rules and tool
// schemas, read against 1,227 fresh ones, which is why inputTokens cannot
// contain them). Spelled here into the canonical additive shape BEFORE the
// shared normalizer, which knows neither name; the snake_case spellings are
// still accepted for a build that emits them. Reasoning tokens, when a build
// ever reports them, are a subset of outputTokens per the SDK — informational.
export function cursorUsage(usage) {
  if (!usage || typeof usage !== "object") return normalizeUsage({})

  const out = normalizeUsage({
    ...usage,
    input_tokens: usage.input_tokens ?? usage.inputTokens,
    output_tokens: usage.output_tokens ?? usage.outputTokens,
    cache_read_input_tokens: usage.cache_read_input_tokens ?? usage.cacheReadTokens,
    cache_creation_input_tokens: usage.cache_creation_input_tokens ?? usage.cacheWriteTokens
  })

  const reasoning = usage.reasoning_tokens ?? usage.reasoningTokens
  if (reasoning != null && Number.isFinite(Number(reasoning))) out.reasoning_tokens = Number(reasoning)
  return out
}

// cursor-agent emits tool calls as their OWN top-level events with explicit
// started/completed subtypes, rather than embedding tool_use inside an
// assistant message the way Claude Code does. That is the one structural
// difference between the two streams.
function toolNameOf(toolCall) {
  if (!toolCall || typeof toolCall !== "object") return null
  return Object.keys(toolCall).find((key) => key.endsWith("ToolCall")) || null
}

function describeEvent(event) {
  if (!event || typeof event !== "object") return null

  if (event.type === "system" && event.subtype === "init") return "Starting up"

  if (event.type === "tool_call" && event.subtype === "started") {
    const name = toolNameOf(event.tool_call)
    if (!name) return "Working"

    const inner = event.tool_call[name] || {}
    const args = inner.args || inner || {}
    const file = shortPath(args.path || args.file_path || args.target_file)

    switch (name) {
      case "editToolCall":   return file ? `Editing ${file}` : "Editing a file"
      case "writeToolCall":  return file ? `Writing ${file}` : "Writing a file"
      case "deleteToolCall": return file ? `Deleting ${file}` : "Deleting a file"
      case "readToolCall":   return file ? `Reading ${file}` : "Reading a file"
      case "lsToolCall":
      case "listToolCall":   return file ? `Looking in ${file}` : "Looking for files"
      case "shellToolCall": {
        const cmd = shortCommand(args.command)
        return cmd ? `Running ${cmd}` : "Running a command"
      }
      case "grepToolCall":
      case "searchToolCall": {
        const pattern = String(args.pattern || args.query || "").trim().slice(0, 40)
        return pattern ? `Searching for ${pattern}` : "Searching the code"
      }
      case "todoToolCall":   return "Updating the plan"
      case "webToolCall":
      case "fetchToolCall": {
        let host = ""
        try { host = new URL(String(args.url || "")).host } catch { host = "" }
        return host ? `Reading ${host}` : "Searching the web"
      }
      default: {
        // mcpToolCall and anything Cursor adds later. Strip the suffix and
        // space out the camel case, same as the Claude Code fallback.
        const pretty = name.replace(/ToolCall$/, "").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase()
        return pretty ? `${pretty.charAt(0).toUpperCase()}${pretty.slice(1)}`.slice(0, 60) : "Working"
      }
    }
  }

  // `thinking` is Cursor's reasoning channel — private scratchwork, and it
  // arrives constantly, so it is a liveness signal and not a ticker line.
  if (event.type === "thinking") return "Thinking"

  return null
}

function textOf(message) {
  if (!message || !Array.isArray(message.content)) return ""
  return message.content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("")
}

// Assistant events carry segments of the answer as they are produced, so they
// double as the partial-text stream. The final answer still comes from the
// `result` event, so if a build ever emits cumulative rather than incremental
// assistant events the worst case is a repeated fragment in the live ticker,
// corrected the moment the run finishes. (`--stream-partial-output` is
// deliberately NOT passed: with it the answer arrives as deltas AND then once
// more as a consolidated replay, which this fold would double.)
function partialTextFrom(event) {
  if (event?.type !== "assistant") return null
  return textOf(event.message) || null
}

// A model ID as Cursor spells one (`composer-2.5`, `claude-opus-5-high`,
// `gpt-5.5[effort=high]`) rather than a display label ("Composer 2.5").
function idShaped(value) {
  return typeof value === "string" && /^[a-z0-9][a-z0-9._[\]=,-]*$/.test(value)
}

function collapseEvents(events) {
  const out = {
    content: "", usage: emptyUsage(), model: null,
    stopReason: null, isError: false, errorStatus: null
  }

  let sawResult = false
  let sessionId = null
  let modelLabel = null
  const assistantText = []
  // How full the window was on the run's LAST prompt — not the run's total,
  // which is what `result.usage` carries (a per-invocation SUM over the run's
  // internal model calls: on a long run cacheReadTokens exceeds any window).
  //
  // No Cursor build has been seen to populate message.usage on assistant
  // events. This is written as "use it if it is there": on a build that
  // reports it the meter is exact, and on one that doesn't the value stays 0
  // and the composer draws no meter rather than drawing the run total.
  let contextTokens = 0

  for (const event of events) {
    if (event?.type === "system" && event.subtype === "init") {
      // Always reported as model_label — what the CLI said it ran, beside the
      // id the job asked for. Whether the value is the id (`composer-2.5`) or
      // the display label (`Composer 2.5`) is unverified, and the server keeps
      // `model` as the id the Usage page shows and prefix-matches a window
      // for, so only an id-shaped value is promoted to it; a label stays a
      // label and the server falls back to the id it asked for.
      if (event.model) {
        modelLabel = String(event.model)
        if (idShaped(modelLabel)) out.model = modelLabel
      }
      if (event.session_id) sessionId = String(event.session_id)
    }

    if (event?.type === "assistant") {
      const text = textOf(event.message)
      if (text) assistantText.push(text)
      if (idShaped(event.message?.model)) out.model = event.message.model
      // Subagent turns run their own conversation in their own window, so
      // their occupancy says nothing about this one's — `parent_tool_use_id`
      // is what marks them, same as in the Claude Code adapter.
      if (!event.parent_tool_use_id && event.message?.usage) {
        const occupancy = occupancyOf(cursorUsage(event.message.usage))
        if (occupancy > 0) contextTokens = occupancy
      }
    }

    if (event?.type === "result") {
      sawResult = true
      if (typeof event.result === "string") out.content = event.result
      out.stopReason = event.subtype || event.stop_reason || null
      // Same trap as Claude Code: an in-band failure comes back with a zero
      // exit code and is_error true.
      out.isError = event.is_error === true
      out.errorStatus = event.api_error_status || null
      out.usage = cursorUsage(event.usage)
      if (event.session_id) sessionId = String(event.session_id)
    }
  }

  // After the loop: the `result` event replaces `usage` wholesale and arrives
  // last, so assigning these inside it would hand the server the run total
  // under the per-turn name.
  out.usage.context_tokens = contextTokens
  // Only when known — an absent key means "unknown" to the server, a 0 or ""
  // would mean something.
  if (sessionId) out.usage.runtime_session_id = sessionId
  if (modelLabel) out.usage.model_label = modelLabel

  if (!out.content) out.content = assistantText.join("")
  return { ...out, sawResult }
}

// ── Locating the binary ─────────────────────────────────────────────────────
//
// Cursor's installer provides the same binary under two names: `agent` (its
// primary name since mid-2026) and `cursor-agent`. Only the specific name is
// searched on PATH — `agent` is generic enough that another vendor's installer
// claims it (xAI's does, and that binary rejects --force/--trust/--workspace).
// An `agent` is accepted only when it resolves into a directory Cursor's own
// installer owns.
const CURSOR_OWNED_DIRS = [".cursor", path.join(".local", "share", "cursor-agent")]

export function cursorOwnedAgent(relPaths, home = os.homedir()) {
  let realHome
  try { realHome = fs.realpathSync(home) } catch { return null }

  for (const rel of relPaths) {
    const candidate = path.join(home, rel)
    if (!isExecutable(candidate)) continue

    let real
    try { real = fs.realpathSync(candidate) } catch { continue }
    const owned = CURSOR_OWNED_DIRS.some((dir) => real.startsWith(path.join(realHome, dir) + path.sep))
    if (owned) return candidate
  }
  return null
}

export const cursor = {
  id: "cursor",
  name: "Cursor",
  cli: "cursor-agent",
  install: "https://cursor.com/cli",
  binEnvVar: "CMA_CURSOR_BIN",
  extraHomePaths: [".cursor/bin/cursor-agent", ".local/bin/cursor-agent"],
  // The `agent` name, and only from these — see cursorOwnedAgent.
  agentHomePaths: [".cursor/bin/agent", ".local/bin/agent"],

  configDirEnvVar: "CURSOR_CONFIG_DIR",
  profilesDirName: "cursor-profiles",

  // Cursor is the one runtime with no ambient mode.
  //
  // Every other adapter can run with no config-directory override and pick up
  // whatever login the user already has. Cursor cannot, because the only
  // thing that bounds `--force` is a FILE (cli-config.json), and the only
  // directory we may write it to is one we own. Writing into ~/.cursor would
  // edit the config the user's editor reads; writing into the workspace would
  // edit their repository.
  //
  // So even the "default" profile gets a CMA-managed directory, and signing in
  // once with `cma-agent runtimes:login --runtime cursor` is a required step
  // rather than an optional one. The probe reports `logged_out` until it is
  // done, which is what makes that legible instead of mysterious.
  ambientProfile: false,

  versionArgs: ["--version"],
  loginArgs: () => ["login"],
  loginHint: loginCommand("cursor"),
  // The probe keeps its prompt positional: it runs through run(), which pipes
  // nothing on stdin.
  probeArgs: () => [CLI.print, "Reply with the single word: ok", ...CLI.streamFormat, CLI.trust],

  // The prompt goes on stdin — see streamingArgs.
  promptOnStdin: true,
  // `--output-format json` exists but its envelope carries NO usage at all
  // (verified 2026.06), so a buffered fallback would silently lose every
  // token count. stream-json ends with the same result envelope anyway.
  supportsBuffered: false,

  streamingArgs,
  renderPrompt,
  envFor: (job) => ({ ...envForGithub(job), ...envForWeb(job) }),

  // Called before every spawn, with the profile's config directory. This is
  // where the deny list and the MCP wiring land.
  prepare(job, { configDir }) {
    writeConfig(job, configDir)
  },

  describeEvent,
  collapseEvents,
  partialTextFrom,
  // Stated rather than papered over. Both gaps close with one look at a real
  // cursor-agent build: the web tool's name goes into BUILTIN_WEB_TOOLS.cursor
  // in shared.js and the deny list; a prefix-matching deny entry, once proven,
  // replaces the glob spelling in denyEntries.
  limitations: [
    "Cursor's own web search is not removed from the run — prefer the " +
      "mcp__cma_web__* tools, which need no approval.",
    "A repository turn runs with every shell command allowed except the denied " +
      "git commands, inside Cursor's sandbox — wider than Claude Code's git-only allowance."
  ],

  classifyFailure: (detail, context = {}) =>
    classifyFailure(detail, { name: "Cursor", loginHint: loginCommand("cursor", context.profileSlug) }),

  resolveBin() {
    const found = locateBin({ cli: this.cli, envVar: this.binEnvVar, extraHomePaths: this.extraHomePaths })
    if (found.bin) return found
    const agent = cursorOwnedAgent(this.agentHomePaths)
    return agent ? { bin: agent, source: "known-location" } : found
  },

  advice() {
    const { bin, source } = this.resolveBin()
    return locationAdvice({ name: this.name, install: this.install, bin, source })
  }
}
