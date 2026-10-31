import fs from "node:fs"
import path from "node:path"

import { git, SCRATCH_PREFIX, withRepoLock, WORKSPACES_DIR } from "./repos.js"

// ---------------------------------------------------------------------------
// Housekeeping for the workspaces this companion creates.
//
// Every session linked to a GitHub repository gets its own working tree under
// ~/.configure-my-ai/workspaces, and nothing ever removed one. On a laptop
// that runs local sessions for months that is hundreds of full checkouts —
// gigabytes of files nobody will open again — and a disk filling up is
// exactly the "my machine got slower the longer I used this" that a
// background companion must never be the cause of.
//
// So old workspaces are tidied, on two rules that both have to hold:
//
//   OLD     the directory has not been used for CMA_TIDY_DAYS (14 by
//           default). "Used" is the directory's own mtime, which
//           repos.js bumps every time a job resolves or prepares it —
//           see markWorkspaceUsed. No marker files inside the tree
//           (git add -A would sweep those into a pull request), no
//           registry to fall out of step.
//
//   SAFE    removing it can be PROVEN to lose nothing. A working tree
//           with uncommitted or untracked files is never touched,
//           whatever its age. Neither is one whose HEAD sits on a commit
//           no branch holds — branches live in the shared clone and
//           survive the working tree, so a clean tree whose HEAD is on
//           any branch, local or remote, loses nothing but files git can
//           reproduce. When a check cannot run (an orphaned tree whose
//           clone was deleted by hand), the answer is "can't prove it",
//           and the directory stays.
//
// The shared clones are the cache every working tree hangs off, so they are
// kept far longer (4x) and only removed when no working tree references them,
// nothing is uncommitted, no local branch holds a commit the remote lacks,
// and the stash is empty. Scratch workspaces exist only on machines
// Configure My AI runs, where every turn's files are read back to the
// platform and re-seeded on the next one, so age alone decides for them.
//
// Everything here is best-effort: housekeeping must never cost a run, so a
// failed check keeps the directory and a failed removal is left for the next
// pass.
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000

const DEFAULT_KEEP_DAYS = 14
// The shared clone is minutes of re-download on a big repository, while a
// working tree is seconds of re-checkout — so the cache earns a longer stay.
const CLONE_KEEP_MULTIPLIER = 4

// Once a day. The ages are measured in weeks, so running more often buys
// nothing; the first pass runs at startup for the machines that never stay
// up a whole day.
export const TIDY_EVERY_MS = DAY_MS

// How long an unused working tree is kept. 0 disables tidying entirely —
// an escape hatch, not a recommendation. Read at call time, not import time,
// so the tests (and a long-running companion whose owner exports it) see the
// current value.
export function keepDays() {
  const raw = process.env.CMA_TIDY_DAYS
  if (raw === undefined || raw === "") return DEFAULT_KEEP_DAYS
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_KEEP_DAYS
  return parsed
}

function olderThan(dir, ms, now) {
  try {
    return now - fs.statSync(dir).mtimeMs > ms
  } catch {
    // Already gone, or unreadable — either way not ours to age.
    return false
  }
}

// What one entry under WORKSPACES_DIR is. The names are a contract repos.js
// writes: a working tree is `<owner__repo>@<workspace>` (nothing else may
// contain "@" — slugs and workspace keys are both sanitised past it), a
// scratch workspace is `scratch__<key>` with no git in it, and a shared
// clone has a real .git DIRECTORY. Anything else — including a symlink,
// which is never followed — is not ours and is left alone.
function classify(name, dir) {
  if (name.startsWith(".")) return null

  let stat
  try {
    stat = fs.lstatSync(dir)
  } catch {
    return null
  }
  if (!stat.isDirectory()) return null

  if (name.includes("@")) return "worktree"

  try {
    if (fs.statSync(path.join(dir, ".git")).isDirectory()) return "clone"
  } catch {
    // No .git at all — the scratch check below decides.
  }

  if (name.startsWith(SCRATCH_PREFIX)) return "scratch"
  return null
}

// Remove one session working tree, or prove why not.
//
// Under the same per-repository lock repo.ensure takes, so a session
// resuming at the exact moment of a tidy pass queues rather than races —
// and the age is re-checked under the lock for the same reason.
async function removeWorktree(dir, name, cutoffMs, now) {
  const cloneDir = path.join(WORKSPACES_DIR, name.slice(0, name.indexOf("@")))
  // An orphan whose clone was deleted by hand cannot answer any git
  // question, so nothing about it can be proven. It stays.
  if (!fs.existsSync(path.join(cloneDir, ".git"))) return false

  return withRepoLock(path.basename(cloneDir), async () => {
    if (!olderThan(dir, cutoffMs, now)) return false

    // Uncommitted or untracked work is the user's, even in a directory we
    // created. The skills bundle repos.js writes is in info/exclude, so a
    // tree that only ever ran turns reads clean here.
    const status = await git(dir, ["status", "--porcelain"])
    if (!status.ok || status.stdout.trim() !== "") return false

    // Branches are shared refs and survive the working tree; a HEAD on any
    // of them loses nothing. A detached HEAD on a commit NO branch holds is
    // the one thing removal would orphan — `git branch --contains` can't
    // ask this (it prints a "(no branch)" row for every detached HEAD), so
    // the refs are asked directly.
    const anchored = await git(dir, [
      "for-each-ref", "--contains", "HEAD", "--count=1", "--format=%(refname)",
      "refs/heads", "refs/remotes"
    ])
    if (!anchored.ok || anchored.stdout.trim() === "") return false

    // No --force, deliberately: git re-checks for modified and untracked
    // files and refuses, which backstops every check above. Removing through
    // git also drops the administrative entry, so the same path can be
    // added again by a later session.
    const removed = await git(cloneDir, ["worktree", "remove", dir])
    return removed.ok
  })
}

// Remove one shared clone, or prove why not. Only reached when no working
// tree hangs off it any more; everything a clone could still be keeping safe
// is checked for directly.
async function removeClone(dir, name, cutoffMs, now) {
  return withRepoLock(name, async () => {
    if (!olderThan(dir, cutoffMs, now)) return false
    // Re-listed under the lock: a worktree added while we waited wins.
    if (listWorktreeNames(name).length > 0) return false

    const status = await git(dir, ["status", "--porcelain"])
    if (!status.ok || status.stdout.trim() !== "") return false

    // Any commit on a local branch that no remote has would be lost with
    // the clone — one question answers it for every branch at once.
    const unpushed = await git(dir, ["log", "--branches", "--not", "--remotes", "-1", "--format=%H"])
    if (!unpushed.ok || unpushed.stdout.trim() !== "") return false

    // Stashes live in the clone (shared across its worktrees), and push's
    // carry-the-work dance uses them — an entry a failed run left behind is
    // still somebody's work.
    const stash = await git(dir, ["stash", "list"])
    if (!stash.ok || stash.stdout.trim() !== "") return false

    try {
      fs.rmSync(dir, { recursive: true, force: true })
      return true
    } catch {
      return false
    }
  })
}

function listWorktreeNames(cloneName) {
  try {
    return fs.readdirSync(WORKSPACES_DIR).filter((entry) => entry.startsWith(`${cloneName}@`))
  } catch {
    return []
  }
}

// One pass over WORKSPACES_DIR. Returns what it removed, and says so on the
// companion's log only when there was something to say — a quiet machine's
// terminal stays quiet.
export async function tidyWorkspaces({ log = () => {}, now = Date.now() } = {}) {
  const removed = { worktrees: 0, scratch: 0, clones: 0 }

  const days = keepDays()
  if (!days) return removed

  const keepMs = days * DAY_MS
  const cloneKeepMs = keepMs * CLONE_KEEP_MULTIPLIER

  let entries = []
  try {
    entries = fs.readdirSync(WORKSPACES_DIR)
  } catch {
    // No workspaces directory yet — nothing has ever been checked out here.
    return removed
  }

  const clones = []
  for (const name of entries) {
    const dir = path.join(WORKSPACES_DIR, name)
    try {
      switch (classify(name, dir)) {
        case "worktree":
          if (olderThan(dir, keepMs, now) && await removeWorktree(dir, name, keepMs, now)) removed.worktrees += 1
          break
        case "scratch":
          // Hosted-only (the server never makes one on a laptop), and every
          // turn's files are read back to the platform and re-seeded on the
          // next — so age is the whole question.
          if (olderThan(dir, keepMs, now)) {
            fs.rmSync(dir, { recursive: true, force: true })
            removed.scratch += 1
          }
          break
        case "clone":
          // After the working trees, so a repository whose last tree just
          // left still gets its own, longer clock.
          clones.push({ name, dir })
          break
      }
    } catch {
      // One directory that cannot be judged is not a reason to stop judging
      // the rest.
    }
  }

  for (const { name, dir } of clones) {
    try {
      if (!olderThan(dir, cloneKeepMs, now)) continue
      if (listWorktreeNames(name).length > 0) continue
      if (await removeClone(dir, name, cloneKeepMs, now)) removed.clones += 1
    } catch {
      // Same rule: skip it, next pass tries again.
    }
  }

  const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`
  const parts = []
  if (removed.worktrees) parts.push(plural(removed.worktrees, "old session working tree"))
  if (removed.scratch) parts.push(plural(removed.scratch, "old scratch workspace"))
  if (removed.clones) parts.push(plural(removed.clones, "unused repository clone"))
  if (parts.length) {
    log(`· Tidied ${parts.join(", ")} not used in ${days} days — nothing uncommitted or unpushed is ever removed.`)
  }

  return removed
}
