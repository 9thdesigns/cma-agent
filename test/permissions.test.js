// What a turn on someone's machine is allowed to do.
//
// This is a security decision expressed as a list of strings, and a list of
// strings is exactly the kind of thing that drifts silently. It is also the
// list that decides whether a session can ship its own work at all: before it
// existed, every `git` command came back "This command requires approval" and
// a headless run had nobody to approve it, so the turn ended by asking the
// user to run the commands themselves.
//
// Run with: node --test agent/test

import { test } from "node:test"
import assert from "node:assert/strict"

import { baseArgs } from "../src/claude.js"
import { TOOLS, operationFor } from "../src/mcp.js"

const valueOf = (args, flag) => {
  const i = args.indexOf(flag)
  return i === -1 ? null : args[i + 1]
}

const REPO_JOB = {
  model: "claude-opus-5",
  system: "…",
  workdir: "/repo",
  github: { token: "cmagh_secret", endpoint: "https://example.com/api/code/v1/github" }
}

test("a repository turn can read, edit, drive git and call the GitHub tools", () => {
  const args = baseArgs(REPO_JOB)
  const allowed = valueOf(args, "--allowedTools").split(",")

  assert.ok(args.includes("acceptEdits"))
  for (const tool of ["Read", "Write", "Edit", "Grep", "Glob"]) {
    assert.ok(allowed.includes(tool), `${tool} should be allowed`)
  }
  for (const verb of ["add", "commit", "checkout", "fetch", "stash", "push", "branch"]) {
    assert.ok(allowed.includes(`Bash(git ${verb}:*)`), `git ${verb} should be allowed`)
  }
  assert.ok(allowed.includes("mcp__cma_github"))
})

test("the allowance stops at git — it is not a shell", () => {
  const allowed = valueOf(baseArgs(REPO_JOB), "--allowedTools").split(",")

  // Named individually rather than by regex, because the failure this guards
  // against is someone adding one of these to unblock a task.
  for (const forbidden of ["Bash", "Bash(:*)", "Bash(npm:*)", "Bash(curl:*)", "Bash(rm:*)", "Bash(sudo:*)"]) {
    assert.ok(!allowed.includes(forbidden), `${forbidden} must not be allowed`)
  }
})

test("git commands that destroy work are denied, and deny beats allow", () => {
  const denied = valueOf(baseArgs(REPO_JOB), "--disallowedTools").split(",")

  for (const tool of [
    "Bash(git push --force:*)",
    "Bash(git push -f:*)",
    "Bash(git reset --hard:*)",
    "Bash(git clean:*)"
  ]) {
    assert.ok(denied.includes(tool), `${tool} must be denied`)
  }
})

test("the GitHub token never reaches the MCP config — it travels by environment", () => {
  const config = valueOf(baseArgs(REPO_JOB), "--mcp-config")

  assert.ok(!config.includes("cmagh_secret"))
  const parsed = JSON.parse(config)
  assert.equal(parsed.mcpServers.cma_github.args[1], "mcp-github")
})

test("a plain chat completion gets none of this", () => {
  const args = baseArgs({ model: "claude-opus-5", system: "…" })

  assert.equal(valueOf(args, "--allowedTools"), null)
  assert.equal(valueOf(args, "--mcp-config"), null)
  assert.ok(!args.includes("--permission-mode"))
})

test("a session with no checkout still gets the GitHub tools, but no git and no elevation", () => {
  const args = baseArgs({ model: "claude-opus-5", github: REPO_JOB.github })
  const allowed = valueOf(args, "--allowedTools").split(",")

  assert.ok(allowed.includes("mcp__cma_github"))
  assert.ok(!allowed.some((tool) => tool.startsWith("Bash(git")))
  assert.ok(!args.includes("--permission-mode"))
})

test("every MCP tool maps onto a server operation name", () => {
  const expected = [
    "repo.info", "branch.list", "branch.create", "branch.delete", "branch.rename",
    "local.push",
    "pr.open", "pr.list", "pr.get", "pr.update", "pr.comment", "pr.merge"
  ]

  assert.deepEqual(TOOLS.map((tool) => operationFor(tool.name)), expected)
  // Only the FIRST underscore becomes a dot, or a two-word tool would address
  // an operation that doesn't exist.
  assert.equal(operationFor("branch_create"), "branch.create")
})
