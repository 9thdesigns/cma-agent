import { test } from "node:test"
import assert from "node:assert/strict"

import {
  CHAT_DISALLOWED_TOOLS, STREAM_SCHEMA, STREAM_SCHEMA_VERSION,
  additiveUsageFrom, codewhale, effortArgs, execArgs, globalArgs
} from "../src/runtimes/codewhale.js"

// ---------------------------------------------------------------------------
// The fixtures below are CodeWhale's own (v0.9.13): the `turn_usage` example
// from docs/AGENT_RUNTIME.md, the shape lock in
// crates/tui/tests/integration/exec_turn_usage.rs, and the `ExecStreamMeta`
// receipt from crates/tui/src/lib.rs — nested under `meta`, every event
// wrapped in the `codewhale.exec-stream` v1 envelope.
// ---------------------------------------------------------------------------

const ENVELOPE = { schema: STREAM_SCHEMA, schema_version: STREAM_SCHEMA_VERSION }

// docs/AGENT_RUNTIME.md: 1200 = 900 hits + 300 misses; reasoning INSIDE the
// 180 output; the replay figure is a client-side estimate.
const DOCUMENTED_TURN = {
  ...ENVELOPE, type: "turn_usage", turn: 1, input_tokens: 1200, output_tokens: 180,
  reasoning_tokens: 90, prompt_cache_hit_tokens: 900, prompt_cache_miss_tokens: 300,
  prompt_cache_write_tokens: 0, reasoning_replay_tokens: 40, duration_ms: 1834
}

function receipt(overrides = {}) {
  return {
    ...ENVELOPE, type: "metadata",
    meta: {
      receipt_kind: "terminal", provider: "deepseek", model: "deepseek-flash", route_source: "config",
      input_tokens: 1200, output_tokens: 180, prompt_cache_hit_tokens: 900,
      prompt_cache_miss_tokens: 300, reasoning_tokens: 90, duration_ms: 1834,
      approval_posture: "deny", sandbox_posture: "read-only", prompt_sha256: "9c1e",
      input_analysis: { estimated_request_tokens: 1180, user_message_count: 1 },
      visible_final_answer_chars: 11, visible_final_answer_excerpt: "Hello world",
      session_id: "fp-8d2a", resume_command: "codewhale --resume 01JXAMPLE", workspace: "/repo",
      message_count: 2, status: "completed",
      ...overrides
    }
  }
}

const content = (text) => ({ ...ENVELOPE, type: "content", content: text })
const done = () => ({ ...ENVELOPE, type: "done" })

// ---------------------------------------------------------------------------
// Inclusive → additive
// ---------------------------------------------------------------------------

test("the documented turn_usage example converts to the additive shape", () => {
  assert.deepEqual(additiveUsageFrom(DOCUMENTED_TURN), {
    input_tokens: 300,
    output_tokens: 180,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 900,
    context_tokens: 1200
  })
})

test("CodeWhale's own shape lock: prompt 20 = hit 12 + miss 8 is 8 fresh, 12 read", () => {
  const out = codewhale.collapseEvents([
    content("ok"),
    { ...ENVELOPE, type: "turn_usage", turn: 1, input_tokens: 20, output_tokens: 5,
      prompt_cache_hit_tokens: 12, prompt_cache_miss_tokens: 8, duration_ms: 210 },
    done()
  ])

  assert.equal(out.usage.input_tokens, 8)
  assert.equal(out.usage.cache_read_input_tokens, 12)
  assert.equal(out.usage.cache_creation_input_tokens, 0)
  assert.equal(out.usage.output_tokens, 5)
  assert.equal(out.usage.context_tokens, 20, "the prompt CodeWhale reported, not 20 + 12")
})

test("a turn without the optional fields is all fresh input, and reasoning stays unknown", () => {
  // Optional fields are OMITTED when the provider did not report them —
  // never null, never zero-filled. Omitted is 0 for the buckets, and
  // reasoning is left absent rather than reported as 0.
  const out = codewhale.collapseEvents([
    content("ok"),
    { ...ENVELOPE, type: "turn_usage", turn: 1, input_tokens: 640, output_tokens: 32, duration_ms: 500 },
    done()
  ])

  assert.equal(out.usage.input_tokens, 640)
  assert.equal(out.usage.cache_read_input_tokens, 0)
  assert.equal(out.usage.cache_creation_input_tokens, 0)
  assert.equal(out.usage.output_tokens, 32)
  assert.equal(out.usage.reasoning_tokens, undefined)
  assert.equal(out.usage.num_turns, 1)
})

test("cache writes on the Anthropic wire come out of input, not on top of it", () => {
  // client/anthropic.rs re-normalises input to hit + miss + write, "the
  // DeepSeek convention", so the write is inside the prompt too.
  const out = codewhale.collapseEvents([
    content("ok"),
    { ...ENVELOPE, type: "turn_usage", turn: 1, input_tokens: 5000, output_tokens: 100,
      prompt_cache_hit_tokens: 3000, prompt_cache_miss_tokens: 500, prompt_cache_write_tokens: 1500,
      duration_ms: 900 },
    done()
  ])

  assert.equal(out.usage.input_tokens, 500)
  assert.equal(out.usage.cache_read_input_tokens, 3000)
  assert.equal(out.usage.cache_creation_input_tokens, 1500)
  assert.equal(out.usage.context_tokens, 5000)
})

test("reasoning is informational — inside output — and the replay estimate never counts", () => {
  const out = codewhale.collapseEvents([content("ok"), DOCUMENTED_TURN, done()])

  assert.equal(out.usage.output_tokens, 180, "not 180 + 90")
  assert.equal(out.usage.reasoning_tokens, 90)
  assert.equal(
    out.usage.input_tokens + out.usage.cache_read_input_tokens + out.usage.cache_creation_input_tokens,
    1200,
    "reasoning_replay_tokens (40) is an estimate of bytes already in the prompt"
  )
})

// ---------------------------------------------------------------------------
// The terminal receipt
// ---------------------------------------------------------------------------

test("the receipt nests everything under meta: model, route and session are read from there", () => {
  const out = codewhale.collapseEvents([
    content("Hello "), content("world"), DOCUMENTED_TURN,
    { ...ENVELOPE, type: "session_capture", content: "[redacted]", saved_session_id: "01JXAMPLE" },
    receipt(), done()
  ])

  assert.equal(out.content, "Hello world")
  assert.equal(out.model, "deepseek-flash")
  assert.equal(out.usage.model_label, "deepseek-flash")
  assert.equal(out.usage.runtime_session_id, "01JXAMPLE")
  assert.equal(out.runtimeMeta.provider, "deepseek")
  assert.equal(out.runtimeMeta.routeSource, "config")
  assert.equal(out.runtimeMeta.status, "completed")
  assert.equal(out.runtimeMeta.usageSource, "turn_usage", "a receipt that matches the per-call sum does not replace it")
  assert.equal(out.runtimeMeta.schemaNote, null)
  assert.ok(out.sawResult)
  assert.ok(!out.isError)
})

test("delegated spend reaches only the receipt, so a larger receipt wins — occupancy does not", () => {
  // In-process children fold into the run's authoritative total, which the
  // stream carries only in `metadata.meta`; no `turn_usage` is emitted for
  // them. The receipt is cumulative, and cumulative is the one thing the
  // occupancy reading must never be taken from.
  const out = codewhale.collapseEvents([
    content("done"),
    { ...ENVELOPE, type: "turn_usage", turn: 1, input_tokens: 1200, output_tokens: 180,
      prompt_cache_hit_tokens: 900, prompt_cache_miss_tokens: 300, reasoning_tokens: 90, duration_ms: 1834 },
    { ...ENVELOPE, type: "agent_spawned", id: "child-1", model: "deepseek-v4-pro", spawn_depth: 1 },
    { ...ENVELOPE, type: "turn_usage", turn: 2, input_tokens: 800, output_tokens: 60,
      prompt_cache_hit_tokens: 700, prompt_cache_miss_tokens: 100, reasoning_tokens: 20, duration_ms: 700 },
    receipt({ input_tokens: 6000, output_tokens: 900, prompt_cache_hit_tokens: 4000,
              prompt_cache_miss_tokens: 2000, reasoning_tokens: 300 }),
    done()
  ])

  assert.equal(out.usage.input_tokens, 2000)
  assert.equal(out.usage.cache_read_input_tokens, 4000)
  assert.equal(out.usage.output_tokens, 900)
  assert.equal(out.usage.reasoning_tokens, 300)
  assert.equal(out.usage.context_tokens, 800, "the last per-call prompt, never the cumulative receipt")
  assert.equal(out.usage.num_turns, 2)
  assert.equal(out.runtimeMeta.usageSource, "metadata")
})

test("no turn_usage and no receipt counts is unmeasured, not zero-filled — and not a failure", () => {
  // The event is skipped when the provider reported no usage ("honest
  // absence"); the answer is still an answer.
  const out = codewhale.collapseEvents([
    content("Hello"), receipt({ input_tokens: undefined, output_tokens: undefined,
                                prompt_cache_hit_tokens: undefined, prompt_cache_miss_tokens: undefined,
                                reasoning_tokens: undefined }),
    done()
  ])

  assert.equal(out.content, "Hello")
  assert.equal(out.usage.input_tokens, 0)
  assert.equal(out.usage.output_tokens, 0)
  assert.equal(out.usage.cache_read_input_tokens, 0)
  assert.equal(out.usage.context_tokens, 0)
  assert.equal(out.usage.reasoning_tokens, undefined)
  assert.equal(out.usage.num_turns, undefined)
  assert.equal(out.usage.model_label, "deepseek-flash", "the model is still known")
  assert.equal(out.runtimeMeta.usageSource, null)
  assert.ok(!out.isError)
})

test("the envelope: a matching schema is silent, a newer version is noted and still read", () => {
  const same = codewhale.collapseEvents([content("ok"), DOCUMENTED_TURN, done()])
  assert.equal(same.runtimeMeta.schemaNote, null)

  const newer = codewhale.collapseEvents([
    { ...content("ok"), schema_version: 2 },
    { ...DOCUMENTED_TURN, schema_version: 2, some_future_field: 7 },
    { ...done(), schema_version: 2 }
  ])
  assert.match(newer.runtimeMeta.schemaNote, /schema_version 2 is newer/)
  assert.equal(newer.usage.input_tokens, 300, "the documented fields are still read")
  assert.equal(newer.content, "ok")

  const other = codewhale.collapseEvents([{ ...DOCUMENTED_TURN, schema: "someone.else" }, done()])
  assert.match(other.runtimeMeta.schemaNote, /"someone\.else", not codewhale\.exec-stream/)

  const bare = codewhale.collapseEvents([{ type: "turn_usage", input_tokens: 5, output_tokens: 1 }, { type: "done" }])
  assert.equal(bare.runtimeMeta.schemaNote, null, "builds before 0.9.9 carried no envelope; that is not a mismatch")
})

test("the outcome is the receipt's status, not the presence of an error event", () => {
  // `error` events carry retries and notices as well as fatal failures;
  // exec_agent.rs exits non-zero on failed | canceled | interrupted and on
  // nothing else.
  const failed = codewhale.collapseEvents([
    { ...ENVELOPE, type: "error", error: "insufficient credit" },
    receipt({ status: "failed", error: "Insufficient Balance", error_category: "credit",
              termination_reason: "provider_error" }),
    done()
  ])
  assert.equal(failed.isError, true)
  assert.match(failed.errorStatus, /Insufficient Balance/)
  assert.equal(failed.runtimeMeta.terminationReason, "provider_error")

  const notice = codewhale.collapseEvents([
    { ...ENVELOPE, type: "error", error: "request retried after a 429" },
    content("Hello"), DOCUMENTED_TURN, receipt(), done()
  ])
  assert.equal(notice.isError, false)
  assert.deepEqual(notice.runtimeMeta.warnings, ["request retried after a 429"])
  assert.equal(notice.content, "Hello")

  const interrupted = codewhale.collapseEvents([content("part"), receipt({ status: "interrupted" }), done()])
  assert.equal(interrupted.isError, true)
  assert.match(interrupted.errorStatus, /interrupted/)

  const noReceipt = codewhale.collapseEvents([{ ...ENVELOPE, type: "error", error: "boom" }])
  assert.equal(noReceipt.isError, true, "without a receipt, an error event is the outcome")
  assert.match(noReceipt.errorStatus, /boom/)
})

// ---------------------------------------------------------------------------
// argv and environment
// ---------------------------------------------------------------------------

const CHAT_JOB = { model: "deepseek-flash", effort: "medium", system: "operator instructions" }
const REPO_JOB = { ...CHAT_JOB, workdir: "/repo" }

test("--model is an exec flag and follows the subcommand", () => {
  // ExecArgs has `model`; the root Cli has no such flag.
  assert.ok(!globalArgs(REPO_JOB).includes("--model"))

  const args = codewhale.streamingArgs(REPO_JOB, "hi")
  assert.ok(args.indexOf("--model") > args.indexOf("exec"))
  assert.equal(args[args.indexOf("--model") + 1], "deepseek-flash")
})

test("the effort dial reaches --reasoning-effort verbatim; anything else is left to CodeWhale", () => {
  assert.deepEqual(effortArgs({ effort: "xhigh" }), ["--reasoning-effort", "xhigh"])
  assert.deepEqual(effortArgs({ effort: "max" }), ["--reasoning-effort", "max"])
  assert.deepEqual(effortArgs({ effort: " Medium " }), ["--reasoning-effort", "medium"])
  assert.deepEqual(effortArgs({ effort: "ultra" }), [], "a tier the platform does not name is not guessed")
  assert.deepEqual(effortArgs({}), [], "no dial: the user's configured tier applies")
  assert.deepEqual(effortArgs({ effort: null }), [])

  const args = execArgs(REPO_JOB)
  assert.equal(args[args.indexOf("--reasoning-effort") + 1], "medium")
})

test("a chat turn takes the native tools off the surface; a repository turn keeps them", () => {
  // Without `--auto` every tool call is denied and still costs a model step
  // (and the schemas ride on every request). A chat has no folder to read,
  // so the tools that would only ever be denied are not offered at all.
  const chat = codewhale.streamingArgs(CHAT_JOB, "hi")
  assert.ok(!chat.includes("--auto"))
  assert.equal(chat[chat.indexOf("--sandbox") + 1], "read-only")
  assert.equal(chat[chat.indexOf("--disallowed-tools") + 1], "read,write,edit,bash,agent",
               "one comma-delimited token, the way CodeWhale parses the flag")
  assert.deepEqual(CHAT_DISALLOWED_TOOLS, ["read", "write", "edit", "bash", "agent"])

  const repo = codewhale.streamingArgs(REPO_JOB, "hi")
  assert.ok(repo.includes("--auto"))
  assert.ok(!repo.includes("--disallowed-tools"), "a repository turn needs read/write/edit/bash to work")

  const probe = codewhale.probeArgs()
  assert.equal(probe[probe.indexOf("--disallowed-tools") + 1], "read,write,edit,bash,agent")
})

test("app-driven runs never post telemetry on the user's behalf", () => {
  const env = codewhale.envFor({ workdir: "/repo" }, { filesDir: () => "/nowhere" })
  assert.equal(env.CODEWHALE_TELEMETRY, "0")
  assert.equal(env.CODEWHALE_MCP_CONFIG, undefined, "no grant, no MCP variable")
})

// ---------------------------------------------------------------------------
// Ticker
// ---------------------------------------------------------------------------

test("the receipt is not a start, a spawned agent is a delegation, and real tool_use spells name/input", () => {
  assert.equal(codewhale.describeEvent(receipt()), null, "metadata is the LAST event before done")
  assert.equal(
    codewhale.describeEvent({ ...ENVELOPE, type: "agent_spawned", id: "c1", model: "deepseek-v4-pro", spawn_depth: 1 }),
    "Delegating to deepseek-v4-pro"
  )
  assert.equal(
    codewhale.describeEvent({ ...ENVELOPE, type: "tool_use", name: "edit", id: "t1",
                              input: { path: "app/models/user.rb" }, started_at: 1 }),
    "Editing models/user.rb"
  )
  assert.equal(
    codewhale.writtenPathFrom({ ...ENVELOPE, type: "tool_use", name: "write", id: "t2", input: { path: "docs/plan.md" } }),
    "docs/plan.md"
  )
})
