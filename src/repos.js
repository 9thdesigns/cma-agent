import { execFile } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"

import { readConfig, writeConfig } from "./config.js"

// ---------------------------------------------------------------------------
// Local repositories.
//
// The server can ask this machine about git repositories — branches, history,
// what is uncommitted — and can ask it to push a branch. That is a lot of reach
// into someone's laptop, so the boundary is drawn here and drawn once:
//
//   Nothing is visible until the user runs `cma-agent repos:add <path>`.
//
// There is no "scan my home directory" mode and no default root. Every command
// resolves its target against the allowlist below and refuses anything that
// lands outside it, symlinks and `..` included. The server is not trusted to
// send a safe path — it is treated as a request, and this file is the thing
// that says no.
//
// The other half of the boundary: we run git, and only git, with an argument
// array (never a shell string), so a branch name like `; rm -rf ~` is a bad
// branch name rather than a command.
// ---------------------------------------------------------------------------

// How deep under an allowlisted root we look for repositories. Two levels
// covers the shapes people actually use (~/code/project, ~/code/org/project)
// without walking a whole home directory.
const SCAN_DEPTH = 2

// Directories that are never worth descending into, and would each cost more
// than the whole rest of the scan.
const SKIP_DIRS = new Set([
  "node_modules", ".git", "vendor", "tmp", "dist", "build", ".next",
  "target", "Library", ".cache", "venv", ".venv", "__pycache__", "Pods"
])

const GIT_TIMEOUT_MS = 20000

export function expandHome(input) {
  const raw = String(input || "").trim()
  if (!raw) return ""
  if (raw === "~") return os.homedir()
  if (raw.startsWith("~/")) return path.join(os.homedir(), raw.slice(2))
  return raw
}

export function listRoots() {
  const roots = readConfig().repoRoots
  return Array.isArray(roots) ? roots : []
}

export function addRoot(input) {
  const resolved = path.resolve(expandHome(input))
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new Error(`${resolved} isn't a directory on this machine.`)
  }
  const roots = listRoots()
  if (!roots.includes(resolved)) {
    roots.push(resolved)
    writeConfig({ repoRoots: roots })
  }
  return resolved
}

export function removeRoot(input) {
  const resolved = path.resolve(expandHome(input))
  const roots = listRoots().filter((r) => r !== resolved)
  writeConfig({ repoRoots: roots })
  return resolved
}

// True only when `target` is an allowlisted root or genuinely inside one.
// `path.relative` is what makes this safe against `..`: an escaping path
// produces a relative that starts with "..", and an absolute one on a
// different drive produces an absolute result.
function withinRoot(target, root) {
  const rel = path.relative(root, target)
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))
}

// Resolve a path the server asked for, or throw. realpathSync is deliberate:
// a symlink inside an allowlisted root that points at ~/.ssh must be judged on
// where it lands, not on where it sits.
export function resolveRepo(requested) {
  const roots = listRoots()
  if (roots.length === 0) {
    throw new Error(
      "No repository folders are shared from this machine. Run `cma-agent repos:add ~/code` to share one."
    )
  }

  const target = path.resolve(expandHome(requested))
  let real
  try {
    real = fs.realpathSync(target)
  } catch {
    throw new Error(`${target} doesn't exist on this machine.`)
  }

  const allowed = roots.some((root) => {
    try {
      return withinRoot(real, fs.realpathSync(root))
    } catch {
      return false
    }
  })
  if (!allowed) {
    throw new Error(
      `${target} isn't inside a folder shared from this machine. Run \`cma-agent repos:add\` for its parent folder first.`
    )
  }

  if (!fs.existsSync(path.join(real, ".git"))) {
    throw new Error(`${target} isn't a git repository.`)
  }
  return real
}

export function git(cwd, args, { timeoutMs = GIT_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    execFile(
      "git",
      args,
      { cwd, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        resolve({
          ok: !error,
          code: error?.code ?? 0,
          stdout: String(stdout || ""),
          stderr: String(stderr || error?.message || "")
        })
      }
    )
  })
}

async function gitOrThrow(cwd, args) {
  const result = await git(cwd, args)
  if (!result.ok) {
    throw new Error(`git ${args[0]} failed: ${result.stderr.trim().slice(0, 400)}`)
  }
  return result.stdout
}

function isRepo(dir) {
  try {
    return fs.statSync(path.join(dir, ".git")).isDirectory() ||
           fs.statSync(path.join(dir, ".git")).isFile() // worktrees use a file
  } catch {
    return false
  }
}

// Walk the allowlisted roots and collect repositories. A root that IS a
// repository counts as one — people share a single project as often as they
// share a folder of them.
export function discover() {
  const found = []
  const seen = new Set()

  const visit = (dir, depth) => {
    if (depth > SCAN_DEPTH || found.length >= 200) return
    let real
    try {
      real = fs.realpathSync(dir)
    } catch {
      return
    }
    if (seen.has(real)) return
    seen.add(real)

    if (isRepo(real)) {
      found.push(real)
      return // don't descend into a repository looking for more
    }
    if (depth === SCAN_DEPTH) return

    let entries = []
    try {
      entries = fs.readdirSync(real, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue
      visit(path.join(real, entry.name), depth + 1)
    }
  }

  for (const root of listRoots()) visit(root, 0)
  return found
}

// %x1f (unit separator) between fields, %x1e (record separator) between
// commits: both are characters a commit message cannot contain, unlike the
// pipes and tabs that a subject line happily does.
const LOG_FORMAT = "%H%x1f%h%x1f%an%x1f%aI%x1f%s%x1e"

function parseLog(stdout) {
  return stdout
    .split("\x1e")
    .map((row) => row.replace(/^\n/, "").trim())
    .filter(Boolean)
    .map((row) => {
      const [sha, short, author, date, subject] = row.split("\x1f")
      return { sha, short_sha: short, author, date, subject }
    })
}

async function statusOf(cwd) {
  const porcelain = await gitOrThrow(cwd, ["status", "--porcelain=v1", "--branch"])
  const lines = porcelain.split("\n").filter(Boolean)

  let staged = 0
  let unstaged = 0
  let untracked = 0
  for (const line of lines) {
    if (line.startsWith("##")) continue
    if (line.startsWith("??")) { untracked += 1; continue }
    if (line[0] !== " ") staged += 1
    if (line[1] !== " ") unstaged += 1
  }
  return { staged, unstaged, untracked, dirty: staged + unstaged + untracked > 0 }
}

async function currentBranch(cwd) {
  const out = await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"])
  return out.ok ? out.stdout.trim() : "(detached)"
}

async function remoteUrl(cwd) {
  const out = await git(cwd, ["remote", "get-url", "origin"])
  return out.ok ? out.stdout.trim() : null
}

// github.com/owner/repo from any of the URL shapes git accepts. Returns null
// for a non-GitHub remote rather than guessing — the server uses this to
// decide whether a pull request is even possible.
export function githubSlug(url) {
  if (!url) return null
  const match = String(url).match(/github\.com[:/]+([^/]+)\/(.+?)(?:\.git)?\/?$/i)
  return match ? `${match[1]}/${match[2]}` : null
}

async function describe(dir) {
  const [branch, url, status] = await Promise.all([
    currentBranch(dir),
    remoteUrl(dir),
    statusOf(dir).catch(() => ({ dirty: false, staged: 0, unstaged: 0, untracked: 0 }))
  ])
  const log = await git(dir, ["log", "-1", `--format=${LOG_FORMAT}`])
  const last = log.ok ? parseLog(log.stdout)[0] : null

  return {
    path: dir,
    name: path.basename(dir),
    branch,
    remote_url: url,
    github: githubSlug(url),
    ...status,
    last_commit: last || null
  }
}

// ---------------------------------------------------------------------------
// Commands. One function per `kind` the server can send; each returns the
// object that becomes the job's `data` payload.
// ---------------------------------------------------------------------------

export async function reposList() {
  const dirs = discover()
  const repos = []
  for (const dir of dirs) {
    try {
      repos.push(await describe(dir))
    } catch {
      // A directory we can't read is one we leave out, not one that fails the
      // whole listing.
    }
  }
  repos.sort((a, b) => a.name.localeCompare(b.name))
  return { roots: listRoots(), repos }
}

export async function summary(params) {
  const cwd = resolveRepo(params.path)
  const base = await describe(cwd)

  const [logOut, branchOut] = await Promise.all([
    git(cwd, ["log", "-20", `--format=${LOG_FORMAT}`]),
    git(cwd, ["for-each-ref", "--sort=-committerdate", "--count=40",
              "--format=%(refname:short)%x1f%(committerdate:iso8601)", "refs/heads"])
  ])

  const branches = branchOut.ok
    ? branchOut.stdout.split("\n").filter(Boolean).map((row) => {
        const [name, date] = row.split("\x1f")
        return { name, committed_at: date }
      })
    : []

  return {
    ...base,
    commits: logOut.ok ? parseLog(logOut.stdout) : [],
    branches
  }
}

export async function log(params) {
  const cwd = resolveRepo(params.path)
  const limit = Math.min(Math.max(Number(params.limit) || 30, 1), 200)
  const args = ["log", `-${limit}`, `--format=${LOG_FORMAT}`]
  if (params.ref) args.push(String(params.ref))
  return { commits: parseLog(await gitOrThrow(cwd, args)) }
}

export async function diff(params) {
  const cwd = resolveRepo(params.path)
  const args = ["diff", "--stat=200"]
  if (params.staged) args.push("--cached")
  if (params.full) args.splice(1, 1) // drop --stat, give the real patch
  const out = await gitOrThrow(cwd, ["--no-pager", ...args])
  // Bounded: a diff is context for a model, not an artifact to archive, and an
  // unbounded one would blow the job row and the prompt alike.
  return { diff: out.slice(0, 200_000), truncated: out.length > 200_000 }
}

// Commit whatever is in the working tree onto a branch and push it. The
// pull request itself is opened by the server, which already holds the user's
// GitHub authorization — this machine only needs to be able to push, using
// whatever git credentials the user already has configured.
export async function push(params) {
  const cwd = resolveRepo(params.path)
  const branch = sanitizeBranch(params.branch)
  const message = String(params.message || "Changes from Configure My AI").slice(0, 2000)
  const base = params.base ? sanitizeBranch(params.base) : null

  const startedOn = await currentBranch(cwd)

  // Reuse the branch if it already exists — a second push to the same PR is
  // the normal case, not an error.
  const exists = (await git(cwd, ["rev-parse", "--verify", `refs/heads/${branch}`])).ok
  const checkout = await git(cwd, exists ? ["checkout", branch] : ["checkout", "-b", branch, ...(base ? [base] : [])])
  if (!checkout.ok) {
    throw new Error(`Couldn't switch to ${branch}: ${checkout.stderr.trim().slice(0, 300)}`)
  }

  await gitOrThrow(cwd, ["add", "-A"])

  const status = await statusOf(cwd)
  let committed = false
  if (status.staged > 0) {
    const commit = await git(cwd, ["commit", "-m", message])
    if (!commit.ok && !/nothing to commit/i.test(commit.stdout + commit.stderr)) {
      throw new Error(`Commit failed: ${commit.stderr.trim().slice(0, 300)}`)
    }
    committed = commit.ok
  }

  const pushed = await git(cwd, ["push", "-u", "origin", branch], { timeoutMs: 120000 })
  if (!pushed.ok) {
    throw new Error(`Push failed: ${pushed.stderr.trim().slice(0, 400)}`)
  }

  const head = (await git(cwd, ["rev-parse", "HEAD"])).stdout.trim()
  const url = await remoteUrl(cwd)

  return {
    branch,
    base: base || startedOn,
    committed,
    head_sha: head,
    github: githubSlug(url),
    remote_url: url
  }
}

// git accepts a lot as a ref name; we accept much less. Anything outside this
// set is a typo or an attempt, and neither should reach a command line.
function sanitizeBranch(input) {
  const name = String(input || "").trim()
  if (!/^[A-Za-z0-9._\-/]{1,120}$/.test(name) || name.includes("..") || name.startsWith("-")) {
    throw new Error(`"${input}" isn't a usable branch name.`)
  }
  return name
}

// Dispatch table the runner hands a job to. Unknown kinds throw here rather
// than anywhere further in, so a server that is newer than this build gets a
// clear "update cma-agent" instead of silence.
export const COMMANDS = {
  "repos.list": reposList,
  "git.summary": summary,
  "git.log": log,
  "git.diff": diff,
  "git.push": push
}

export async function runCommand(kind, params = {}) {
  const handler = COMMANDS[kind]
  if (!handler) {
    throw new Error(`This companion doesn't know how to run "${kind}". Update cma-agent.`)
  }
  return handler(params)
}
