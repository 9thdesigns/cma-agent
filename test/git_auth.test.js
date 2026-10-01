// How git authenticates on a machine we run, and never on a laptop.
import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const home = fs.mkdtempSync(path.join(os.tmpdir(), "cma-git-auth-"))
process.env.CMA_AGENT_HOME = home

const { gitEnvFor, askpassPath, ASKPASS_SCRIPT } = await import("../src/git_auth.js")
const { isScratchWorkspace, WORKSPACES_DIR } = await import("../src/repos.js")

const channel = { endpoint: "https://cma.example.com/api/code/v1/github/", token: "cmagh_abc" }

test("a laptop gets no git credential environment, whatever the server sent", () => {
  delete process.env.CMA_HOSTED
  assert.deepEqual(gitEnvFor(channel), {})
})

test("a hosted machine gets an askpass helper that holds no secret and a trimmed endpoint", () => {
  process.env.CMA_HOSTED = "1"
  try {
    const env = gitEnvFor(channel)
    assert.equal(env.GIT_ASKPASS, askpassPath())
    assert.equal(env.GIT_TERMINAL_PROMPT, "0")
    assert.equal(env.CMA_GITHUB_ENDPOINT, "https://cma.example.com/api/code/v1/github")
    assert.equal(env.CMA_GITHUB_TOKEN, "cmagh_abc")
    assert.equal(fs.readFileSync(env.GIT_ASKPASS, "utf8"), ASKPASS_SCRIPT)
    assert.ok(!ASKPASS_SCRIPT.includes("cmagh_abc"), "the script is generic")
    assert.ok((fs.statSync(env.GIT_ASKPASS).mode & 0o077) === 0, "private to the companion's user")
    assert.deepEqual(gitEnvFor({ endpoint: "", token: "" }), {}, "no channel, no environment")
  } finally {
    delete process.env.CMA_HOSTED
  }
})

test("a scratch workspace is recognised by where it lives", () => {
  assert.equal(isScratchWorkspace(path.join(WORKSPACES_DIR, "scratch__s1")), true)
  assert.equal(isScratchWorkspace(path.join(WORKSPACES_DIR, "acme__widgets")), false)
  assert.equal(isScratchWorkspace(path.join(WORKSPACES_DIR, "scratch__s1", "sub")), false)
  assert.equal(isScratchWorkspace("/tmp/elsewhere/scratch__s1"), false)
})
