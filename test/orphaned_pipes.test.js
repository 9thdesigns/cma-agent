// A run whose CLI is gone but whose children are not.
//
// `close` fires when the process has exited AND every stdio stream it held has
// closed. Anything the CLI spawned — an MCP server, a shell tool still running
// a test suite — inherits those pipes and keeps them open after the CLI itself
// is dead. So a promise that waits only on `close` waits for the grandchildren,
// and when we SIGKILL a run (cancelled from the web app, or past the idle
// ceiling) the grandchildren are exactly what survives.
//
// That is not a slow run, it is a lost one: the runner holds a concurrency slot
// per job in flight and blocks when they are all taken. Enough leaked slots and
// the machine stops claiming coding turns entirely — silently, while the
// git-command lane beside it keeps answering, so the terminal looks healthy and
// every turn sent to it sits in the queue until it expires.
//
// The fake CLI below is the whole scenario in four lines: print, orphan a child
// that holds stdout far longer than this test may take, exit.
//
// Run with: node --test "agent/test/*.test.js"

import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const { runtimeVersion } = await import("../src/engine.js")

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "cma-orphan-"))
const CLI = path.join(DIR, "fake-cli")

fs.writeFileSync(CLI, [
  "#!/bin/sh",
  'echo "fake-cli 1.2.3"',
  "# Inherits our stdout and outlives us — an MCP server, or a shell tool",
  "# still running when the CLI above it was killed.",
  "sleep 20 &",
  "exit 0"
].join("\n"))
fs.chmodSync(CLI, 0o755)

const runtime = { resolveBin: () => ({ bin: CLI }), versionArgs: [] }

test("a process that exits leaving a child on its pipes still settles", async () => {
  const startedAt = Date.now()

  const version = await runtimeVersion(runtime)

  assert.equal(version, "fake-cli 1.2.3", "the output written before exiting is still read")
  // Waiting on `close` here means waiting on `sleep 45`. Anything near that is
  // the bug, whatever the value eventually returned.
  assert.ok(Date.now() - startedAt < 8000,
            `settled in ${Date.now() - startedAt}ms — it is waiting on the orphan, not the process`)
})
