// The Cursor adapter against what real cursor-agent builds actually print
// and accept — not against Claude Code's spelling of the same ideas.
//
// Every wire shape here is a dated third-party capture of a real build
// (2026.05 → 2026.08) or Cursor's own published SDK types; the evidence is
// tabled in docs/internal/provider-wire-contracts.md. Nothing has
// been run against a build by this codebase's authors, which is exactly why
// the fixtures are literal captures rather than plausible shapes.
//
// Run with: node --test "agent/test/*.test.js"

import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  cliConfigFor, cursor, cursorOwnedAgent, cursorUsage, effortModel, EFFORT_VARIANTS,
  permissionsFor, resumeSessionId, writeConfig
} from "../src/runtimes/cursor.js"
import { FORBIDDEN_GIT } from "../src/runtimes/shared.js"

const GITHUB = { token: "cmagh_secret", endpoint: "https://example.com/api/code/v1/github" }
const WEB = { token: "cmagh_websecret", endpoint: "https://example.com/api/code/v1/web" }

const REPO_JOB = { model: "composer-2.5", system: "operator instructions", workdir: "/repo", github: GITHUB }
const CHAT_JOB = { model: "composer-2.5", system: "operator instructions" }

// The literal `result` line imcodes committed for
// `echo "what is 1+1" | cursor-agent --print --output-format stream-json --force`
// on build 2026.05.04-08e5280.
const CAPTURED_RESULT = {
  type: "result", subtype: "success", is_error: false, duration_ms: 3120, duration_api_ms: 2950,
  result: "2", session_id: "8f1c2a7e-4b3d-4e21-9c55-1d2e3f4a5b6c", request_id: "req_01",
  usage: { inputTokens: 1227, outputTokens: 13, cacheReadTokens: 10624, cacheWriteTokens: 0 }
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cma-cursor-test-"))
}

// ---------------------------------------------------------------------------
// Usage: Cursor's SDK shape, camelCase and additive
// ---------------------------------------------------------------------------

test("the captured result folds to the canonical additive shape, nothing dropped", () => {
  const out = cursor.collapseEvents([
    { type: "system", subtype: "init", session_id: CAPTURED_RESULT.session_id, model: "composer-2.5" },
    { type: "assistant", message: { content: [{ type: "text", text: "2" }] } },
    CAPTURED_RESULT
  ])

  assert.equal(out.usage.input_tokens, 1227)
  assert.equal(out.usage.output_tokens, 13)
  assert.equal(out.usage.cache_read_input_tokens, 10624)
  assert.equal(out.usage.cache_creation_input_tokens, 0)
  // 10,624 cached against 1,227 fresh for a one-line prompt: the cached share
  // cannot be inside inputTokens, so the prompt side is the sum.
  assert.equal(
    out.usage.input_tokens + out.usage.cache_read_input_tokens + out.usage.cache_creation_input_tokens,
    11_851
  )
  // Cursor reports no per-turn occupancy: 0 means "unknown, draw no meter".
  assert.equal(out.usage.context_tokens, 0)
  assert.equal(out.content, "2")
  assert.ok(out.sawResult)
})

test("cursorUsage maps every camelCase spelling and still folds the snake_case ones", () => {
  const camel = cursorUsage({ inputTokens: 5, outputTokens: 6, cacheReadTokens: 7, cacheWriteTokens: 8 })
  assert.deepEqual(camel, {
    input_tokens: 5, output_tokens: 6, cache_creation_input_tokens: 8, cache_read_input_tokens: 7,
    context_tokens: 0
  })

  // A build that ever speaks Claude Code's spelling must not lose anything.
  const snake = cursorUsage({
    input_tokens: 5, output_tokens: 6, cache_read_input_tokens: 7, cache_creation_input_tokens: 8
  })
  assert.deepEqual(snake, camel)

  // And the snake_case spelling wins when both are present — it is the one
  // every other adapter's normalizer already trusts.
  assert.equal(cursorUsage({ input_tokens: 1, inputTokens: 2 }).input_tokens, 1)
})

test("reasoning tokens are carried as information, never added to output", () => {
  // The SDK declares reasoningTokens as optional and "a subset of output";
  // no CLI build has been seen to print it. If one does, output stays what
  // the CLI said and the reasoning figure rides beside it.
  const out = cursorUsage({ inputTokens: 10, outputTokens: 40, cacheReadTokens: 0, cacheWriteTokens: 0,
                            reasoningTokens: 25 })
  assert.equal(out.output_tokens, 40)
  assert.equal(out.reasoning_tokens, 25)
  assert.ok(!("reasoning_tokens" in cursorUsage({ inputTokens: 10, outputTokens: 40 })))
})

test("garbage usage degrades to zeros rather than throwing", () => {
  for (const bad of [undefined, null, "usage", 42]) {
    assert.equal(cursorUsage(bad).input_tokens, 0)
  }
  const out = cursor.collapseEvents([{ type: "result", result: "ok" }])
  assert.equal(out.usage.input_tokens, 0)
  assert.equal(out.usage.cache_read_input_tokens, 0)
})

// ---------------------------------------------------------------------------
// Session id and model label: reported only when known
// ---------------------------------------------------------------------------

test("the session id is reported for the next turn to resume, from result or init", () => {
  const fromResult = cursor.collapseEvents([CAPTURED_RESULT])
  assert.equal(fromResult.usage.runtime_session_id, CAPTURED_RESULT.session_id)

  const fromInit = cursor.collapseEvents([
    { type: "system", subtype: "init", session_id: "init-only" },
    { type: "result", result: "ok", usage: CAPTURED_RESULT.usage }
  ])
  assert.equal(fromInit.usage.runtime_session_id, "init-only")

  // Absent means unknown. An empty string or a 0 would mean something.
  const none = cursor.collapseEvents([{ type: "result", result: "ok", usage: CAPTURED_RESULT.usage }])
  assert.ok(!("runtime_session_id" in none.usage))
  assert.ok(!("model_label" in none.usage))
})

test("init.model is always the label; it becomes the model only when it is id-shaped", () => {
  // Whether Cursor prints the id or the display label there is unverified.
  // The server stores `model` as an id (the Usage page shows it and a
  // context window is prefix-matched from it), so a label must not land there.
  const id = cursor.collapseEvents([
    { type: "system", subtype: "init", model: "claude-opus-5-high" },
    { type: "result", result: "ok", usage: CAPTURED_RESULT.usage }
  ])
  assert.equal(id.model, "claude-opus-5-high")
  assert.equal(id.usage.model_label, "claude-opus-5-high")

  const label = cursor.collapseEvents([
    { type: "system", subtype: "init", model: "Claude Opus 5 (High)" },
    { type: "result", result: "ok", usage: CAPTURED_RESULT.usage }
  ])
  assert.equal(label.model, null, "a display label must not be stored as the id that ran")
  assert.equal(label.usage.model_label, "Claude Opus 5 (High)")
})

// ---------------------------------------------------------------------------
// argv: -p with the prompt on stdin, --trust, --resume, --approve-mcps
// ---------------------------------------------------------------------------

test("a headless run is -p, stream-json and --trust, with the prompt on stdin", () => {
  const args = cursor.streamingArgs(CHAT_JOB, "ignored: the engine pipes the prompt")

  assert.deepEqual(args.slice(0, 4), ["-p", "--output-format", "stream-json", "--trust"])
  assert.equal(cursor.promptOnStdin, true)
  assert.ok(!args.some((arg) => /ignored/.test(arg)), "the prompt must never reach argv")
  assert.deepEqual(args.slice(4), ["--model", "composer-2.5"])
  // The buffered `--output-format json` envelope carries no usage at all, so
  // there is no fallback that would keep the token counts.
  assert.equal(cursor.supportsBuffered, false)
})

test("the login probe keeps its positional prompt and answers the trust prompt too", () => {
  const args = cursor.probeArgs()
  assert.equal(args[0], "-p")
  assert.equal(args[1], "Reply with the single word: ok")
  assert.ok(args.includes("--trust"))
  assert.ok(!args.includes("--force"))
})

test("--approve-mcps is passed only when there is an MCP server on disk to approve", () => {
  assert.ok(cursor.streamingArgs(REPO_JOB).includes("--approve-mcps"))
  assert.ok(cursor.streamingArgs({ ...CHAT_JOB, web: WEB }).includes("--approve-mcps"))
  assert.ok(!cursor.streamingArgs(CHAT_JOB).includes("--approve-mcps"))
  assert.ok(!cursor.streamingArgs({ model: "auto", workdir: "/repo" }).includes("--approve-mcps"))
})

test("a repository turn is bounded by the deny list and the sandbox, in argv order", () => {
  const args = cursor.streamingArgs(REPO_JOB)
  const after = (flag) => args[args.indexOf(flag) + 1]

  assert.equal(after("--model"), "composer-2.5")
  assert.ok(args.includes("--force"))
  assert.equal(after("--sandbox"), "enabled")
  assert.equal(after("--workspace"), "/repo")
  assert.ok(!args.includes("--yolo"))
  assert.ok(!args.includes("--stream-partial-output"),
    "the partial-output replay would double the answer in collapseEvents")
})

// ---------------------------------------------------------------------------
// --resume: the job's runtime_session_id, read defensively
// ---------------------------------------------------------------------------

const RESUMABLE = {
  ...REPO_JOB,
  runtime_session_id: "8f1c2a7e-4b3d-4e21-9c55-1d2e3f4a5b6c",
  messages: [
    { role: "user", content: "add a test" },
    { role: "assistant", content: "Added." },
    { role: "user", content: "now run it" }
  ]
}

test("a job carrying a session id resumes it and sends only what is new", () => {
  assert.equal(resumeSessionId(RESUMABLE), RESUMABLE.runtime_session_id)

  const args = cursor.streamingArgs(RESUMABLE)
  assert.equal(args[args.indexOf("--resume") + 1], RESUMABLE.runtime_session_id)
  assert.ok(args.indexOf("--resume") > args.indexOf("--trust"))

  const prompt = cursor.renderPrompt(RESUMABLE, "User: add a test\n\nAssistant: Added.\n\nUser: now run it")
  assert.equal(prompt, "now run it")
  assert.ok(!prompt.includes("<system>"), "Cursor already holds the system text from the first turn")
})

test("without a session id, or without anything new to say, the turn runs fresh", () => {
  assert.equal(resumeSessionId(REPO_JOB), null)
  assert.ok(!cursor.streamingArgs(REPO_JOB).includes("--resume"))

  const nothingNew = { ...RESUMABLE, messages: RESUMABLE.messages.slice(0, 2) }
  assert.equal(resumeSessionId(nothingNew), null)
  assert.ok(!cursor.streamingArgs(nothingNew).includes("--resume"))
  assert.ok(cursor.renderPrompt(nothingNew, "the whole conversation").includes("<system>"))

  const noMessages = { ...RESUMABLE, messages: undefined }
  assert.equal(resumeSessionId(noMessages), null)
})

test("a session id that could read as a flag or as several words never reaches argv", () => {
  for (const bad of ["--yolo", "-p", "a b", "", "x;rm -rf", "id\n--force", 42, null]) {
    assert.equal(resumeSessionId({ ...RESUMABLE, runtime_session_id: bad }), null, JSON.stringify(bad))
  }
  assert.equal(resumeSessionId({ ...RESUMABLE, runtime_session_id: " chat_01HXYZ:2 " }), "chat_01HXYZ:2")
})

test("a resumed prompt renders every new message, in order", () => {
  const job = {
    ...RESUMABLE,
    messages: [
      ...RESUMABLE.messages,
      { role: "user", content: [{ type: "text", text: "and lint" }] }
    ]
  }
  assert.equal(cursor.renderPrompt(job, "ignored"), 'now run it\n\n[{"type":"text","text":"and lint"}]')
})

// ---------------------------------------------------------------------------
// The effort dial: only ever a sibling the build listed, never -fast or -max
// ---------------------------------------------------------------------------

test("the dial rewrites the effort token to a listed sibling", () => {
  assert.equal(effortModel("gpt-5.4", "high"), "gpt-5.4-high")
  assert.equal(effortModel("gpt-5.4-high", "low"), "gpt-5.4-low")
  assert.equal(effortModel("claude-opus-5-thinking-low", "high"), "claude-opus-5-thinking-high")
  assert.equal(effortModel("claude-sonnet-5", "medium"), "claude-sonnet-5-medium")
  assert.equal(effortModel("cursor-grok-4.6-high", "xhigh"), "cursor-grok-4.6-xhigh")
  assert.equal(effortModel("gemini-3.7-flash-high", "low"), "gemini-3.7-flash-low")
})

test("xhigh takes the family's own spelling of it, and max is never -max", () => {
  assert.equal(effortModel("gpt-5.5-medium", "xhigh"), "gpt-5.5-extra-high")
  assert.equal(effortModel("gpt-5.6-sol-medium", "max"), "gpt-5.6-sol-xhigh")
  assert.equal(effortModel("claude-opus-4-8-high", "max"), "claude-opus-4-8-xhigh")
  // A family with no xhigh sibling stops at high.
  assert.equal(effortModel("claude-opus-5-low", "xhigh"), "claude-opus-5-high")
  assert.equal(effortModel("gpt-5.1-low", "max"), "gpt-5.1-high")
  for (const [base, offered] of Object.entries(EFFORT_VARIANTS)) {
    for (const level of ["low", "medium", "high", "xhigh", "max"]) {
      const picked = effortModel(`${base}-${offered[0]}`, level)
      assert.ok(!picked.endsWith("-max"), `${base} + ${level} chose ${picked}`)
    }
  }
})

test("a level the family does not offer leaves the id alone rather than guessing", () => {
  // gpt-5.2 lists low/high/xhigh; the bare id IS its default, and moving it
  // for "medium" in either direction would be inventing a preference.
  assert.equal(effortModel("gpt-5.2", "medium"), "gpt-5.2")
  assert.equal(effortModel("gpt-5.2-high", "medium"), "gpt-5.2-high")
  assert.equal(effortModel("claude-4.6-opus-high", "low"), "claude-4.6-opus-high")
  assert.equal(effortModel("claude-4.6-opus-high-thinking", "low"), "claude-4.6-opus-high-thinking")
  assert.equal(effortModel("kimi-k3-high", "medium"), "kimi-k3-high")
})

test("Composer, auto and anything without effort siblings are untouched", () => {
  for (const id of ["auto", "composer-2.5", "composer-2.5-fast", "gemini-3.1-pro", "gpt-5-mini",
                    "claude-4.5-sonnet-thinking", "kimi-k2.7-code"]) {
    for (const level of ["low", "medium", "high", "xhigh", "max"]) {
      assert.equal(effortModel(id, level), id)
    }
  }
})

test("the user's own -fast and -max choices survive the dial", () => {
  // -fast is a priced priority tier and -max is Max mode (1M context, the
  // vendor's long-context tier). The dial neither adds nor strips them.
  assert.equal(effortModel("gpt-5.6-luna-medium-fast", "low"), "gpt-5.6-luna-low-fast")
  assert.equal(effortModel("claude-opus-4-8-thinking-max", "max"), "claude-opus-4-8-thinking-max")
  assert.equal(effortModel("claude-opus-4-8-thinking-max-fast", "max"), "claude-opus-4-8-thinking-max-fast")
  // A dial below max does move a -max id down: that is cheaper, not pricier.
  assert.equal(effortModel("claude-opus-4-8-max", "high"), "claude-opus-4-8-high")
})

test("a family the table has never seen swaps only among low/medium/high", () => {
  assert.equal(effortModel("gpt-7-preview-high", "low"), "gpt-7-preview-low")
  assert.equal(effortModel("gpt-7-preview-high", "xhigh"), "gpt-7-preview-high")
  assert.equal(effortModel("gpt-7-preview", "high"), "gpt-7-preview")
})

test("no dial, an unknown level, or no model means no rewrite", () => {
  assert.equal(effortModel("gpt-5.4-high", undefined), "gpt-5.4-high")
  assert.equal(effortModel("gpt-5.4-high", ""), "gpt-5.4-high")
  assert.equal(effortModel("gpt-5.4-high", "turbo"), "gpt-5.4-high")
  assert.equal(effortModel(undefined, "high"), undefined)
  // Ai::Effort's words arrive lower-case, but the dial should not care.
  assert.equal(effortModel("gpt-5.4-high", " LOW "), "gpt-5.4-low")
})

test("the dial reaches argv through --model", () => {
  const args = cursor.streamingArgs({ ...CHAT_JOB, model: "gpt-5.4", effort: "high" })
  assert.equal(args[args.indexOf("--model") + 1], "gpt-5.4-high")
  assert.equal(cursor.streamingArgs(CHAT_JOB)[cursor.streamingArgs(CHAT_JOB).indexOf("--model") + 1],
    "composer-2.5")
})

// ---------------------------------------------------------------------------
// cli-config.json: the file the CLI actually enforces from
// ---------------------------------------------------------------------------

test("cli-config.json has the shape a probe proved the CLI reads", () => {
  const config = cliConfigFor(REPO_JOB)
  assert.equal(config.version, 1)
  assert.deepEqual(config.editor, { vimMode: false })
  assert.deepEqual(config.permissions, permissionsFor(REPO_JOB).permissions)
  assert.deepEqual(config.permissions.allow, [])
  assert.equal(config.permissions.deny.length, FORBIDDEN_GIT.length * 2)
})

test("writeConfig lands cli-config.json, owner-only, and clears the old permissions.json", () => {
  const dir = tempDir()
  try {
    fs.writeFileSync(path.join(dir, "permissions.json"), "{}\n")
    writeConfig(CHAT_JOB, dir)

    const file = path.join(dir, "cli-config.json")
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), cliConfigFor(CHAT_JOB))
    assert.equal(fs.statSync(file).mode & 0o777, 0o600)
    assert.ok(!fs.existsSync(path.join(dir, "permissions.json")))
    assert.ok(!fs.existsSync(path.join(dir, "mcp.json")), "a chat with no grant gets no MCP file")
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("the adapter states the posture it actually runs with", () => {
  assert.ok(cursor.limitations.some((line) => /every shell command allowed except/.test(line)),
    "the width of a --force turn must be declared, not dressed up as an allow list")
})

// ---------------------------------------------------------------------------
// Locating the binary: `agent` only from Cursor's own install paths
// ---------------------------------------------------------------------------

function fakeHome({ target, link = path.join(".local", "bin", "agent") }) {
  const home = tempDir()
  const real = path.join(home, target)
  fs.mkdirSync(path.dirname(real), { recursive: true })
  fs.writeFileSync(real, "#!/bin/sh\necho agent\n", { mode: 0o755 })
  fs.mkdirSync(path.dirname(path.join(home, link)), { recursive: true })
  fs.symlinkSync(real, path.join(home, link))
  return home
}

test("an `agent` symlink into Cursor's own install directory is accepted", () => {
  const home = fakeHome({ target: path.join(".local", "share", "cursor-agent", "versions", "2026.08.25", "agent") })
  try {
    assert.equal(cursorOwnedAgent(cursor.agentHomePaths, home), path.join(home, ".local", "bin", "agent"))
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test("an `agent` that resolves anywhere else is another vendor's, and is refused", () => {
  // xAI's installer also provides an `agent`, and that binary rejects
  // --force / --trust / --workspace — a run through it would fail in ways
  // that read as Cursor being broken.
  const home = fakeHome({ target: path.join(".grok", "bin", "agent") })
  try {
    assert.equal(cursorOwnedAgent(cursor.agentHomePaths, home), null)
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test("no `agent` at all, or no home, is simply not found", () => {
  const home = tempDir()
  try {
    assert.equal(cursorOwnedAgent(cursor.agentHomePaths, home), null)
    assert.equal(cursorOwnedAgent(cursor.agentHomePaths, path.join(home, "missing")), null)
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
  assert.deepEqual(cursor.agentHomePaths, [".cursor/bin/agent", ".local/bin/agent"])
  assert.equal(cursor.cli, "cursor-agent", "PATH is only ever searched for the specific name")
})
