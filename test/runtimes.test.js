// What each runtime is allowed to do, and that the three agree.
//
// The Claude Code allowance is asserted in permissions.test.js as an argv.
// Cursor expresses the same decision as a FILE and Gemini as a different set
// of flags, so "did we accidentally grant Cursor a shell" is not a question
// any existing test could answer. These are the tests that make the three
// comparable.
//
// Run with: node --test "agent/test/*.test.js"

import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { RUNTIMES, DEFAULT_RUNTIME, getRuntime, runtimeIds } from "../src/runtimes/index.js"
import { claudeCode } from "../src/runtimes/claude-code.js"
import { cursor, permissionsFor, writeConfig } from "../src/runtimes/cursor.js"
import { gemini } from "../src/runtimes/gemini.js"
import { GIT_VERBS, FORBIDDEN_GIT } from "../src/runtimes/shared.js"
import { withoutCapabilityFlags } from "../src/engine.js"

const REPO_JOB = {
  model: "composer-2",
  system: "operator instructions",
  workdir: "/repo",
  github: { token: "cmagh_secret", endpoint: "https://example.com/api/code/v1/github" }
}

const CHAT_JOB = { model: "composer-2", system: "operator instructions" }

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cma-runtime-test-"))
}

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

test("every registered runtime implements the surface the engine calls", () => {
  for (const runtime of RUNTIMES) {
    for (const key of ["id", "name", "cli", "install"]) {
      assert.ok(runtime[key], `${runtime.id} is missing ${key}`)
    }
    for (const fn of ["streamingArgs", "describeEvent", "collapseEvents", "classifyFailure",
                      "resolveBin", "advice", "probeArgs", "loginArgs", "envFor"]) {
      assert.equal(typeof runtime[fn], "function", `${runtime.id} is missing ${fn}()`)
    }
    // A buffered fallback is optional, but claiming one without implementing
    // it would only be discovered when a run needed it.
    if (runtime.supportsBuffered) {
      assert.equal(typeof runtime.bufferedArgs, "function", `${runtime.id} claims buffered support`)
      assert.equal(typeof runtime.parseBuffered, "function", `${runtime.id} claims buffered support`)
    }
  }
})

test("runtime ids match what the server stores", () => {
  // These strings are a contract with AiCredential::LOCAL_RUNTIMES. A rename
  // on either side silently produces jobs no machine will claim.
  assert.deepEqual(runtimeIds(), ["claude_code", "cursor", "gemini_cli"])
  assert.equal(DEFAULT_RUNTIME, "claude_code")
})

test("an unknown runtime resolves to null, and a missing one to the default", () => {
  // The two cases the runner distinguishes: "update the companion" versus
  // "an old server sent no runtime at all".
  assert.equal(getRuntime("codex"), null)
  assert.equal(getRuntime(""), claudeCode)
  assert.equal(getRuntime(null), claudeCode)
})

// ---------------------------------------------------------------------------
// Cursor: the allowance is a file, so the file is what gets asserted
// ---------------------------------------------------------------------------

test("a Cursor repository turn gets the same git allowance Claude Code gets", () => {
  const { permissions } = permissionsFor(REPO_JOB)

  for (const verb of ["add", "commit", "checkout", "fetch", "stash", "push", "branch"]) {
    assert.ok(permissions.allow.includes(`Shell(git ${verb})`), `git ${verb} should be allowed`)
  }
  assert.equal(
    permissions.allow.filter((entry) => entry.startsWith("Shell(git ")).length,
    GIT_VERBS.length,
    "the two runtimes must allow the same git verbs, not merely overlapping ones"
  )
})

test("the Cursor allowance stops at git — it is not a shell", () => {
  const { permissions } = permissionsFor(REPO_JOB)

  // Named individually rather than by regex, because the failure this guards
  // against is someone adding one of these to unblock a task.
  for (const forbidden of ["Shell", "Shell(*)", "Shell(npm)", "Shell(curl)", "Shell(rm)", "Shell(sudo)"]) {
    assert.ok(!permissions.allow.includes(forbidden), `${forbidden} must not be allowed`)
  }
  // And nothing may allow a bare shell by wildcard either.
  for (const entry of permissions.allow) {
    assert.ok(!/^Shell\([*]/.test(entry), `${entry} is a wildcard shell grant`)
  }
})

test("Cursor denies the git commands that destroy work", () => {
  const { permissions } = permissionsFor(REPO_JOB)

  for (const command of FORBIDDEN_GIT) {
    assert.ok(permissions.deny.includes(`Shell(${command})`), `${command} must be denied`)
  }
})

test("a plain Cursor chat gets no file tools and no shell at all", () => {
  const { permissions } = permissionsFor(CHAT_JOB)

  assert.deepEqual(permissions.allow, [])
  // The deny list still stands. An empty allow list is the grant; the denies
  // are the backstop, and dropping them for a chat would mean a future change
  // to the allow list quietly re-enables them.
  assert.ok(permissions.deny.length > 0)
})

test("--force is only ever passed with a workspace, never on a bare chat", () => {
  // --force means "don't stop to ask". It is safe only because permissions.json
  // is in place, and permissions.json only bounds a job that has a workdir.
  assert.ok(cursor.streamingArgs(REPO_JOB, "hi").includes("--force"))
  assert.ok(!cursor.streamingArgs(CHAT_JOB, "hi").includes("--force"))
  // And --yolo must never appear anywhere: it is the flag that hands over the
  // machine.
  assert.ok(!cursor.streamingArgs(REPO_JOB, "hi").includes("--yolo"))
})

test("Cursor's config is written to our directory and carries no secret", () => {
  const dir = tempDir()
  try {
    writeConfig(REPO_JOB, dir)

    const permissions = fs.readFileSync(path.join(dir, "permissions.json"), "utf8")
    const mcp = fs.readFileSync(path.join(dir, "mcp.json"), "utf8")

    // The whole point of the file living here: not ~/.cursor, not the repo.
    assert.ok(!dir.includes(".cursor"))
    assert.ok(!permissions.includes("cmagh_secret"))
    assert.ok(!mcp.includes("cmagh_secret"), "the GitHub token must travel by environment, never on disk")

    const parsed = JSON.parse(mcp)
    assert.equal(parsed.mcpServers.cma_github.args[1], "mcp-github")
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("a job with no GitHub grant leaves no stale mcp.json behind", () => {
  const dir = tempDir()
  try {
    writeConfig(REPO_JOB, dir)
    assert.ok(fs.existsSync(path.join(dir, "mcp.json")))

    // The same profile directory, reused by the next job. A leftover config
    // would keep the tools offered — and failing — after the grant is gone.
    writeConfig({ workdir: "/repo" }, dir)
    assert.ok(!fs.existsSync(path.join(dir, "mcp.json")))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("the GitHub token reaches Cursor by environment and nothing else", () => {
  const env = cursor.envFor(REPO_JOB)

  assert.equal(env.CMA_GITHUB_TOKEN, "cmagh_secret")
  assert.ok(!cursor.streamingArgs(REPO_JOB, "hi").some((arg) => String(arg).includes("cmagh_secret")))
})

test("Cursor folds the system prompt into the prompt rather than writing to the repo", () => {
  const rendered = cursor.renderPrompt(REPO_JOB, "User: hello")

  assert.ok(rendered.includes("operator instructions"))
  assert.ok(rendered.includes("User: hello"))
  // No flag carries it, because there is no such flag — that is the whole
  // reason it is in the prompt.
  assert.ok(!cursor.streamingArgs(REPO_JOB, rendered).includes("--append-system-prompt"))
})

test("Cursor has no ambient profile, so its allowance always has a home", () => {
  // If Cursor could run ambient, there would be no directory we own to put
  // permissions.json in, and --force would be unbounded.
  assert.equal(cursor.ambientProfile, false)
  assert.equal(cursor.configDirEnvVar, "CURSOR_CONFIG_DIR")
})

// ---------------------------------------------------------------------------
// Gemini: fails closed
// ---------------------------------------------------------------------------

test("Gemini auto-approves edits and nothing else", () => {
  const args = gemini.streamingArgs(REPO_JOB, "hi")
  const mode = args[args.indexOf("--approval-mode") + 1]

  assert.equal(mode, "auto_edit")
  // yolo is "automatically accept all actions". It must never be reachable.
  assert.ok(!args.includes("--yolo"))
  assert.ok(!args.includes("yolo"))
})

test("Gemini is never granted a shell — the allowance fails closed", () => {
  const args = gemini.streamingArgs(REPO_JOB, "hi")
  const allowed = String(args[args.indexOf("--allowed-tools") + 1]).split(",")

  assert.ok(allowed.includes("read_file"))
  assert.ok(allowed.includes("write_file"))
  assert.ok(!allowed.includes("run_shell_command"),
    "granting shell here would need a policy file we have not verified; the machine pushes instead")
})

test("a plain Gemini chat gets no approval mode and no tool grant", () => {
  const args = gemini.streamingArgs(CHAT_JOB, "hi")

  assert.ok(!args.includes("--approval-mode"))
  assert.ok(!args.includes("--allowed-tools"))
})

test("Gemini says what it cannot do", () => {
  // `status` prints these. A limitation nobody can see is one people discover
  // when a session ends by asking them to push its own work by hand.
  assert.ok(gemini.limitations.some((line) => /git/i.test(line)))
  assert.equal(gemini.multiLogin, false)
})

// ---------------------------------------------------------------------------
// Stream folding — one shape out, whichever runtime produced it
// ---------------------------------------------------------------------------

test("Cursor's stream folds to the shared result shape", () => {
  const events = [
    { type: "system", subtype: "init", session_id: "s1", model: "composer-2" },
    { type: "assistant", message: { content: [{ type: "text", text: "Hello " }] } },
    { type: "assistant", message: { content: [{ type: "text", text: "world" }] } },
    { type: "result", subtype: "success", result: "Hello world", is_error: false,
      usage: { input_tokens: 10, output_tokens: 4 } }
  ]

  const out = cursor.collapseEvents(events)
  assert.equal(out.content, "Hello world")
  assert.equal(out.model, "composer-2")
  assert.equal(out.usage.input_tokens, 10)
  assert.equal(out.usage.output_tokens, 4)
  assert.equal(out.isError, false)
  assert.ok(out.sawResult)
})

test("Gemini's result event carries no text, so the answer comes from the messages", () => {
  const events = [
    { type: "init", session_id: "s1", model: "gemini-2.5-pro" },
    { type: "message", role: "user", content: "hi" },
    { type: "message", role: "assistant", content: "Hello world" },
    { type: "result", status: "success",
      stats: { promptTokenCount: 10, candidatesTokenCount: 4 } }
  ]

  const out = gemini.collapseEvents(events)
  assert.equal(out.content, "Hello world", "a user message must not leak into the answer")
  assert.equal(out.model, "gemini-2.5-pro")
  assert.equal(out.usage.input_tokens, 10)
  assert.equal(out.usage.output_tokens, 4)
  assert.ok(!out.isError)
})

test("an in-band failure is a failure, whatever the exit code said", () => {
  // Every one of these CLIs reports API errors and rate limits with a ZERO
  // exit code. Trusting the exit code would render the error text as the
  // assistant's reply.
  assert.equal(cursor.collapseEvents([{ type: "result", is_error: true, result: "rate limited" }]).isError, true)
  assert.equal(gemini.collapseEvents([{ type: "result", status: "error", error: { message: "nope" } }]).isError, true)
})

test("a Gemini warning does not throw away a good answer", () => {
  const out = gemini.collapseEvents([
    { type: "message", role: "assistant", content: "Done." },
    { type: "error", severity: "warning", message: "a tool call was blocked" },
    { type: "result", status: "success", stats: {} }
  ])

  assert.equal(out.content, "Done.")
  assert.equal(out.isError, false)
})

test("a stream that dies before the result still yields what was said", () => {
  for (const runtime of [cursor, gemini]) {
    const events = runtime === cursor
      ? [{ type: "assistant", message: { content: [{ type: "text", text: "partial" }] } }]
      : [{ type: "message", role: "assistant", content: "partial" }]

    const out = runtime.collapseEvents(events)
    assert.equal(out.content, "partial")
    assert.ok(!out.sawResult, `${runtime.id} must report that no result event arrived`)
  }
})

// ---------------------------------------------------------------------------
// The ticker
// ---------------------------------------------------------------------------

test("Cursor's separate tool_call events produce the same ticker lines", () => {
  // The one structural difference from Claude Code: tool calls are their own
  // top-level events rather than blocks inside an assistant message.
  const line = (event) => cursor.describeEvent(event)

  assert.equal(line({ type: "system", subtype: "init" }), "Starting up")
  assert.equal(
    line({ type: "tool_call", subtype: "started", tool_call: { editToolCall: { args: { path: "app/models/user.rb" } } } }),
    "Editing models/user.rb"
  )
  assert.equal(
    line({ type: "tool_call", subtype: "started", tool_call: { shellToolCall: { args: { command: "cd /r && git status" } } } }),
    "Running git status"
  )
  // A completed call is not a new action — reporting it would double every
  // line in the trace.
  assert.equal(line({ type: "tool_call", subtype: "completed", tool_call: { editToolCall: {} } }), null)
})

test("Gemini's tool_use events produce the same ticker lines", () => {
  assert.equal(gemini.describeEvent({ type: "init" }), "Starting up")
  assert.equal(
    gemini.describeEvent({ type: "tool_use", tool_name: "read_file", parameters: { file_path: "app/models/user.rb" } }),
    "Reading models/user.rb"
  )
  assert.equal(
    gemini.describeEvent({ type: "tool_use", tool_name: "replace", parameters: { file_path: "a/b.rb" } }),
    "Editing a/b.rb"
  )
})

// ---------------------------------------------------------------------------
// Degrading instead of dying, for every runtime
// ---------------------------------------------------------------------------

test("stripping capability flags leaves each runtime a runnable argv", () => {
  for (const [runtime, job] of [[cursor, REPO_JOB], [gemini, REPO_JOB]]) {
    const stripped = withoutCapabilityFlags(runtime.streamingArgs(job, "the prompt"))

    for (const flag of ["--force", "--workspace", "--approval-mode", "--allowed-tools"]) {
      assert.ok(!stripped.includes(flag), `${flag} should be gone for ${runtime.id}`)
    }
    // What has to survive: the output format, the model, and the prompt.
    assert.ok(stripped.includes("--output-format"))
    assert.ok(stripped.includes("stream-json"))
    assert.equal(stripped[stripped.indexOf("--model") + 1], job.model)
    assert.ok(stripped.includes("the prompt"), `${runtime.id} lost its prompt`)
  }
})

test("the prompt survives stripping even though Cursor passes it positionally", () => {
  // Cursor's prompt is a bare positional right after -p. `withoutCapabilityFlags`
  // drops a flag AND every non-flag word after it, so a capability flag placed
  // before the prompt would eat it. This is the test that keeps the ordering
  // in streamingArgs honest.
  const stripped = withoutCapabilityFlags(cursor.streamingArgs(REPO_JOB, "open the PR"))
  assert.equal(stripped[stripped.indexOf("-p") + 1], "open the PR")
})
