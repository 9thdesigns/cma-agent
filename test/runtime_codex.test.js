// The Codex CLI adapter, against the wire shapes a real `codex exec --json`
// emits (codex-rs/exec/src/exec_events.rs; fixtures quoted from Codex's own
// parser test, a captured 0.114.0 run and openai/codex#19022).
//
// The one fact everything here turns on: Codex counts INCLUSIVELY.
// `input_tokens` is the gross prompt with `cached_input_tokens` and
// `cache_write_input_tokens` inside it; `reasoning_output_tokens` is inside
// `output_tokens`. The companion's shape is additive (Anthropic's), and the
// server sums the four buckets — so the adapter has to convert, or every
// cached token is counted twice.

import { test } from "node:test"
import assert from "node:assert/strict"

import {
  codex, additiveUsage, effortFor, resumeThreadId, streamingArgs, renderPrompt, CODEX_CONTEXT_WINDOW
} from "../src/runtimes/codex.js"
import { withoutCapabilityFlags } from "../src/engine.js"

const sumOf = (usage) =>
  usage.input_tokens + usage.output_tokens + usage.cache_creation_input_tokens + usage.cache_read_input_tokens

// ---------------------------------------------------------------------------
// Usage: inclusive wire → additive contract
// ---------------------------------------------------------------------------

test("codex: the parser fixture (input 100 = cached 40 + written 60) sums to Codex's own total", () => {
  // codex-rs/codex-api/src/sse/responses.rs: input_tokens 100 with
  // cached_tokens 40 and cache_write_tokens 60 inside it, output 10 with
  // reasoning 5 inside it, total_tokens 110.
  const usage = additiveUsage({
    input_tokens: 100, cached_input_tokens: 40, cache_write_input_tokens: 60,
    output_tokens: 10, reasoning_output_tokens: 5
  })

  assert.equal(usage.input_tokens, 0, "nothing was fresh: every prompt token was read or written")
  assert.equal(usage.cache_read_input_tokens, 40)
  assert.equal(usage.cache_creation_input_tokens, 60)
  assert.equal(usage.output_tokens, 10)
  assert.equal(sumOf(usage), 110, "the server's sum must equal Codex's total_tokens")
  // Informational: already inside output_tokens, never added to it.
  assert.equal(usage.reasoning_tokens, 5)
})

test("codex: a real cached run is no longer counted twice", () => {
  // openai/codex#19022's capture. The server used to record
  // 24,763 + 122 + 24,448 = 49,333 tokens for this turn; Codex's own total is
  // 24,885, of which 98% was a cache read.
  const out = codex.collapseEvents([
    { type: "thread.started", thread_id: "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b" },
    { type: "turn.started" },
    { type: "item.completed", item: { id: "item_0", type: "agent_message", text: "Done." } },
    { type: "turn.completed", usage: { input_tokens: 24_763, cached_input_tokens: 24_448,
                                       cache_write_input_tokens: 0, output_tokens: 122,
                                       reasoning_output_tokens: 41 } }
  ])

  assert.equal(out.usage.input_tokens, 315)
  assert.equal(out.usage.cache_read_input_tokens, 24_448)
  assert.equal(out.usage.cache_creation_input_tokens, 0)
  assert.equal(out.usage.output_tokens, 122)
  assert.equal(sumOf(out.usage), 24_885, "tokens_used equals input + output as Codex counts them")
  assert.equal(out.usage.reasoning_tokens, 41)
  assert.equal(out.usage.context_tokens, 0, "the cumulative object is not an occupancy")
})

test("codex: a build older than the reasoning and cache-write fields reports neither as zero", () => {
  // The 0.114.0 capture: three fields only. Absent means unknown — the
  // contract never invents a 0 reasoning count.
  const usage = additiveUsage({ input_tokens: 8_497, cached_input_tokens: 8_448, output_tokens: 51 })

  assert.equal(usage.input_tokens, 49)
  assert.equal(usage.cache_read_input_tokens, 8_448)
  assert.equal(usage.cache_creation_input_tokens, 0)
  assert.equal(usage.output_tokens, 51)
  assert.ok(!("reasoning_tokens" in usage))
})

test("codex: a malformed usage clamps instead of going negative", () => {
  const usage = additiveUsage({ input_tokens: 10, cached_input_tokens: 20, output_tokens: -3 })
  assert.equal(usage.input_tokens, 0)
  assert.equal(usage.cache_read_input_tokens, 20)
  assert.equal(usage.output_tokens, 0)
  assert.deepEqual(additiveUsage(null).input_tokens, 0)
})

// ---------------------------------------------------------------------------
// The additive contract keys: thread id, model label, window
// ---------------------------------------------------------------------------

test("codex: the thread id and Codex's enforced window ride the result", () => {
  const out = codex.collapseEvents([
    { type: "thread.started", thread_id: "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b" },
    { type: "item.completed", item: { type: "agent_message", text: "ok" } },
    { type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 1 } }
  ])

  assert.equal(out.usage.runtime_session_id, "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b")
  assert.equal(out.usage.context_window, CODEX_CONTEXT_WINDOW)
  assert.equal(CODEX_CONTEXT_WINDOW, 272_000, "models.json context_window for every bundled slug")
  assert.ok(!("model_label" in out.usage), "no event names the model, so none is claimed")
})

test("codex: a window a build states on the wire wins over the constant", () => {
  const out = codex.collapseEvents([
    { type: "item.completed", item: { type: "agent_message", text: "ok" } },
    { type: "turn.completed", usage: { input_tokens: 10, output_tokens: 1 }, model_context_window: 872_000 }
  ])
  assert.equal(out.usage.context_window, 872_000)
})

test("codex: a failed turn carries no window and no completed usage", () => {
  const out = codex.collapseEvents([
    { type: "thread.started", thread_id: "t1" },
    { type: "turn.failed", error: { message: "usage limit reached" } }
  ])
  assert.equal(out.isError, true)
  assert.ok(!("context_window" in out.usage))
  assert.equal(out.usage.runtime_session_id, "t1", "the thread exists even though the turn failed")
})

// ---------------------------------------------------------------------------
// Notices are warnings, not failures
// ---------------------------------------------------------------------------

test("codex: a deprecation notice does not fail a turn that completed", () => {
  // event_processor_with_jsonl_output.rs emits DeprecationNotice, Warning,
  // ConfigWarning and ModelRerouted as item.completed {type: "error"} while
  // the turn keeps running.
  const out = codex.collapseEvents([
    { type: "thread.started", thread_id: "t1" },
    { type: "item.completed", item: { id: "item_0", type: "error",
      message: "GPT-5.4 is no longer available for ChatGPT sign-in. Use gpt-5.6-terra instead." } },
    { type: "item.completed", item: { id: "item_1", type: "agent_message", text: "The answer." } },
    { type: "turn.completed", usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 10 } }
  ])

  assert.equal(out.isError, false)
  assert.equal(out.content, "The answer.")
  assert.ok(out.sawResult)
  assert.deepEqual(out.warnings, ["GPT-5.4 is no longer available for ChatGPT sign-in. Use gpt-5.6-terra instead."])
})

test("codex: a reroute notice names the model that actually answered", () => {
  const notice = "model rerouted: gpt-5.4 -> gpt-5.6-terra (Deprecated)"
  const out = codex.collapseEvents([
    { type: "item.completed", item: { type: "error", message: notice } },
    { type: "item.completed", item: { type: "agent_message", text: "hi" } },
    { type: "turn.completed", usage: { input_tokens: 5, output_tokens: 1 } }
  ])

  assert.equal(out.model, "gpt-5.6-terra")
  assert.equal(out.usage.model_label, "gpt-5.6-terra")
  assert.equal(out.isError, false)
  // And the ticker tells the user, since nothing else will.
  assert.equal(codex.describeEvent({ type: "item.completed", item: { type: "error", message: notice } }),
    `Codex: ${notice}`)
})

test("codex: a notice IS the failure when the turn never closed or closed empty", () => {
  const stalled = codex.collapseEvents([
    { type: "thread.started", thread_id: "t1" },
    { type: "item.completed", item: { type: "error", message: "stream disconnected before completion" } }
  ])
  assert.equal(stalled.isError, true)
  assert.match(stalled.errorStatus, /stream disconnected/)

  const empty = codex.collapseEvents([
    { type: "item.completed", item: { type: "error", message: "model unavailable on this plan" } },
    { type: "turn.completed", usage: { input_tokens: 5, output_tokens: 0 } }
  ])
  assert.equal(empty.isError, true)
  assert.match(empty.errorStatus, /unavailable on this plan/)

  // turn.failed and the top-level error event still end a run outright.
  const failed = codex.collapseEvents([
    { type: "item.completed", item: { type: "agent_message", text: "partial" } },
    { type: "error", message: "usage_limit_reached" }
  ])
  assert.equal(failed.isError, true)
  assert.match(failed.errorStatus, /usage_limit_reached/)
})

test("codex: warnings are bounded", () => {
  const events = Array.from({ length: 25 }, (_, i) =>
    ({ type: "item.completed", item: { type: "error", message: `notice ${i}` } }))
  events.push({ type: "item.completed", item: { type: "agent_message", text: "ok" } })
  events.push({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } })

  const out = codex.collapseEvents(events)
  assert.equal(out.warnings.length, 10)
  assert.equal(out.isError, false)
})

// ---------------------------------------------------------------------------
// The effort dial → -c model_reasoning_effort
// ---------------------------------------------------------------------------

test("codex: the effort dial reaches the CLI as one config override, verbatim", () => {
  const args = streamingArgs({ model: "gpt-5.6-sol", effort: "high" })
  const at = args.indexOf("model_reasoning_effort=high")
  assert.ok(at > 0)
  assert.equal(args[at - 1], "-c")
  assert.equal(args.at(-1), "-", "the stdin marker stays last")

  for (const level of ["low", "medium", "high", "xhigh", "max"]) {
    assert.equal(effortFor({ model: "gpt-5.6-sol", effort: level }), level)
  }
})

test("codex: an untouched or unknown dial adds nothing", () => {
  assert.equal(effortFor({ model: "gpt-5.6-sol" }), null)
  assert.equal(effortFor({ model: "gpt-5.6-sol", effort: "" }), null)
  assert.equal(effortFor({ model: "gpt-5.6-sol", effort: "turbo" }), null)
  assert.ok(!streamingArgs({ model: "gpt-5.6-sol" }).some((a) => a.startsWith("model_reasoning_effort")))
  assert.ok(!streamingArgs({ model: "gpt-5.6-sol", effort: "turbo" }).some((a) => a.startsWith("model_reasoning_effort")))
})

test("codex: max clamps to xhigh on the models whose ceiling is xhigh, and only those", () => {
  // models.json supported_reasoning_levels: 5.6 line and GPT-6 reach max;
  // gpt-5.5 / gpt-5.4 / gpt-5.3-codex / gpt-5 family stop at xhigh.
  for (const model of ["gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex", "gpt-5", "gpt-5-mini"]) {
    assert.equal(effortFor({ model, effort: "max" }), "xhigh", model)
    assert.equal(effortFor({ model, effort: "xhigh" }), "xhigh", model)
  }
  for (const model of ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-6-astra", "gpt-7-something", ""]) {
    assert.equal(effortFor({ model, effort: "max" }), "max", model || "(no model)")
  }
})

test("codex: the effort override survives the degraded retry", () => {
  const stripped = withoutCapabilityFlags(streamingArgs({ model: "gpt-5.6-sol", workdir: "/repo", effort: "low" }))
  assert.ok(stripped.includes("model_reasoning_effort=low"))
  assert.ok(!stripped.includes("--full-auto"))
  assert.equal(stripped.at(-1), "-")
})

// ---------------------------------------------------------------------------
// Thread continuity: exec resume <thread_id> -
// ---------------------------------------------------------------------------

test("codex: a runtime_session_id resumes the thread, options before the subcommand", () => {
  const job = { model: "gpt-5.6-sol", workdir: "/repo", effort: "medium",
                runtime_session_id: "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b" }
  const args = streamingArgs(job)

  const resume = args.indexOf("resume")
  assert.ok(resume > args.indexOf("--json"), "`codex exec [OPTIONS] resume …`: options first")
  assert.ok(resume > args.indexOf("-c"))
  assert.equal(args[resume + 1], "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b")
  assert.equal(args[resume + 2], "-", "the resume prompt is `-`: read from stdin")
  assert.equal(args.at(-1), "-")
  assert.ok(!args.includes("--ephemeral"), "an ephemeral thread could never be resumed")
  assert.ok(!args.includes("--last"))
})

test("codex: without a thread id the invocation is unchanged", () => {
  const args = streamingArgs({ model: "gpt-5.6-sol" })
  assert.ok(!args.includes("resume"))
  assert.deepEqual(args.slice(0, 2), ["exec", "--json"])
  assert.equal(resumeThreadId({}), null)
  assert.equal(resumeThreadId({ runtime_session_id: null }), null)
})

test("codex: only a safe token is accepted as a thread id", () => {
  assert.equal(resumeThreadId({ runtime_session_id: "  0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b " }),
    "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b")
  assert.equal(resumeThreadId({ runtimeSessionId: "my-thread" }), "my-thread")
  // Anything clap could read as a flag or a second argument is dropped.
  assert.equal(resumeThreadId({ runtime_session_id: "--last" }), null)
  assert.equal(resumeThreadId({ runtime_session_id: "a b" }), null)
  assert.equal(resumeThreadId({ runtime_session_id: "x".repeat(200) }), null)
})

test("codex: a resumed thread gets only the newest user message", () => {
  const messages = [
    { role: "user", content: "first question" },
    { role: "assistant", content: "first answer" },
    { role: "user", content: "follow-up, with the clock band hoisted here" }
  ]
  const conversation = "User: first question\n\nAssistant: first answer\n\nUser: follow-up…\n\nAssistant:"

  const resumed = renderPrompt({ system: "operator instructions", messages,
                                 runtime_session_id: "t1" }, conversation)
  assert.equal(resumed, "follow-up, with the clock band hoisted here")
  assert.ok(!resumed.includes("<system>"), "the thread already holds the system block")

  // A fresh thread renders exactly as before.
  const fresh = renderPrompt({ system: "operator instructions", messages }, conversation)
  assert.equal(fresh, `<system>\noperator instructions\n</system>\n\n${conversation}`)

  // No user message to send → the full render, never an empty prompt.
  assert.equal(renderPrompt({ system: "s", messages: [], runtime_session_id: "t1" }, conversation),
    `<system>\ns\n</system>\n\n${conversation}`)
})

test("codex: structured message content is serialised on a resume, like the engine does", () => {
  const messages = [{ role: "user", content: [{ type: "text", text: "hi" }] }]
  assert.equal(renderPrompt({ messages, runtime_session_id: "t1" }, "ignored"),
    JSON.stringify([{ type: "text", text: "hi" }]))
})
