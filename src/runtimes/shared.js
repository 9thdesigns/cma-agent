import { accessSync, constants } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

// ---------------------------------------------------------------------------
// Finding another product's CLI.
//
// Spawning the bare name and letting PATH sort it out fails in two situations
// that are both normal rather than exotic, and they are the same for every
// vendor's installer:
//
//   1. The official install scripts put binaries in ~/.local/bin, which is not
//      on a default macOS PATH. The installer prints the line to add it, and a
//      user who hasn't run that line yet has the CLI installed and working
//      while we report it missing.
//
//   2. `cma-agent start` is meant to run unattended. A process launched by
//      launchd or systemd gets a minimal PATH and never reads a login shell's
//      profile, so ~/.local/bin is invisible to it no matter what the user's
//      terminal does. That one cannot be fixed by telling anyone to edit
//      .zshrc — the service and the shell do not share a PATH.
//
// So look it up ourselves, keep the absolute path, and spawn that.
// ---------------------------------------------------------------------------

// Relative to the home directory, most likely first. ~/.local/bin is where the
// official installers land; the rest cover npm/bun globals and older builds.
// These are generic on purpose — every CLI we drive is installed the same
// handful of ways.
export const HOME_BIN_DIRS = [
  ".local/bin",
  ".bun/bin",
  ".npm-global/bin",
  ".volta/bin",
  ".nvm/versions/node/current/bin"
]

export const SYSTEM_BIN_DIRS = [
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin"
]

export function isExecutable(file) {
  try {
    accessSync(file, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function searchPath(cli) {
  const entries = (process.env.PATH || "").split(path.delimiter).filter(Boolean)
  for (const dir of entries) {
    const candidate = path.join(dir, cli)
    if (isExecutable(candidate)) return candidate
  }
  return null
}

// { bin, source } — source is why we picked it, which is the difference
// between "install the CLI" and "your PATH is missing a directory".
//
// `extraHomePaths` covers the vendor-specific spots a generic bin directory
// sweep would miss (Claude Code's ~/.claude/local, for instance).
export function locateBin({ cli, envVar, extraHomePaths = [] }) {
  const override = envVar && process.env[envVar]
  if (override) return { bin: override, source: envVar }

  const onPath = searchPath(cli)
  if (onPath) return { bin: onPath, source: "PATH" }

  const home = homedir()
  const candidates = [
    ...extraHomePaths.map((rel) => path.join(home, rel)),
    ...HOME_BIN_DIRS.map((dir) => path.join(home, dir, cli)),
    ...SYSTEM_BIN_DIRS.map((dir) => path.join(dir, cli))
  ]

  const known = candidates.find(isExecutable)
  return known ? { bin: known, source: "known-location" } : { bin: null, source: "missing" }
}

// One line of advice matched to what we actually found, or null when there is
// nothing worth saying. Callers print this instead of guessing.
export function locationAdvice({ name, install, bin, source }) {
  if (source === "missing") {
    return `${name} isn't installed. Install it from ${install} and sign in — ` +
           "that's the login this machine will spend."
  }

  if (source === "known-location") {
    const dir = path.dirname(bin)
    return `Found ${name} at ${bin}, but ${dir} isn't on your PATH. Using it anyway. ` +
           `To fix your shell too:\n    echo 'export PATH="${dir}:$PATH"' >> ~/.zshrc && source ~/.zshrc`
  }

  return null
}

// ---------------------------------------------------------------------------
// Shapes every adapter's event mapper needs.
// ---------------------------------------------------------------------------

// `context_tokens` is the odd one out and deliberately so: the other four are
// what the run SPENT, summed over however many internal turns it took, and
// this one is how full the window was on the last of them. See
// lastTurnOccupancy below for which runtimes can answer it and which leave
// it 0.
export function emptyUsage() {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    context_tokens: 0
  }
}

// Read defensively: these are other products' output formats, and a version
// bump that renames a field should degrade to "we got the text but not the
// token counts" rather than to an empty answer.
export function normalizeUsage(usage = {}) {
  return {
    input_tokens: Number(usage.input_tokens || usage.inputTokens || usage.prompt_tokens || 0),
    output_tokens: Number(usage.output_tokens || usage.outputTokens || usage.completion_tokens || 0),
    cache_creation_input_tokens: Number(
      usage.cache_creation_input_tokens || usage.cacheCreationInputTokens || 0
    ),
    // The tail of this chain is per-vendor spelling: `cached_input_tokens` is
    // codex's, `prompt_cache_hit_tokens` CodeWhale's (DeepSeek's wire name).
    cache_read_input_tokens: Number(
      usage.cache_read_input_tokens || usage.cacheReadInputTokens || usage.cached_tokens ||
      usage.cached_input_tokens || usage.prompt_cache_hit_tokens || 0
    ),
    // Derived per turn by the adapter, not reported by any vendor under this
    // name — see occupancyOf and the per-runtime notes beside it. Carried
    // through here only so re-normalizing an already-normalized hash is
    // lossless.
    context_tokens: Number(usage.context_tokens || 0)
  }
}

// How full the context window was on ONE prompt.
//
// Cache reads and cache writes are prompt tokens too — they are only billed
// differently — so the window's occupancy is all three input-side counts
// added together. The output tokens are not part of it: they are what came
// back, and they only enter the window as part of the NEXT prompt.
export function occupancyOf(usage) {
  const turn = normalizeUsage(usage)
  return turn.input_tokens + turn.cache_read_input_tokens + turn.cache_creation_input_tokens
}

// Which runtimes can answer "how full is the window", and which cannot.
//
// Every adapter here reports four totals for a run. Those totals are a SUM
// over however many API calls the run made, because an agentic runtime
// re-sends the whole conversation on every step — so on a twenty-step run
// they are roughly twenty times the size of any prompt that actually
// existed. Reading them as occupancy is what produced "2,479,706 of 200,000
// tokens — 100% context" on a session that was never close to full.
//
// Occupancy is a different measurement and has to come from a different
// place: the LAST prompt of the run, on its own. Whether an adapter can see
// that depends entirely on what its CLI emits, and the honest answer differs
// per runtime:
//
//   claude_code  every top-level `assistant` event carries the usage of the
//                prompt that produced it. Exact.
//   cursor       same stream contract (it is Claude Code's stream-json), so
//                the same derivation — when a build populates message.usage.
//   codewhale    emits a `turn_usage` event PER TURN. The last one is the
//                last prompt. Exact.
//   ollama       one /api/chat call per run, no tools, so prompt_eval_count
//                is the prompt. Exact.
//   codex        `turn.completed.usage` is cumulative for the session and
//                the per-request figure is discarded on the way to JSONL —
//                openai/codex#17539, which asked for exactly the field this
//                reads. Present: exact. Absent: 0.
//   gemini_cli   `result.stats` aggregates the session the same way.
//   antigravity  result-only usage, shape varies between builds.
//
// 0 means "this runtime did not tell us", NOT "the window is empty". The
// server treats it that way and draws no meter — see
// Code::GenerateResponseJob#context_occupancy. A missing meter is
// recoverable; a confident wrong one is not, which is the whole reason this
// is a separate field rather than a reinterpretation of the totals.
//
// Probes the shapes a vendor has used or has been asked for, longest-odds
// last, and returns 0 rather than guessing. `usage` on its own is never
// probed here: that is the cumulative object, and mistaking it for a turn is
// the bug this exists to prevent.
export function lastTurnOccupancy(source) {
  if (!source || typeof source !== "object") return 0

  const candidates = [
    source.last_usage, source.lastUsage,
    source.last_token_usage, source.lastTokenUsage,
    source.usage?.last, source.usage?.last_usage,
    source.info?.last_token_usage, source.info?.lastTokenUsage
  ]

  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") continue
    const occupancy = occupancyOf(candidate)
    if (occupancy > 0) return occupancy
  }

  return 0
}

export function firstKey(object) {
  if (!object || typeof object !== "object") return null
  const keys = Object.keys(object)
  return keys.length > 0 ? keys[0] : null
}

// Last two path segments — right for a file, wrong for everything else.
//
// The previous version applied this to every tool input including Bash
// commands, which turned `cd ~/proj && git log --oneline -5 | head -20` into
// "Running proj && git log --oneline -5 | head -" and `2>/dev/null` into
// "Running dev/null". Splitting a shell command on "/" was never going to
// produce a sentence.
export function shortPath(value) {
  const raw = String(value || "").trim().replace(/\/+$/, "")
  if (!raw) return ""
  return raw.split("/").filter(Boolean).slice(-2).join("/").slice(0, 48)
}

export function shortCommand(value) {
  let cmd = String(value || "").trim()
  if (!cmd) return ""
  // A leading `cd somewhere &&` is scaffolding, not the point of the command.
  cmd = cmd.replace(/^cd\s+[^&;|]+(&&|;)\s*/, "")
  // Collapse newlines and runs of spaces so a heredoc doesn't become a wall.
  cmd = cmd.replace(/\s+/g, " ").trim()
  return cmd.length > 60 ? `${cmd.slice(0, 57)}…` : cmd
}

// The exact command that signs THIS login back in.
//
// The profile matters and used to be missing. A machine where `cma-agent use
// 9th` sent unnamed work to the "9th" login failed with "sign in again
// (cma-agent runtimes:login --runtime claude_code)" — a command that, before
// this release, signed in the ambient login instead, leaving the credential
// that had actually expired untouched. Naming the profile makes the
// instruction true whichever login the run resolved to.
export function loginCommand(runtimeId, profileSlug = "") {
  const base = `cma-agent runtimes:login --runtime ${runtimeId}`
  return profileSlug ? `${base} --profile ${profileSlug}` : base
}

// Rate limits and expired logins are the two failures worth naming precisely:
// one means "wait or switch providers", the other means "run one command", and
// a generic message sends people looking in the wrong place.
export function classifyFailure(detail, { name, loginHint }) {
  const text = String(detail || "")
  const lower = text.toLowerCase()

  if (/rate limit|quota|usage limit|too many requests|out of credits|insufficient credit/.test(lower)) {
    return new Error(`Your ${name} plan is rate limited or out of included usage right now. ${text}`)
  }
  if (/login|log in|auth|unauthor|credential|sign in|api key|expired|forbidden/.test(lower)) {
    return new Error(`That ${name} login needs signing in again${loginHint ? ` (${loginHint})` : ""}. ${text}`)
  }
  return new Error(text || `${name} exited with an error.`)
}

// Our own entry point, resolved from this module rather than from argv, so it
// is right whether we were started as `cma-agent`, as `node bin/cma-agent.js`,
// or by a service manager with a different cwd.
export function selfPath() {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "bin", "cma-agent.js")
}

// ---------------------------------------------------------------------------
// What a repository turn is allowed to do, expressed once.
//
// `acceptEdits` on its own is edits and nothing else: every `git` invocation
// came back "This command requires approval", and a headless run has no
// terminal for anyone to approve in. So a session could rewrite the working
// tree and then had to ask the user to commit and push it by hand — which is
// the same dead end as "press the button", one layer down.
//
// The fix is not "allow everything". That would hand a coding turn the whole
// machine, and the boundary this companion is built around is that the user
// shares a folder and gets work done inside it, not that they hand over their
// laptop. So the allowance is enumerated: read and edit files, drive git, and
// call the GitHub operations tools. Everything else still stops and asks —
// which in a headless run means it doesn't happen.
//
// Every runtime expresses this in its own syntax. The SETS live here so the
// three adapters cannot drift apart on what a turn may do; only the spelling
// differs.
// ---------------------------------------------------------------------------

// Read-only inspection first, then the mutations a turn genuinely needs to
// ship its work.
export const GIT_VERBS = [
  "status", "diff", "log", "show", "branch", "remote", "rev-parse", "ls-files", "describe",
  "add", "commit", "checkout", "switch", "restore", "stash", "fetch", "pull", "merge",
  "rebase", "push", "tag", "cherry-pick"
]

// Deny beats allow. These are the git commands that destroy work rather than
// producing it — a force-push discards someone else's commits, `reset --hard`
// and `clean -fd` discard the user's. None of them is ever the only way to
// finish a task, so a turn that wants one can say so instead.
// Claude Code's own web tools, denied in EVERY job rather than merely left
// un-approved.
//
// Leaving them on the surface was the bug. `--allowedTools` is an
// auto-approve list, not an exclusive one, so WebFetch stayed in the tool
// schema the model is handed — and a tool the model can see beats a system
// prompt telling it not to reach for that tool. It then spends the turn
// asking for a grant that cannot arrive, because a headless run has nobody to
// answer a permission prompt. That is the transcript this whole web channel
// exists to prevent, and the prompt alone never fully stopped it.
//
// `--disallowedTools` removes them from the tool list rather than denying at
// call time, so there is nothing left to reach for and their schemas stop
// riding along in every request.
//
// Denied even when this job has no web channel of its own: a permission-gated
// tool in a headless run can never succeed, so it is dead weight there too —
// and the prompt already tells that run to say which page it could not read.
// Keyed by runtime id, because every CLI ships its own and calls them
// something different. One map so a runtime cannot be quietly left out: an id
// missing from here denies nothing, which is a silence worth being able to
// see in one place.
//
// Confidence differs per entry, and pretending otherwise is how an unverified
// vendor string ends up shipped as though it were checked:
//
//   claude_code — VERIFIED against the installed build. Denying three tools
//     that were present and asking the model to list what it has shows them
//     gone, so the deny removes them from the surface rather than refusing the
//     call.
//   gemini_cli  — from Gemini's documented tool set, the same set FILE_TOOLS in
//     gemini.js was read out of, and every name in that list matches. Not
//     machine-checked here. It rides --exclude-tools, which is registered as a
//     capability flag, so a build that does not take it degrades instead of
//     dying.
//   cursor      — EMPTY ON PURPOSE. cursor-agent names its tools in a
//     permissions file rather than a documented flag, and its web tool's name
//     was never verified against a real build. A guessed entry there would be
//     inert and would read as coverage, which is worse than the gap. Stated in
//     the adapter's `limitations` instead.
//   antigravity — same stated gap as cursor: agy's web tool names have not
//     been read off a real build, so nothing is denied and the adapter's
//     `limitations` says so.
//   codex       — empty because handled UPSTREAM of a deny: codex's web
//     search is opt-in (`--search` / `-c web_search=live`) and the adapter
//     never passes it, so the tool is off the surface already.
//   codewhale   — genuinely none in its default tool set
//     (read/write/edit/bash/agent/todo_write).
//   ollama      — genuinely none: that runtime has no tools at all.
export const BUILTIN_WEB_TOOLS = {
  claude_code: ["WebFetch", "WebSearch"],
  gemini_cli: ["google_web_search", "web_fetch"],
  cursor: [],
  antigravity: [],
  codex: [],
  codewhale: [],
  ollama: []
}

export function builtinWebTools(runtimeId) {
  return BUILTIN_WEB_TOOLS[runtimeId] || []
}

export const FORBIDDEN_GIT = [
  "git push --force",
  "git push -f",
  "git push --force-with-lease",
  "git reset --hard",
  "git clean",
  "git filter-branch"
]

// The MCP server carrying this app's GitHub connection. Named as a whole, so
// an operation added on the server side needs no companion release to be
// callable.
export const GITHUB_MCP_SERVER = "cma_github"

// Endpoint and token for the GitHub operations MCP server, passed by
// environment. Never an argument (arguments are visible in `ps`) and never a
// file (files outlive the run). Every adapter uses this, including the ones
// whose MCP config has to be a file — the file names a command, the
// environment carries the secret.
export function envForGithub(job) {
  if (!job.github?.token) return {}

  const env = {
    CMA_GITHUB_ENDPOINT: String(job.github.endpoint || ""),
    CMA_GITHUB_TOKEN: String(job.github.token)
  }

  // A session may be linked to several repositories. The list is not a
  // secret — it is names and branches — but it belongs with the endpoint, so
  // the MCP server can say which repositories `repo` will accept instead of
  // describing an argument with no legal values it knows about.
  if (Array.isArray(job.github.repos) && job.github.repos.length > 1) {
    env.CMA_GITHUB_REPOS = JSON.stringify(job.github.repos)
  }

  return env
}

// The MCP server definition, as every one of these CLIs spells it. `command`
// plus `args`, no `env` block: the token would otherwise sit on disk or in a
// config the model could read back. The CLI inherits our environment, so the
// server process picks it up from there.
export function githubMcpServers() {
  return {
    [GITHUB_MCP_SERVER]: { command: process.execPath, args: [selfPath(), "mcp-github"] }
  }
}

// The MCP server carrying the app's web access — fetch, browse, search and
// request, all run server-side with no permission prompt. Same shape as the
// GitHub server for the same reasons.
export const WEB_MCP_SERVER = "cma_web"

export function envForWeb(job) {
  if (!job.web?.token) return {}

  return {
    CMA_WEB_ENDPOINT: String(job.web.endpoint || ""),
    CMA_WEB_TOKEN: String(job.web.token)
  }
}

// Every server this job has credentials for, in one map — what both MCP
// config shapes (Claude Code's inline argument, Cursor's file) actually want.
// Gated per server: a job with GitHub credentials and no web grant mounts
// exactly what it can use, and vice versa.
export function mcpServersFor(job) {
  const servers = {}
  if (job.github?.token) Object.assign(servers, githubMcpServers())
  if (job.web?.token) {
    servers[WEB_MCP_SERVER] = { command: process.execPath, args: [selfPath(), "mcp-web"] }
  }
  return servers
}

// ---------------------------------------------------------------------------
// Masking an account address.
//
// Shared because every runtime that can name its login has the same question
// to answer, and because the shape has to be stable: it is what the web app
// falls back to when someone has asked us not to send the address itself.
// ---------------------------------------------------------------------------
export function maskAccount(value) {
  const text = String(value || "").trim()
  if (!text) return null

  const [user, domain] = text.split("@")
  if (!domain) return `${text.slice(0, 1)}•••`
  return `${user.slice(0, 1)}•••@${domain}`
}
