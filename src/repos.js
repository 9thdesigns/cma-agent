import { execFile } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"

import { HOME, readConfig, writeConfig } from "./config.js"

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

// Checkouts we manage ourselves, for sessions linked to a GitHub repository
// rather than to a folder the user shared.
//
// Implicitly trusted — unlike a shared folder it is created by us, lives inside
// our own state directory, and holds nothing that wasn't already on GitHub. It
// is what makes a local session behave like Claude Code on the web: the model
// gets a real working tree instead of a keyhole view pasted into its prompt.
export const WORKSPACES_DIR = path.join(HOME, "workspaces")

// Clones use the user's OWN git credentials, via whatever credential helper
// they already have configured. No GitHub token is ever sent to this machine —
// same principle as the Claude login, which we also never touch. The cost is
// that a private repository the user cannot clone by hand cannot be cloned
// here either, which is the correct failure.
const CLONE_TIMEOUT_MS = 300000

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
  const target = path.resolve(expandHome(requested))
  let real
  try {
    real = fs.realpathSync(target)
  } catch {
    throw new Error(`${target} doesn't exist on this machine.`)
  }

  // Our own managed checkouts count as allowed without `repos:add` — we
  // created them, they live in our state directory, and requiring the user to
  // share a folder we made ourselves would be theatre rather than consent.
  const roots = listRoots()
  let managed = false
  try {
    managed = withinRoot(real, fs.realpathSync(WORKSPACES_DIR))
  } catch {
    managed = false
  }

  if (!managed && roots.length === 0) {
    throw new Error(
      "No repository folders are shared from this machine. Run `cma-agent repos:add ~/code` to share one."
    )
  }

  const allowed = managed || roots.some((root) => {
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

// The repo panel lists the paths so somebody can see what a commit would
// sweep up; a checkout mid-merge can carry thousands of them, so the list is
// capped while the counts stay exact.
const MAX_LISTED_CHANGES = 40

// git quotes any path with unusual bytes in it. The quotes are an artefact of
// the transport, not part of the name.
function unquotePath(value) {
  return value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value
}

async function statusOf(cwd, { withFiles = false } = {}) {
  const porcelain = await gitOrThrow(cwd, ["status", "--porcelain=v1", "--branch"])
  const lines = porcelain.split("\n").filter(Boolean)

  let staged = 0
  let unstaged = 0
  let untracked = 0
  // Tracked files with anything on them at all, counted once each: a file that
  // is both staged and unstaged is one file to review, not two.
  let changed = 0
  const files = []
  for (const line of lines) {
    if (line.startsWith("##")) continue
    const code = line.slice(0, 2)
    const rest = line.slice(3)
    // "R  old -> new": the destination is the name worth showing.
    const file = rest.includes(" -> ") ? rest.split(" -> ").pop() : rest
    if (withFiles && files.length < MAX_LISTED_CHANGES) {
      files.push({ code, path: unquotePath(file) })
    }
    if (code === "??") { untracked += 1; continue }
    changed += 1
    if (code[0] !== " ") staged += 1
    if (code[1] !== " ") unstaged += 1
  }

  const status = { staged, unstaged, untracked, changed, dirty: changed + untracked > 0 }
  return withFiles ? { ...status, files } : status
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

// withFiles is off by default because repos.list describes every shared
// repository at once, and the picker only needs to know whether each one is
// dirty — the paths belong to the single repository a session has open.
async function describe(dir, { withFiles = false } = {}) {
  const [branch, url, status] = await Promise.all([
    currentBranch(dir),
    remoteUrl(dir),
    statusOf(dir, { withFiles }).catch(() => ({
      dirty: false, staged: 0, unstaged: 0, untracked: 0, changed: 0, ...(withFiles ? { files: [] } : {})
    }))
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
  const base = await describe(cwd, { withFiles: true })

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

// The remote's default branch as this checkout knows it (origin/HEAD), or
// null when the clone never learned one. Used as a guardrail, so null means
// "can't prove it's safe" is decided by the caller, not silently allowed.
async function defaultBranch(cwd) {
  const out = await git(cwd, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"])
  if (out.ok) return out.stdout.trim().replace(/^refs\/remotes\/origin\//, "")
  return null
}

// Branches these commands must never touch: the repository default branch,
// the session's base branch (sent by the server), and whatever is checked
// out right now. Deleting or renaming any of them strands the session or the
// user's working tree.
async function assertBranchOperable(cwd, name, base) {
  const def = await defaultBranch(cwd)
  if (def && name === def) {
    throw new Error(`Refusing to touch ${name}: it is the repository default branch.`)
  }
  if (base && name === base) {
    throw new Error(`Refusing to touch ${name}: it is this session's base branch.`)
  }
  const current = await currentBranch(cwd)
  if (name === current) {
    throw new Error(`Refusing to touch ${name}: it is currently checked out.`)
  }
}

// Rename a LOCAL branch. Deliberately never touches the remote — publishing
// is `git.push`'s job and stays on the session's working branch only.
export async function branchRename(params) {
  const cwd = resolveRepo(params.path)
  const from = sanitizeBranch(params.from)
  const to = sanitizeBranch(params.to)
  const base = params.base ? sanitizeBranch(params.base) : null

  await assertBranchOperable(cwd, from, base)
  const def = await defaultBranch(cwd)
  if ((def && to === def) || (base && to === base)) {
    throw new Error(`Refusing to rename onto ${to}: it is a protected branch name.`)
  }

  const out = await git(cwd, ["branch", "-m", from, to])
  if (!out.ok) {
    throw new Error(`Couldn't rename ${from} to ${to}: ${out.stderr.trim().slice(0, 300)}`)
  }
  return { renamed: true, from, to, local_only: true }
}

// Delete a LOCAL branch. -D to match the server-side ref delete semantics;
// the guardrails above are what make that acceptable.
export async function branchDelete(params) {
  const cwd = resolveRepo(params.path)
  const name = sanitizeBranch(params.branch || params.name)
  const base = params.base ? sanitizeBranch(params.base) : null

  await assertBranchOperable(cwd, name, base)

  const out = await git(cwd, ["branch", "-D", name])
  if (!out.ok) {
    throw new Error(`Couldn't delete ${name}: ${out.stderr.trim().slice(0, 300)}`)
  }
  return { deleted: true, branch: name, local_only: true }
}

// Make sure a checkout of `github` exists on this machine and is up to date,
// and return where it is.
//
// This is what closes the gap between a local session and Claude Code on the
// web. Without it a session linked to a GitHub repository ran with no working
// directory at all: the model got a truncated file tree pasted into its prompt,
// no tools pointed at anything, and — following its instructions exactly —
// asked the user to paste files. With it the model gets the real repository and
// behaves like Claude Code, because it IS Claude Code.
// One repository is prepared at a time, however many sessions ask at once.
//
// Concurrency made this necessary rather than optional: two sessions starting
// together both run `repo.ensure` for the same repository, and git does not
// take kindly to it — two clones into one directory, or two fetches racing for
// the same ref lock. The sessions themselves stay parallel; only the moment
// that touches the shared clone is single-file.
//
// In-process and per-slug. It does not need to survive a restart: nothing is
// half-written that the next `ensure` cannot repair.
const repoLocks = new Map()

function withRepoLock(key, work) {
  const queue = (repoLocks.get(key) || Promise.resolve()).then(work, work)
  // Stored swallowing failures: this chain is only for ordering, and a
  // rejection here must not become an unhandled one or poison the next caller.
  repoLocks.set(key, queue.catch(() => {}))
  return queue
}

export function ensureCheckout(params) {
  // Sanitised before the lock so a bad slug fails the same way it always has,
  // rather than queueing behind real work first.
  return withRepoLock(sanitizeSlug(params.github), () => prepareCheckout(params))
}

async function prepareCheckout(params) {
  const slug = sanitizeSlug(params.github)
  const branch = params.branch ? sanitizeBranch(params.branch) : null
  const workspace = params.workspace ? sanitizeWorkspace(params.workspace) : null
  const dir = path.join(WORKSPACES_DIR, slug.replace("/", "__"))

  fs.mkdirSync(WORKSPACES_DIR, { recursive: true, mode: 0o700 })

  const fresh = !fs.existsSync(path.join(dir, ".git"))
  if (fresh) {
    // --filter=blob:none keeps the full history (so `git log` is honest) while
    // fetching file contents on demand. A plain clone of a large repository is
    // minutes the user spends staring at a spinner; a shallow one would make
    // the history the model reads a lie.
    const cloned = await git(WORKSPACES_DIR, [
      "clone", "--filter=blob:none",
      `https://github.com/${slug}.git`, dir
    ], { timeoutMs: CLONE_TIMEOUT_MS })

    if (!cloned.ok) {
      throw new Error(
        `Couldn't clone ${slug} on this machine: ${cloned.stderr.trim().slice(0, 300)}. ` +
        "The clone uses your own git credentials — check you can `git clone` it by hand."
      )
    }
  } else {
    const fetched = await git(dir, ["fetch", "origin", "--prune"], { timeoutMs: CLONE_TIMEOUT_MS })
    if (!fetched.ok) {
      throw new Error(`Couldn't update ${slug}: ${fetched.stderr.trim().slice(0, 300)}`)
    }
  }

  if (branch) {
    // Track the remote branch if we don't have it yet; otherwise just move to
    // it. Deliberately NOT a hard reset: uncommitted work in this checkout is
    // the user's, even in a directory we created.
    const exists = (await git(dir, ["rev-parse", "--verify", `refs/heads/${branch}`])).ok
    const checkout = exists
      ? await git(dir, ["checkout", branch])
      : await git(dir, ["checkout", "-B", branch, `origin/${branch}`])

    if (checkout.ok) {
      await git(dir, ["merge", "--ff-only", `origin/${branch}`])
    }
    // A failed checkout is not fatal — the default branch is still a usable
    // working tree, and saying so beats refusing to run at all.
  }

  // A session that named itself gets its own working tree off this clone.
  //
  // Without it, two sessions on one repository shared a directory: the second
  // one's checkout moved the first one's HEAD mid-run and both models edited
  // the same files. That is the "one conflicting with another" that made
  // running several local sessions at once unsafe, and no amount of queueing
  // fixes it — it is a property of the checkout, not of the schedule.
  //
  // The clone above stays the shared cache: it holds the objects, it keeps the
  // base branch fresh, and every worktree shares its refs, so a second session
  // costs a working tree rather than a second clone.
  if (workspace) {
    const isolated = await addWorktree(dir, slug, workspace, branch)
    if (isolated) {
      await writeSkills(isolated, params.skills)
      return { ...(await describe(isolated)), created: fresh, managed: true, isolated: true }
    }
    // Fell through — a git too old for worktrees, or one that refused. Sharing
    // the clone is worse than isolating it and far better than refusing to run,
    // so the session gets the cache directory exactly as it did before.
  }

  await writeSkills(dir, params.skills)
  return { ...(await describe(dir)), created: fresh, managed: true }
}

// The session's Agent Skills, written into the checkout so the CLI that is
// about to run in it reads them natively — SKILL.md is the open format
// Claude Code, Codex, Gemini CLI and Cursor all discover, each from its own
// directory, so the same bundle is written under the neutral .agents/skills
// plus the two vendor paths.
//
// Three properties are load-bearing:
//
//   * MANAGED CHECKOUTS ONLY. This function is reached exclusively through
//     prepareCheckout, which only ever creates directories under
//     WORKSPACES_DIR — the folders a user shared with repos:add never pass
//     through here, so the companion's promise that nothing is written into
//     the user's own repository holds by construction.
//   * NEVER PUSHED. push() stages with `git add -A`, which would sweep
//     these files into the user's pull request; every path written here is
//     appended to the checkout's git info/exclude (worktree-aware via
//     `rev-parse --git-path`), scoped to the exact slug directories rather
//     than whole roots so a run that legitimately authors its own skill
//     files elsewhere is not silently excluded.
//   * IDEMPOTENT WITH CLEANUP. Worktrees are reused across turns and never
//     reset, so the bundle is rewritten on every ensure and a manifest
//     records what was written — a skill uninstalled on the server is
//     removed here on the next turn, the same delete-when-absent contract
//     the Cursor adapter's config writer follows.
//
// Best-effort throughout: a skills write must never cost the checkout.
const SKILL_ROOTS = [".agents/skills", ".claude/skills", ".gemini/skills"]
const SKILL_MANIFEST = ".agents/.cma-skills.json"
const SKILL_MAX_BYTES = 64_000
const SKILL_SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/

export async function writeSkills(dir, skills) {
  try {
    const list = (Array.isArray(skills) ? skills : []).filter(
      (s) => s && SKILL_SLUG_RE.test(String(s.slug || "")) && typeof s.skill_md === "string"
    )

    const manifestPath = path.join(dir, SKILL_MANIFEST)
    let previous = []
    try {
      previous = JSON.parse(fs.readFileSync(manifestPath, "utf8")).slugs || []
    } catch {}

    const slugs = list.map((s) => String(s.slug))
    if (!slugs.length && !previous.length) return

    // A slug that collides with a path the REPOSITORY tracks is skipped
    // outright — writing there would clobber the project's own committed
    // skill files, and info/exclude protects only untracked paths, so the
    // clobber (or a stale-cleanup deletion) would ride `git add -A` into
    // the user's pull request.
    const writable = []
    for (const skill of list) {
      const clash = await Promise.all(
        SKILL_ROOTS.map((root) => isTracked(dir, `${root}/${skill.slug}`))
      )
      if (clash.some(Boolean)) {
        console.error(`[cma-agent] skill ${skill.slug} skipped: the repository tracks that path`)
      } else {
        writable.push(skill)
      }
    }
    const writableSlugs = writable.map((s) => String(s.slug))

    // Exclude FIRST, and refuse to write at all when the exclusion cannot
    // be recorded: files written before their exclude line exist in the
    // window where this same turn's push() would sweep them into the PR.
    const excluded = await excludeSkillPaths(dir, writableSlugs)
    if (!excluded) return

    for (const stale of previous.filter((s) => SKILL_SLUG_RE.test(s) && !writableSlugs.includes(s))) {
      for (const root of SKILL_ROOTS) {
        if (await isTracked(dir, `${root}/${stale}`)) continue
        fs.rmSync(path.join(dir, root, stale), { recursive: true, force: true })
      }
    }

    for (const skill of writable) {
      const body = String(skill.skill_md).slice(0, SKILL_MAX_BYTES)
      for (const root of SKILL_ROOTS) {
        const skillDir = path.join(dir, root, String(skill.slug))
        fs.mkdirSync(skillDir, { recursive: true, mode: 0o700 })
        fs.writeFileSync(path.join(skillDir, "SKILL.md"), body, { mode: 0o600 })
      }
    }

    fs.mkdirSync(path.dirname(manifestPath), { recursive: true, mode: 0o700 })
    fs.writeFileSync(manifestPath, JSON.stringify({ slugs: writableSlugs }), { mode: 0o600 })
  } catch (err) {
    // Not the exported `log` below — that is the git-log command handler.
    console.error(`[cma-agent] skills write skipped for ${dir}: ${err.message}`)
  }
}

// Does the repository track anything under this relative path?
async function isTracked(dir, rel) {
  const res = await git(dir, ["ls-files", "--", rel])
  return res.ok && res.stdout.trim().length > 0
}

// Keep everything writeSkills produces out of `git add -A`, per exact path.
// info/exclude only affects untracked files, so a repository that commits
// its own .claude/skills keeps them tracked and visible. Returns true when
// every wanted line is on record — the caller writes nothing otherwise,
// because a skill file that exists before its exclude line is a file this
// same turn's push() would sweep into the user's pull request. A directory
// that is not a git repository excludes trivially (nothing stages there).
async function excludeSkillPaths(dir, slugs) {
  const res = await git(dir, ["rev-parse", "--git-path", "info/exclude"])
  if (!res.ok) return !fs.existsSync(path.join(dir, ".git"))

  const excludePath = path.resolve(dir, res.stdout.trim())
  let current = ""
  try {
    current = fs.readFileSync(excludePath, "utf8")
  } catch {}

  const have = new Set(current.split("\n"))
  const wanted = [`/${SKILL_MANIFEST}`]
  for (const slug of slugs) {
    for (const root of SKILL_ROOTS) wanted.push(`/${root}/${slug}/`)
  }
  const missing = wanted.filter((line) => !have.has(line))
  if (!missing.length) return true

  try {
    fs.mkdirSync(path.dirname(excludePath), { recursive: true })
    const lead = current.length && !current.endsWith("\n") ? "\n" : ""
    fs.appendFileSync(excludePath, `${lead}${missing.join("\n")}\n`)
    return true
  } catch (err) {
    console.error(`[cma-agent] could not record skill excludes for ${dir}: ${err.message}`)
    return false
  }
}

// One session's working tree, hung off the shared clone.
//
// Detached on purpose. A branch may only be checked out in one worktree at a
// time, so two sessions both starting from `main` would collide on the second —
// the very failure this is here to remove. Detached at the base commit is the
// same starting point without the exclusivity, and `git.push` creates the
// session's real branch from there exactly as it always has.
//
// Returns the directory, or null when this git can't do it — every caller
// treats null as "carry on with the shared clone".
async function addWorktree(cacheDir, slug, workspace, branch) {
  const dir = path.join(WORKSPACES_DIR, `${slug.replace("/", "__")}@${workspace}`)

  // Clears administrative entries for worktrees whose directories are gone
  // (someone tidied ~/.configure-my-ai by hand). Without it git refuses to
  // re-add the same path.
  await git(cacheDir, ["worktree", "prune"])

  if (fs.existsSync(path.join(dir, ".git"))) {
    // It already exists, so it is mid-session: its HEAD, its branch and its
    // uncommitted work belong to that session. Updating it here would be this
    // turn stepping on the last one — the exact thing worktrees are here to
    // prevent. Fetching happened in the cache and refs are shared, so it can
    // already see everything new.
    return dir
  }

  const start = await worktreeStart(cacheDir, branch)
  const added = await git(cacheDir, ["worktree", "add", "--detach", dir, start],
                          { timeoutMs: CLONE_TIMEOUT_MS })
  return added.ok ? dir : null
}

// Where a new session's tree starts: the remote's idea of the base branch,
// falling back to the remote default, then to whatever the clone has. Remote
// refs rather than local ones because the fetch above has just made them the
// freshest thing here.
async function worktreeStart(cacheDir, branch) {
  const candidates = []
  if (branch) candidates.push(`origin/${branch}`, branch)

  const fallback = await defaultBranch(cacheDir)
  if (fallback) candidates.push(`origin/${fallback}`)

  for (const ref of candidates) {
    if ((await git(cacheDir, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])).ok) return ref
  }
  return "HEAD"
}

// owner/repo, and nothing that could be read as a flag or a path.
function sanitizeSlug(input) {
  const slug = String(input || "").trim()
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(slug) || slug.includes("..") || slug.startsWith("-")) {
    throw new Error(`"${input}" isn't a usable owner/repo.`)
  }
  return slug
}

// The server's name for one session, used as a directory suffix. Narrow on
// purpose: it arrives over the network and becomes a path, so it is reduced to
// characters that cannot traverse, cannot hide a separator and cannot be read
// as a flag. Anything that survives to nothing is treated as "no workspace"
// rather than as an error — the session still runs, just in the shared clone.
function sanitizeWorkspace(input) {
  const cleaned = String(input || "").trim().replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64)
  return cleaned || null
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

// A scratch working directory for a session with no repository. Without one,
// the job carried no workdir at all, Claude Code started with no permission
// mode and no file tools, and "describe what you want built and I'll write
// the files" ended in Write being denied — the model pasting a whole site
// into its reply. Same layout and containment as the repo checkouts: under
// WORKSPACES_DIR, named by the session's own key, created once and reused so
// follow-up turns see the earlier files.
function ensureScratchWorkspace(params) {
  const key = sanitizeWorkspace(params.workspace)
  if (!key) throw new Error("workspace.ensure needs a workspace key.")

  const dir = path.join(WORKSPACES_DIR, `scratch__${key}`)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  return { path: dir }
}

// Dispatch table the runner hands a job to. Unknown kinds throw here rather
// than anywhere further in, so a server that is newer than this build gets a
// clear "update cma-agent" instead of silence.
export const COMMANDS = {
  "repos.list": reposList,
  "repo.ensure": ensureCheckout,
  "workspace.ensure": ensureScratchWorkspace,
  "git.summary": summary,
  "git.log": log,
  "git.diff": diff,
  "git.push": push,
  "git.branch.rename": branchRename,
  "git.branch.delete": branchDelete
}

export async function runCommand(kind, params = {}) {
  const handler = COMMANDS[kind]
  if (!handler) {
    throw new Error(`This companion doesn't know how to run "${kind}". Update cma-agent.`)
  }
  return handler(params)
}
