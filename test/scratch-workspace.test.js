// A session with no repository still needs somewhere Claude Code may write —
// without workspace.ensure the job carried no workdir, file tools were never
// allowed, and the model pasted whole files into its reply.
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"

import { runCommand, WORKSPACES_DIR } from "../src/repos.js"

test("workspace.ensure creates a scratch directory and reuses it", async () => {
  const key = `test${process.pid}`
  const expected = path.join(WORKSPACES_DIR, `scratch__${key}`)

  try {
    const first = await runCommand("workspace.ensure", { workspace: key })
    assert.equal(first.path, expected)
    assert.ok(fs.existsSync(expected))

    const second = await runCommand("workspace.ensure", { workspace: key })
    assert.equal(second.path, first.path)
  } finally {
    fs.rmSync(expected, { recursive: true, force: true })
  }
})

test("workspace.ensure refuses a key that sanitises to nothing", async () => {
  // Traversal characters are stripped, not honoured — "../.." is no key at all.
  await assert.rejects(() => runCommand("workspace.ensure", { workspace: "../.." }))
  await assert.rejects(() => runCommand("workspace.ensure", {}))
})
