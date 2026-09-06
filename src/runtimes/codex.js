import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  classifyFailure, emptyUsage, envForGithub, envForWeb, locateBin, locationAdvice, loginCommand,
  lastTurnOccupancy, maskAccount, mcpServersFor, normalizeUsage, shortCommand, shortPath
} from "./shared.js"

// ---------------------------------------------------------------------------
// OpenAI's Codex CLI (`codex`), in its non-interactive form: `codex exec`.
//
// The flag surface below is what a real build's exec mode actually parses —
// read out of exec-mode experiments against codex 0.114.0 rather than from
// prose, and the parts that matter here have been stable across the Rust
// rewrite:
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
  model: (id) => ["--model", id],
  sandbox: (level) => ["--sandbox", level],
  fullAuto: "--full-auto",
  cd: (dir) => ["--cd", dir],
  skipGitRepoCheck: "--skip-git-repo-check",
  config: (pair) => ["-c", pair]
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

  return args
}

// The prompt travels on stdin (`exec -`), never as a positional — same
// reasoning as the Claude Code adapter: stdin has no ARG_MAX ceiling and
// nothing can swallow it. `-` must stay LAST so no flag value can absorb it.
export function streamingArgs(job) {
  return [CLI.exec, CLI.json, ...baseArgs(job), CLI.stdin]
}

// Codex has no --append-system-prompt in exec mode we are willing to lean on
// (`-c developer_instructions=…` exists but puts the whole system text into
// argv, visible in `ps`), so the system text rides the prompt the way Cursor's
// and Gemini's do — visibly fenced, never silently glued.
export function renderPrompt(job, conversation) {
  if (!job.system) return conversation
  return `<system>\n${job.system}\n</system>\n\n${conversation}`
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
// The event stream.
//
// codex exec --json emits JSONL: thread.started, turn.started, then
// item.started/item.completed pairs, closing with turn.completed (usage) or
// turn.failed (error). Items carry a `type` discriminator — agent_message,
// reasoning, command_execution, file_change, mcp_tool_call, web_search — and
// the fields are read defensively because they are another product's format.
// ---------------------------------------------------------------------------

function itemOf(event) {
  if (!event || typeof event !== "object") return null
  if (!["item.started", "item.updated", "item.completed"].includes(event.type)) return null
  return event.item && typeof event.item === "object" ? event.item : null
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
    stopReason: null, isError: false, errorStatus: null
  }

  let sawResult = false
  const answers = []
  // How full the window was on the LAST prompt, which `turn.completed.usage`
  // cannot answer: that object is the SESSION's cumulative token count, so on
  // a long run it grows past the window (openai/codex#17539 reports 6.9M
  // cumulative input against a 272K window). Codex tracks the per-request
  // figure internally as ThreadTokenUsage.last and the interactive TUI draws
  // its own context meter from it; the exec JSONL writer historically dropped
  // it on the way out.
  //
  // So this reads the per-request field where a build emits one — under any
  // of the spellings that shape has been given — and reports 0 where none is
  // present. 0 means "unknown" and the composer draws no meter, which is the
  // correct reading of a Codex run today rather than a placeholder for one.
  let contextTokens = 0

  for (const event of events) {
    // `token_count` carries the same accounting on builds that emit it, with
    // the per-request figure nested under `info`.
    if (event?.type === "token_count") {
      contextTokens = lastTurnOccupancy(event) || contextTokens
    }

    if (event?.type === "item.completed") {
      const item = itemOf(event)
      if (item && (item.item_type || item.type) === "agent_message") {
        const text = item.text ?? item.content ?? item.message
        if (typeof text === "string" && text) answers.push(text)
      }
      if (item && (item.item_type || item.type) === "error") {
        out.isError = true
        out.errorStatus = String(item.message || item.text || "").slice(0, 300) || out.errorStatus
      }
    }

    if (event?.type === "turn.completed") {
      sawResult = true
      out.stopReason = "completed"
      out.usage = normalizeUsage(event.usage)
      contextTokens = lastTurnOccupancy(event) || contextTokens
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

  // The answer is the final agent message; earlier ones are progress notes on
  // a multi-step run. Falling back to the join keeps a partial run's words.
  out.content = answers.at(-1) || answers.join("")
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
