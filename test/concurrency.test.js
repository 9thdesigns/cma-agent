// Running more than one thing at a time, and keeping the sessions apart.
//
// Two separate promises are made here and both have to hold, because either
// one alone is a trap:
//
//   1. The companion takes several jobs at once. Serial execution is what put
//      a second and third chat session into a queue that expired after three
//      minutes and then reported a working machine as offline.
//   2. Each session gets its OWN working tree. Parallel runs sharing one
//      checkout would be two models editing the same files — a worse failure
//      than the queue, and one a user would blame on the model.
//
// The worktree half is exercised against real git rather than mocked: what is
// being asserted is a property of the checkout ("these two directories cannot
// affect each other"), and a fake git cannot have that property. No network —
// origin is a local path.
//
// Run with: node --test "agent/test/*.test.js"

import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

// repos.js reads CMA_AGENT_HOME when it is imported, so the sandbox has to
// exist before the dynamic import below.
const AGENT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "cma-concurrency-home-"))
process.env.CMA_AGENT_HOME = AGENT_HOME

const { ensureCheckout, WORKSPACES_DIR } = await import("../src/repos.js")
const { maxJobs, applySettings } = await import("../src/runner.js")

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim()
}

// A repository to clone from, with one commit on `main`. Stands in for GitHub;
// the "clone" below is made by hand precisely so ensureCheckout takes its
// already-cloned path and never reaches the network.
function makeOrigin() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cma-origin-"))
  git(dir, ["init", "--initial-branch=main"])
  git(dir, ["config", "user.email", "test@example.com"])
  git(dir, ["config", "user.name", "Test"])
  fs.writeFileSync(path.join(dir, "README.md"), "hello\n")
  git(dir, ["add", "-A"])
  git(dir, ["commit", "-m", "first"])
  return dir
}

function makeCacheClone(origin, slug) {
  fs.mkdirSync(WORKSPACES_DIR, { recursive: true, mode: 0o700 })
  const dir = path.join(WORKSPACES_DIR, slug.replace("/", "__"))
  execFileSync("git", ["clone", origin, dir], { encoding: "utf8" })
  return dir
}

// ---------------------------------------------------------------------------
// How many at once
// ---------------------------------------------------------------------------

test("more than one job runs at a time by default", () => {
  delete process.env.CMA_MAX_JOBS
  assert.ok(
    maxJobs() > 1,
    "one-at-a-time is the bug: it is what queued the second and third session until they expired"
  )
})

test("the Devices page sets the limit", () => {
  delete process.env.CMA_MAX_JOBS
  assert.equal(maxJobs(4), 4)

  // A number from the wire must not be able to fork twenty coding CLIs onto a
  // laptop, whatever a stale page or a hand-rolled request sends.
  assert.ok(maxJobs(500) <= 5, "the ceiling is what makes a wrong number survivable")

  // Nonsense never disables the companion: zero jobs is a machine that accepts
  // work and then runs none of it, which looks exactly like a broken one.
  for (const bad of [0, -2, "banana", null, undefined]) {
    assert.ok(maxJobs(bad) >= 1, `${JSON.stringify(bad)} must not stop the companion working`)
  }
})

test("the environment override beats the page, for debugging", () => {
  process.env.CMA_MAX_JOBS = "2"
  assert.equal(maxJobs(5), 2)
  delete process.env.CMA_MAX_JOBS
})

test("a changed limit is applied without a restart", () => {
  delete process.env.CMA_MAX_JOBS
  const limits = { jobs: 3, paused: false }
  const said = []

  applySettings({ max_jobs: 5, paused: false }, limits, (line) => said.push(line))

  assert.equal(limits.jobs, 5, "the pollers read this on every pass — that is the no-restart part")
  assert.match(said.join(" "), /5 jobs/)
})

test("pausing is heard, and says why nothing is arriving", () => {
  const limits = { jobs: 3, paused: false }
  const said = []

  applySettings({ max_jobs: 3, paused: true }, limits, (line) => said.push(line))
  assert.equal(limits.paused, true)
  assert.match(said.join(" "), /[Pp]aused/)

  // Unchanged settings are silent, or a heartbeat every 30s would narrate
  // itself forever.
  const quiet = []
  applySettings({ max_jobs: 3, paused: true }, limits, (line) => quiet.push(line))
  assert.deepEqual(quiet, [])
})

test("an older server changes nothing", () => {
  // No `device` in the heartbeat response at all: keep whatever we resolved
  // locally rather than falling back to a default nobody asked for.
  const limits = { jobs: 4, paused: false }
  applySettings(undefined, limits)

  assert.equal(limits.jobs, 4)
})

// ---------------------------------------------------------------------------
// One working tree per session
// ---------------------------------------------------------------------------

test("two sessions on one repository get working trees that cannot touch each other", async () => {
  const origin = makeOrigin()
  const slug = "acme/widgets"
  makeCacheClone(origin, slug)

  const first = await ensureCheckout({ github: slug, branch: "main", workspace: "s1" })
  const second = await ensureCheckout({ github: slug, branch: "main", workspace: "s2" })

  assert.ok(first.isolated, "a session that names itself must get its own tree")
  assert.ok(second.isolated)
  assert.notEqual(first.path, second.path, "sharing a directory is the conflict this removes")

  // The failure this prevents, acted out: one session edits a file, and the
  // other must not see it. Under the old shared checkout both of these writes
  // landed in the same file.
  fs.writeFileSync(path.join(first.path, "README.md"), "session one was here\n")
  assert.equal(fs.readFileSync(path.join(second.path, "README.md"), "utf8"), "hello\n")

  // …and a branch in one is not a branch checked out in the other, which is
  // what would make the second session's checkout fail outright.
  git(first.path, ["checkout", "-b", "feature-one"])
  git(second.path, ["checkout", "-b", "feature-two"])
  assert.equal(git(first.path, ["rev-parse", "--abbrev-ref", "HEAD"]), "feature-one")
  assert.equal(git(second.path, ["rev-parse", "--abbrev-ref", "HEAD"]), "feature-two")
})

test("a session comes back to the same tree, with its work still in it", async () => {
  const origin = makeOrigin()
  const slug = "acme/gadgets"
  makeCacheClone(origin, slug)

  const first = await ensureCheckout({ github: slug, branch: "main", workspace: "s7" })
  fs.writeFileSync(path.join(first.path, "notes.txt"), "half-finished\n")

  // Turn two of the same session. Re-preparing the checkout must not reset it:
  // uncommitted work between turns is how a session ships anything at all.
  const again = await ensureCheckout({ github: slug, branch: "main", workspace: "s7" })

  assert.equal(again.path, first.path)
  assert.equal(fs.readFileSync(path.join(again.path, "notes.txt"), "utf8"), "half-finished\n")
})

test("two sessions preparing the same repository at the same moment both survive it", async () => {
  const origin = makeOrigin()
  const slug = "acme/parallel"
  makeCacheClone(origin, slug)

  // The case concurrency created: two sessions start together and both ask for
  // the same repository. Unserialised, they race in one clone — two fetches
  // fighting over the same ref lock, or two worktree adds over one prune.
  const [first, second] = await Promise.all([
    ensureCheckout({ github: slug, branch: "main", workspace: "a1" }),
    ensureCheckout({ github: slug, branch: "main", workspace: "a2" })
  ])

  assert.notEqual(first.path, second.path)
  for (const result of [first, second]) {
    assert.ok(fs.existsSync(path.join(result.path, "README.md")), `${result.path} came out incomplete`)
  }
})

test("a session name cannot escape the workspaces directory", async () => {
  const origin = makeOrigin()
  const slug = "acme/things"
  makeCacheClone(origin, slug)

  // The name arrives over the network and becomes a path. Traversal is
  // stripped rather than rejected — the session still runs, it just doesn't get
  // to choose where.
  const escaped = await ensureCheckout({ github: slug, branch: "main", workspace: "../../etc/passwd" })
  const real = fs.realpathSync(escaped.path)
  const home = fs.realpathSync(WORKSPACES_DIR)

  assert.ok(real.startsWith(home), `${real} landed outside ${home}`)
})

test("no session name means the shared checkout, exactly as before", async () => {
  const origin = makeOrigin()
  const slug = "acme/legacy"
  const cache = makeCacheClone(origin, slug)

  // An older server sends no workspace. It must keep getting the directory it
  // has always been given, or every session on it loses its working tree the
  // day the companion updates.
  const result = await ensureCheckout({ github: slug, branch: "main" })

  assert.equal(fs.realpathSync(result.path), fs.realpathSync(cache))
  assert.ok(!result.isolated)
})
