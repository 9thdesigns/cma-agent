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

export function emptyUsage() {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0
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
    cache_read_input_tokens: Number(
      usage.cache_read_input_tokens || usage.cacheReadInputTokens || usage.cached_tokens || 0
    )
  }
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
