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

import { baseArgs, bufferedArgs, streamingArgs } from "../src/runtimes/claude-code.js"
import { withoutCapabilityFlags } from "../src/engine.js"
import { TOOLS, operationFor } from "../src/mcp.js"

const valueOf = (args, flag) => {
  const i = args.indexOf(flag)
  return i === -1 ? null : args[i + 1]
}

// --allowedTools and --disallowedTools are variadic: every following word up to
// the next flag is one of their values.
const listOf = (args, flag) => {
  const i = args.indexOf(flag)
  if (i === -1) return null
  const out = []
  for (let j = i + 1; j < args.length && !args[j].startsWith("-"); j++) out.push(args[j])
  return out
}

const REPO_JOB = {
  model: "claude-opus-5",
  system: "…",
  workdir: "/repo",
  github: { token: "cmagh_secret", endpoint: "https://example.com/api/code/v1/github" }
}

test("a repository turn can read, edit, drive git and call the GitHub tools", () => {
  const args = baseArgs(REPO_JOB)
  const allowed = listOf(args, "--allowedTools")

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
  const allowed = listOf(baseArgs(REPO_JOB), "--allowedTools")

  // Named individually rather than by regex, because the failure this guards
  // against is someone adding one of these to unblock a task.
  for (const forbidden of ["Bash", "Bash(:*)", "Bash(npm:*)", "Bash(curl:*)", "Bash(rm:*)", "Bash(sudo:*)"]) {
    assert.ok(!allowed.includes(forbidden), `${forbidden} must not be allowed`)
  }
})

// A session spanning several repositories has a checkout per repository, and
// each one the runner validated is granted with --add-dir. Only those: the
// list is built by the runner from allowlist-checked paths, never taken from
// the model, and a job with no working directory gets no directories at all.
test("a multi-repo turn is granted each extra checkout with --add-dir", () => {
  const args = baseArgs({ ...REPO_JOB, extraWorkdirs: ["/ws/acme__ios", "/ws/acme__api"] })

  const dirs = []
  for (let i = 0; i < args.length; i++) if (args[i] === "--add-dir") dirs.push(args[i + 1])
  assert.deepEqual(dirs, ["/ws/acme__ios", "/ws/acme__api"])
})

test("a single-repo turn adds no extra directories", () => {
  assert.ok(!baseArgs(REPO_JOB).includes("--add-dir"))
})

test("extra directories never ride without a working directory", () => {
  const args = baseArgs({ model: "claude-opus-5", extraWorkdirs: ["/ws/acme__ios"] })

  assert.ok(!args.includes("--add-dir"))
  assert.ok(!args.includes("acceptEdits"))
})

test("git commands that destroy work are denied, and deny beats allow", () => {
  const denied = listOf(baseArgs(REPO_JOB), "--disallowedTools")

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
  const allowed = listOf(args, "--allowedTools")

  assert.ok(allowed.includes("mcp__cma_github"))
  assert.ok(!allowed.some((tool) => tool.startsWith("Bash(git")))
  assert.ok(!args.includes("--permission-mode"))
})

test("every MCP tool maps onto a server operation name", () => {
  const expected = [
    "repo.info", "branch.list", "branch.create", "branch.delete", "branch.rename",
    "local.push",
    "pr.open", "pr.list", "pr.get", "pr.update", "pr.comment",
    "deploy.site",
    "pr.merge"
  ]

  assert.deepEqual(TOOLS.map((tool) => operationFor(tool.name)), expected)
  // Only the FIRST underscore becomes a dot, or a two-word tool would address
  // an operation that doesn't exist.
  assert.equal(operationFor("branch_create"), "branch.create")
})

// ---------------------------------------------------------------------------
// The prompt is not an argument.
//
// `--allowedTools` and `--disallowedTools` are variadic — Claude Code
// documents them as space-separated lists — so an option keeps consuming words
// until it meets another flag. Adding them put a bare positional (the prompt)
// after a variadic option, it was swallowed as one more tool name, and every
// run died with "Input must be provided either through stdin or as a prompt
// argument when using --print".
//
// The prompt now goes in on stdin. This test encodes the invariant that makes
// that safe and keeps it safe: the argv contains flags and flag values, and
// nothing else. Adding another variadic option can no longer break the run.
// ---------------------------------------------------------------------------

// Anything that is not a flag and not a value belonging to the flag before it.
// Variadic options own every word up to the next flag; everything else owns
// exactly one. A leftover is a positional — the thing a variadic option would
// eat, and the thing that killed 0.5.0.
const VARIADIC = new Set(["--allowedTools", "--disallowedTools"])

function positionalsIn(args) {
  const positionals = []
  let owner = null

  for (const arg of args) {
    if (arg.startsWith("-")) {
      owner = arg
      continue
    }
    if (owner && VARIADIC.has(owner)) continue   // still inside its list
    if (owner) { owner = null; continue }        // the single value it takes
    positionals.push(arg)
  }

  return positionals
}

for (const [label, build] of [["streaming", streamingArgs], ["buffered", bufferedArgs]]) {
  test(`the ${label} argv carries no positional for a variadic option to swallow`, () => {
    assert.deepEqual(positionalsIn(build(REPO_JOB)), [])
    assert.deepEqual(positionalsIn(build({ model: "claude-opus-5", system: "…" })), [])
    assert.deepEqual(positionalsIn(build({})), [])
  })

  test(`the ${label} argv never contains the prompt`, () => {
    // The prompt is not even passed to the builders — it reaches the process on
    // stdin — so nothing resembling conversation can appear here.
    const args = build({ ...REPO_JOB, messages: [{ role: "user", content: "open the PR" }] })

    assert.ok(!args.some((arg) => arg.includes("open the PR")))
    assert.ok(args.includes("-p"))
  })
}

test("a variadic option's list is terminated by a flag or by the end of the argv", () => {
  const args = streamingArgs(REPO_JOB)
  for (const variadic of ["--allowedTools", "--disallowedTools"]) {
    const i = args.indexOf(variadic)
    assert.notEqual(i, -1, `${variadic} should be present for a repository job`)

    const list = listOf(args, variadic)
    assert.ok(list.length > 0, `${variadic} must carry at least one tool`)

    const after = args[i + 1 + list.length]
    assert.ok(after === undefined || after.startsWith("-"),
      `${variadic} is variadic; ${after} would be consumed as one of its values`)
  }
})

// ---------------------------------------------------------------------------
// Degrading instead of dying.
//
// Every flag here is another product's, and another product's flags move. A
// build that rejects one should cost the turn its tools, not the turn.
// ---------------------------------------------------------------------------

test("stripping capability flags leaves a runnable argv and takes their values with them", () => {
  const stripped = withoutCapabilityFlags(streamingArgs(REPO_JOB))

  for (const flag of ["--mcp-config", "--allowedTools", "--disallowedTools", "--permission-mode"]) {
    assert.ok(!stripped.includes(flag), `${flag} should be gone`)
  }
  // Their values must go too — a stray "Bash(git add:*)" left behind becomes a
  // positional, which is the bug that killed 0.5.0.
  assert.deepEqual(positionalsIn(stripped), [])
  assert.ok(!stripped.some((a) => a.startsWith("Bash(")))
  assert.ok(!stripped.some((a) => a.startsWith("{")))

  // What has to survive: printing, the output format, the model, the prompt.
  assert.ok(stripped.includes("-p"))
  assert.ok(stripped.includes("--output-format"))
  assert.ok(stripped.includes("stream-json"))
  assert.equal(valueOf(stripped, "--model"), "claude-opus-5")
  assert.equal(valueOf(stripped, "--append-system-prompt"), "…")
})

test("stripping a bare job's deny list still leaves a runnable argv", () => {
  // This used to assert stripping was a no-op here, on the premise that a
  // plain chat job carried no capability flags. That premise is gone on
  // purpose: every job now carries --disallowedTools, because WebFetch has to
  // be denied even where nothing is granted — a headless run can never get it
  // approved, and leaving it on the surface is what made runs reach for it.
  //
  // So the property worth pinning is no longer "no-op" but "still runnable,
  // and the deny values left with their flag".
  const plain = streamingArgs({ model: "claude-opus-5", system: "…" })
  assert.ok(plain.includes("--disallowedTools"), "a bare job still denies the built-in web tools")
  assert.ok(plain.includes("WebFetch"))

  const stripped = withoutCapabilityFlags(plain)

  assert.ok(!stripped.includes("--disallowedTools"))
  assert.ok(!stripped.includes("WebFetch"), "a value left behind becomes a positional")
  assert.ok(!stripped.includes("WebSearch"))
  assert.deepEqual(positionalsIn(stripped), [])

  assert.ok(stripped.includes("-p"))
  assert.equal(valueOf(stripped, "--model"), "claude-opus-5")
  assert.equal(valueOf(stripped, "--append-system-prompt"), "…")
})
