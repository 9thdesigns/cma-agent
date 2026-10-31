// Cross-runtime permission invariants. Each adapter documents its own
// permission story; this file pins the rules they must ALL keep, so a change
// to one adapter can't quietly widen what a headless turn may do.
import { test } from "node:test"
import assert from "node:assert/strict"

const ADAPTERS = ["antigravity", "claude-code", "codex", "cursor", "gemini", "grok"]

// Flags that switch a CLI's permission layer off entirely. None of them is
// ever acceptable for an unattended turn.
const NEVER = [
  "danger-full-access",
  "--dangerously-skip-permissions",
  "bypassPermissions",
  "--dangerously-bypass-approvals-and-sandbox",
]

// Grants that only a repository turn (one with a checkout) may carry.
const REPO_ONLY = ["workspace-write", "acceptEdits", "--add-dir"]

async function argsFor(name, job) {
  const mod = await import(`../src/runtimes/${name}.js`)
  return mod.baseArgs(job).map(String)
}

for (const name of ADAPTERS) {
  for (const [label, job] of [["chat", {}], ["repository", { workdir: "/tmp/cma-policy-test" }]]) {
    test(`${name} ${label} turn never disables the permission layer`, async () => {
      const args = await argsFor(name, job)
      for (const flag of NEVER) {
        assert.ok(!args.some((a) => a.includes(flag)), `${name} ${label}: ${flag} in ${args.join(" ")}`)
      }
    })
  }

  test(`${name} chat turn carries no repository-only grant`, async () => {
    const args = await argsFor(name, {})
    for (const flag of REPO_ONLY) {
      assert.ok(!args.includes(flag), `${name} chat: ${flag} in ${args.join(" ")}`)
    }
  })
}
