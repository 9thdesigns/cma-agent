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

test("workspace.ensure seeds the session's files, stays inside the workspace, and leaves unchanged files alone", async () => {
  const key = `seed${process.pid}`
  const dir = path.join(WORKSPACES_DIR, `scratch__${key}`)
  try {
    const first = await runCommand("workspace.ensure", {
      workspace: key,
      files: [
        { path: "index.html", body: "<h1>hi</h1>" },
        { path: "src/app.js", body: "console.log(1)" },
        { path: "../../escape.txt", body: "no" },
        { path: "/etc/passwd", body: "no" },
        { path: "bin.png", body: null }
      ]
    })
    assert.equal(first.path, dir)
    assert.equal(first.seeded, 3, "two real files, and the absolute path contained as a relative one")
    assert.equal(fs.readFileSync(path.join(dir, "index.html"), "utf8"), "<h1>hi</h1>")
    assert.equal(fs.readFileSync(path.join(dir, "src", "app.js"), "utf8"), "console.log(1)")
    assert.ok(!fs.existsSync(path.join(WORKSPACES_DIR, "..", "escape.txt")), "a step outside is dropped")
    assert.ok(fs.existsSync(path.join(dir, "etc", "passwd")), "an absolute path lands inside the workspace")

    const before = fs.statSync(path.join(dir, "index.html")).mtimeMs
    const again = await runCommand("workspace.ensure", {
      workspace: key,
      files: [{ path: "index.html", body: "<h1>hi</h1>" }, { path: "src/app.js", body: "console.log(2)" }]
    })
    assert.equal(again.seeded, 1, "only the changed file is rewritten")
    assert.equal(fs.statSync(path.join(dir, "index.html")).mtimeMs, before, "an unchanged seed keeps its mtime")
    assert.equal(fs.readFileSync(path.join(dir, "src", "app.js"), "utf8"), "console.log(2)")
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
