// git.push — carrying a run's work onto a branch.
//
// The bug these pin cost a real run three tool calls and a lot of wall clock:
//
//   ✗ Couldn't switch to configure-my-ai/code-xjxjiv95dt: error: Your local
//     changes to the following files would be overwritten by checkout:
//         app/views/shared/_outside_app_nav_styles.html.erb
//
// `push` used to checkout the target branch BEFORE committing, and `git
// checkout` refuses to switch while a modified file differs between HEAD and
// the target. For this caller that is the normal case — the second push of a
// session lands on a branch already holding the first push's version of the
// files the run just edited again — so the operation failed exactly when it was
// doing its job, three times in a row, before a later attempt happened to find
// the tree agreeable.
import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"

// repos.js reads CMA_AGENT_HOME at import, so the sandbox exists first.
const AGENT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "cma-push-home-"))
process.env.CMA_AGENT_HOME = AGENT_HOME

const { runCommand } = await import("../src/repos.js")
const { writeConfig } = await import("../src/config.js")

// A repo with a bare origin, `main`, and a session branch that already carries
// its OWN version of the file a run is about to edit. That divergence is the
// whole point: without it `git checkout` has nothing to refuse.
function stage({ sessionBranch = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cma-push-root-"))
  const repo = path.join(root, "proj")
  const remote = path.join(root, "remote.git")
  const git = (args, cwd = repo) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim()

  execFileSync("git", ["init", "--quiet", "--bare", "-b", "main", remote])
  fs.mkdirSync(repo)
  execFileSync("git", ["init", "--quiet", "-b", "main"], { cwd: repo })
  git(["config", "user.email", "t@example.com"])
  git(["config", "user.name", "Test"])
  git(["remote", "add", "origin", remote])
  fs.writeFileSync(path.join(repo, "nav.css"), "font: inherit;\n")
  git(["add", "-A"])
  git(["commit", "--quiet", "-m", "base"])
  git(["push", "--quiet", "-u", "origin", "main"])

  if (sessionBranch) {
    git(["checkout", "--quiet", "-b", "session"])
    fs.writeFileSync(path.join(repo, "nav.css"), "font: inherit; /* first push */\n")
    git(["add", "-A"])
    git(["commit", "--quiet", "-m", "first push"])
    git(["push", "--quiet", "-u", "origin", "session"])
    git(["checkout", "--quiet", "main"])
  }

  writeConfig({ device_id: "dev-1", repoRoots: [root] })
  return { repo, git, write: (name, body) => fs.writeFileSync(path.join(repo, name), body) }
}

test("a dirty tree reaches an existing branch instead of being refused", async () => {
  const { repo, git, write } = stage()
  write("nav.css", "font-family: inherit; /* the run's fix */\n")

  const out = await runCommand("git.push", { path: repo, branch: "session", message: "the run's fix" })

  assert.equal(out.branch, "session")
  assert.equal(out.committed, true)
  // The run's version is the intended new state, so it is the one that landed —
  // not the older copy the branch was holding.
  assert.equal(git(["show", "HEAD:nav.css"]), "font-family: inherit; /* the run's fix */")
  assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"]), "session")
  // And nothing is left behind: no dirt, and no stash entry to replay onto a
  // later push.
  assert.equal(git(["status", "--porcelain"]), "")
  assert.equal(git(["stash", "list"]), "")
})

test("a file the run CREATED is carried too, not left behind", async () => {
  const { repo, git, write } = stage()
  write("nav.css", "font-family: inherit;\n")
  write("brand-new.css", ".added-by-the-run {}\n")

  await runCommand("git.push", { path: repo, branch: "session", message: "two files" })

  // Untracked files are why the stash is taken with --include-untracked; a plain
  // stash would have switched branches and abandoned this one.
  assert.equal(git(["show", "HEAD:brand-new.css"]), ".added-by-the-run {}")
  assert.equal(git(["show", "HEAD:nav.css"]), "font-family: inherit;")
})

test("the ordinary cases still behave: a new branch, a clean tree, a second push", async () => {
  const fresh = stage({ sessionBranch: false })
  fresh.write("nav.css", "font-family: inherit;\n")
  const first = await runCommand("git.push", { path: fresh.repo, branch: "brand/new", message: "first" })
  assert.equal(first.branch, "brand/new")
  assert.equal(first.committed, true)
  assert.equal(fresh.git(["show", "HEAD:nav.css"]), "font-family: inherit;")

  // Already on the branch, tree clean: nothing to commit, and a push that is a
  // no-op rather than an error.
  const again = await runCommand("git.push", { path: fresh.repo, branch: "brand/new", message: "second" })
  assert.equal(again.committed, false)
  assert.equal(again.branch, "brand/new")

  // Already on the branch, tree dirty: the path that always worked.
  fresh.write("nav.css", "font-family: inherit; /* more */\n")
  const third = await runCommand("git.push", { path: fresh.repo, branch: "brand/new", message: "third" })
  assert.equal(third.committed, true)
  assert.equal(fresh.git(["show", "HEAD:nav.css"]), "font-family: inherit; /* more */")
})

test("a push that cannot switch leaves the work where it found it", async () => {
  const { repo, git, write } = stage()
  write("nav.css", "font-family: inherit; /* unsaved */\n")

  // An unborn base makes the checkout fail after the stash is taken, which is
  // the moment the work is most easily lost.
  await assert.rejects(
    () => runCommand("git.push", { path: repo, branch: "other", base: "no-such-base", message: "x" }),
    /Couldn't switch to other/
  )

  assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"]), "main")
  assert.equal(fs.readFileSync(path.join(repo, "nav.css"), "utf8"), "font-family: inherit; /* unsaved */\n")
  assert.equal(git(["stash", "list"]), "")
})
