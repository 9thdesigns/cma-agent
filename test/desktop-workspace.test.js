// The Desktop workspace: a folder somebody can actually find.
//
// ~/.configure-my-ai/workspaces works, but it is invisible to anyone who
// doesn't already know it exists. `workspace.desktop` makes
// config-my-ai-workspace-<device id> on the machine's own Desktop, turns it
// into a real git repository, and shares it — mkdir plus repos:add, done for
// the user. Everything is composed on this machine: the server sends no path
// and no name, which is the property these tests pin down alongside the happy
// path.
import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

// repos.js reads CMA_AGENT_HOME when it is imported, so the sandbox has to
// exist before the dynamic import below. CMA_DESKTOP_DIR keeps the test off
// any real Desktop.
const AGENT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "cma-desktop-home-"))
const DESKTOP = fs.mkdtempSync(path.join(os.tmpdir(), "cma-desktop-"))
process.env.CMA_AGENT_HOME = AGENT_HOME
process.env.CMA_DESKTOP_DIR = DESKTOP

const { runCommand, listRoots, DESKTOP_WORKSPACE_PREFIX } = await import("../src/repos.js")
const { writeConfig } = await import("../src/config.js")

const DEVICE_ID = "0f9d3c1e-aaaa-bbbb-cccc-1234567890ab"

test("workspace.desktop refuses an unpaired machine", async () => {
  // No config.json yet, so no device id — the folder name cannot be built.
  await assert.rejects(() => runCommand("workspace.desktop", {}), /pair/)
})

test("workspace.desktop creates, inits and shares the folder, then reuses it", async () => {
  writeConfig({ device_id: DEVICE_ID })
  const expected = path.join(DESKTOP, `${DESKTOP_WORKSPACE_PREFIX}${DEVICE_ID}`)

  const first = await runCommand("workspace.desktop", {})
  assert.equal(first.path, expected)
  assert.equal(first.created, true)
  assert.equal(first.branch, "main")
  assert.ok(first.last_commit, "the scaffold commit gives the repo a real history")
  assert.ok(fs.existsSync(path.join(expected, ".git")))
  assert.ok(fs.existsSync(path.join(expected, "README.md")))
  assert.ok(listRoots().includes(expected), "the folder is shared like a repos:add root")

  // A second press finds the same folder rather than making another.
  const second = await runCommand("workspace.desktop", {})
  assert.equal(second.path, expected)
  assert.equal(second.created, false)
  assert.equal(listRoots().filter((r) => r === expected).length, 1)

  // Being shared means every later git.* command resolves it.
  const summary = await runCommand("git.summary", { path: expected })
  assert.equal(summary.branch, "main")
})

test("workspace.desktop ignores whatever the server sends as params", async () => {
  const expected = path.join(DESKTOP, `${DESKTOP_WORKSPACE_PREFIX}${DEVICE_ID}`)
  // A hostile path in the params must not move the folder or leak into it.
  const result = await runCommand("workspace.desktop", { path: "/etc", name: "../../evil" })
  assert.equal(result.path, expected)
})

test("workspace.desktop refuses a device id that cannot be a folder name", async () => {
  writeConfig({ device_id: "../escape" })
  await assert.rejects(() => runCommand("workspace.desktop", {}), /pair/)
  writeConfig({ device_id: DEVICE_ID }) // restore for anything that runs after
})
