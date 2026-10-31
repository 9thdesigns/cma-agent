// Housekeeping for the workspaces the companion creates.
//
// The failure this guards against is slow and silent: every session gets its
// own working tree under ~/.configure-my-ai/workspaces and, before tidy.js,
// nothing ever removed one — a laptop that ran local sessions for months was
// carrying gigabytes of checkouts nobody would open again. The removal rules
// are the part worth pinning, because every one of them is a promise about
// the user's work: nothing uncommitted, nothing unpushed, nothing we cannot
// prove safe is ever deleted, whatever its age.
//
// Run with: node --test "agent/test/*.test.js"

import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"

// repos.js reads CMA_AGENT_HOME at import, so the sandbox exists first.
const AGENT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "cma-tidy-home-"))
process.env.CMA_AGENT_HOME = AGENT_HOME

const { markWorkspaceUsed, resolveRepo, WORKSPACES_DIR } = await import("../src/repos.js")
const { keepDays, tidyWorkspaces } = await import("../src/tidy.js")

const DAY_MS = 24 * 60 * 60 * 1000

function sh(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
}

let staged = 0

// The exact layout prepareCheckout builds: a shared clone of a bare remote
// under WORKSPACES_DIR, with working trees hung off it as `<clone>@<ws>`.
function stageClone() {
  const name = `acme__proj${staged++}`
  const remote = fs.mkdtempSync(path.join(os.tmpdir(), "cma-tidy-remote-")) + "/origin.git"
  execFileSync("git", ["init", "--quiet", "--bare", "-b", "main", remote])

  fs.mkdirSync(WORKSPACES_DIR, { recursive: true })
  const clone = path.join(WORKSPACES_DIR, name)
  execFileSync("git", ["clone", "--quiet", remote, clone], { stdio: "ignore" })
  sh(["config", "user.email", "t@example.com"], clone)
  sh(["config", "user.name", "Test"], clone)
  fs.writeFileSync(path.join(clone, "base.txt"), "base\n")
  sh(["add", "-A"], clone)
  sh(["commit", "--quiet", "-m", "base"], clone)
  sh(["push", "--quiet", "-u", "origin", "main"], clone)
  return { name, clone }
}

function addTree(clone, name, workspace) {
  const dir = path.join(WORKSPACES_DIR, `${name}@${workspace}`)
  sh(["worktree", "add", "--detach", dir, "origin/main"], clone)
  return dir
}

// What an untouched directory looks like after `days` of disuse.
function age(dir, days) {
  const then = new Date(Date.now() - days * DAY_MS)
  fs.utimesSync(dir, then, then)
}

// ---------------------------------------------------------------------------
// Working trees
// ---------------------------------------------------------------------------

test("a working tree in recent use is kept", async () => {
  const { name, clone } = stageClone()
  const tree = addTree(clone, name, "fresh")
  age(tree, 2)

  const removed = await tidyWorkspaces()
  assert.ok(fs.existsSync(tree), "two days old is in use, not abandoned")
  assert.equal(removed.worktrees, 0)
})

test("an old, clean, anchored working tree is removed — and the same path can be added again", async () => {
  const { name, clone } = stageClone()
  const tree = addTree(clone, name, "done")
  age(tree, 20)

  const removed = await tidyWorkspaces()
  assert.ok(!fs.existsSync(tree), "nothing in it exists only there")
  assert.equal(removed.worktrees, 1)

  // Removal went through git, so the administrative entry is gone too — a
  // session with the same workspace key next month must not find the path
  // wedged.
  assert.doesNotThrow(() => sh(["worktree", "add", "--detach", tree, "origin/main"], clone))
})

test("uncommitted work keeps a working tree alive, whatever its age", async () => {
  const { name, clone } = stageClone()
  const tree = addTree(clone, name, "dirty")
  fs.writeFileSync(path.join(tree, "notes.txt"), "the user's work\n")
  age(tree, 400)

  const removed = await tidyWorkspaces()
  assert.ok(fs.existsSync(tree), "an untracked file is the user's, even in a directory we created")
  assert.ok(fs.existsSync(path.join(tree, "notes.txt")))
  assert.equal(removed.worktrees, 0)
})

test("a detached commit no branch holds keeps its tree", async () => {
  const { name, clone } = stageClone()
  const tree = addTree(clone, name, "orphan")
  // A committed-but-never-pushed turn: the tree is clean, but its HEAD is the
  // only thing keeping these commits reachable.
  fs.writeFileSync(path.join(tree, "work.txt"), "committed, nowhere else\n")
  sh(["add", "-A"], tree)
  sh(["-c", "user.email=t@example.com", "-c", "user.name=Test", "commit", "--quiet", "-m", "detached work"], tree)
  age(tree, 400)

  const removed = await tidyWorkspaces()
  assert.ok(fs.existsSync(tree), "removing the tree would orphan the commit")
  assert.equal(removed.worktrees, 0)
})

test("a pushed session's tree goes; its branch survives in the clone", async () => {
  const { name, clone } = stageClone()
  const tree = addTree(clone, name, "shipped")
  fs.writeFileSync(path.join(tree, "fix.txt"), "the session's fix\n")
  sh(["checkout", "--quiet", "-b", "session-fix"], tree)
  sh(["add", "-A"], tree)
  sh(["-c", "user.email=t@example.com", "-c", "user.name=Test", "commit", "--quiet", "-m", "the fix"], tree)
  sh(["push", "--quiet", "-u", "origin", "session-fix"], tree)
  age(tree, 20)

  const removed = await tidyWorkspaces()
  assert.ok(!fs.existsSync(tree))
  assert.equal(removed.worktrees, 1)
  // Refs are shared with the clone, so the branch — and every commit on it —
  // outlives the working tree.
  assert.doesNotThrow(() => sh(["rev-parse", "--verify", "refs/heads/session-fix"], clone))
})

test("using a checkout is what resets its clock", async () => {
  const { name, clone } = stageClone()
  const tree = addTree(clone, name, "resumed")
  age(tree, 20)

  // What every job does on its way in: resolveRepo marks a managed checkout
  // used, so a session resuming moments before the daily pass is safe.
  assert.equal(resolveRepo(tree), fs.realpathSync(tree))

  const removed = await tidyWorkspaces()
  assert.ok(fs.existsSync(tree))
  assert.equal(removed.worktrees, 0)
})

test("markWorkspaceUsed bumps the top-level workspace, from any path inside it", () => {
  const { name, clone } = stageClone()
  const tree = addTree(clone, name, "deep")
  fs.mkdirSync(path.join(tree, "src"), { recursive: true })
  age(tree, 20)

  markWorkspaceUsed(path.join(tree, "src"))
  assert.ok(Date.now() - fs.statSync(tree).mtimeMs < DAY_MS, "the whole tree reads as in use")

  // A path outside the workspaces directory is never touched.
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "cma-tidy-outside-"))
  age(outside, 20)
  markWorkspaceUsed(outside)
  assert.ok(Date.now() - fs.statSync(outside).mtimeMs > 19 * DAY_MS)
})

// ---------------------------------------------------------------------------
// Scratch workspaces and strangers
// ---------------------------------------------------------------------------

test("scratch workspaces age out; fresh ones stay", async () => {
  const old = path.join(WORKSPACES_DIR, "scratch__oldsession")
  const fresh = path.join(WORKSPACES_DIR, "scratch__freshsession")
  fs.mkdirSync(old, { recursive: true })
  fs.mkdirSync(fresh, { recursive: true })
  fs.writeFileSync(path.join(old, "index.html"), "<h1>hi</h1>")
  age(old, 20)

  const removed = await tidyWorkspaces()
  assert.ok(!fs.existsSync(old))
  assert.ok(fs.existsSync(fresh))
  assert.equal(removed.scratch, 1)
})

test("a directory tidy cannot classify is left alone, whatever its age", async () => {
  const stranger = path.join(WORKSPACES_DIR, "something-else")
  fs.mkdirSync(stranger, { recursive: true })
  fs.writeFileSync(path.join(stranger, "keep.txt"), "not ours to judge\n")
  age(stranger, 400)

  await tidyWorkspaces()
  assert.ok(fs.existsSync(path.join(stranger, "keep.txt")))
})

// ---------------------------------------------------------------------------
// Shared clones
// ---------------------------------------------------------------------------

test("a clone with a working tree hanging off it is kept, whatever its age", async () => {
  const { name, clone } = stageClone()
  const tree = addTree(clone, name, "alive")
  age(clone, 400)

  const removed = await tidyWorkspaces()
  assert.ok(fs.existsSync(clone), "the tree's objects live here")
  assert.equal(removed.clones, 0)

  // Staged aged, so taken out by hand — later tests count their own removals.
  fs.rmSync(tree, { recursive: true, force: true })
  fs.rmSync(clone, { recursive: true, force: true })
})

test("a clone outlives the working-tree window, then goes once provably pushed", async () => {
  const { clone } = stageClone()

  // Past the working-tree cutoff but inside the clone's own (4x) window.
  age(clone, 20)
  let removed = await tidyWorkspaces()
  assert.ok(fs.existsSync(clone), "a clone is minutes of re-download and earns a longer stay")
  assert.equal(removed.clones, 0)

  age(clone, 100)
  removed = await tidyWorkspaces()
  assert.ok(!fs.existsSync(clone))
  assert.equal(removed.clones, 1)
})

test("a local-only commit keeps its clone, whatever its age", async () => {
  const { clone } = stageClone()
  sh(["checkout", "--quiet", "-b", "never-pushed"], clone)
  fs.writeFileSync(path.join(clone, "local.txt"), "only here\n")
  sh(["add", "-A"], clone)
  sh(["-c", "user.email=t@example.com", "-c", "user.name=Test", "commit", "--quiet", "-m", "local only"], clone)
  sh(["checkout", "--quiet", "main"], clone)
  age(clone, 400)

  const removed = await tidyWorkspaces()
  assert.ok(fs.existsSync(clone), "the remote has never seen this commit")
  assert.equal(removed.clones, 0)
})

test("a stash entry keeps its clone, whatever its age", async () => {
  const { clone } = stageClone()
  fs.writeFileSync(path.join(clone, "base.txt"), "stashed change\n")
  sh(["stash", "push", "--include-untracked", "-m", "carrying work"], clone)
  age(clone, 400)

  const removed = await tidyWorkspaces()
  assert.ok(fs.existsSync(clone), "a stash a failed push left behind is still somebody's work")
  assert.equal(removed.clones, 0)
})

// ---------------------------------------------------------------------------
// The dial
// ---------------------------------------------------------------------------

test("CMA_TIDY_DAYS=0 disables tidying entirely", async () => {
  const { name, clone } = stageClone()
  const tree = addTree(clone, name, "optout")
  age(tree, 400)

  process.env.CMA_TIDY_DAYS = "0"
  try {
    const removed = await tidyWorkspaces()
    assert.ok(fs.existsSync(tree))
    assert.deepEqual(removed, { worktrees: 0, scratch: 0, clones: 0 })
  } finally {
    delete process.env.CMA_TIDY_DAYS
  }

  // Staged aged, so taken out by hand — later tests count their own removals.
  fs.rmSync(tree, { recursive: true, force: true })
  fs.rmSync(clone, { recursive: true, force: true })
})

test("the dial reads sane values and refuses the rest", () => {
  assert.equal(keepDays(), 14)

  try {
    process.env.CMA_TIDY_DAYS = "30"
    assert.equal(keepDays(), 30)
    process.env.CMA_TIDY_DAYS = "0"
    assert.equal(keepDays(), 0)
    process.env.CMA_TIDY_DAYS = "-5"
    assert.equal(keepDays(), 14, "a negative keep is nonsense, not a request")
    process.env.CMA_TIDY_DAYS = "soon"
    assert.equal(keepDays(), 14)
  } finally {
    delete process.env.CMA_TIDY_DAYS
  }
})

test("a tidy pass says what it removed, and nothing when there was nothing", async () => {
  const { name, clone } = stageClone()
  const tree = addTree(clone, name, "loud")
  age(tree, 20)

  const lines = []
  await tidyWorkspaces({ log: (line) => lines.push(line) })
  assert.equal(lines.length, 1)
  assert.match(lines[0], /1 old session working tree/)
  assert.match(lines[0], /nothing uncommitted or unpushed/)

  const quiet = []
  await tidyWorkspaces({ log: (line) => quiet.push(line) })
  assert.deepEqual(quiet, [], "a machine with nothing to tidy stays quiet")

  fs.rmSync(clone, { recursive: true, force: true })
})
