// Gemini CLI's usage contract, checked against the CLI's own wire shapes.
//
// Every fixture here is a `gemini --output-format stream-json` event (or the
// `--output-format json` stats object) as the CLI's source prints it at
// 0.61.0-nightly.20260908 — packages/core/src/output/types.ts,
// stream-json-formatter.ts and telemetry/uiTelemetry.ts. The numbers matter
// because of what they are NOT: `input_tokens` is Google's promptTokenCount,
// which INCLUDES the cached share; `output_tokens` is candidatesTokenCount,
// which EXCLUDES thinking; `total_tokens` is the only place thinking shows up
// in stream-json. The server's usage hash is additive (input excludes cache
// reads; thinking is billed as output), so the adapter converts.
//
// Run with: node --test "agent/test/*.test.js"

import { test } from "node:test"
import assert from "node:assert/strict"

import { contextWindowFor, gemini, resumeIdOf, streamingArgs } from "../src/runtimes/gemini.js"

const SESSION = "3f2b9c1e-7d4a-4b6e-9a1c-5e8f2d3c4b6a"

// A two-request agentic run on one model. Request 1: prompt 40,000 (nothing
// cached), answer 20, thoughts 300 → total 40,320. Request 2: prompt 42,000
// of which 39,500 cached, answer 60, thoughts 1,100 → total 43,160. The CLI
// sums the requests and never prints the thoughts.
const STREAM_RUN = [
  { type: "init", timestamp: "2026-09-14T00:00:00.000Z", session_id: SESSION, model: "gemini-3.1-pro-preview" },
  { type: "message", timestamp: "2026-09-14T00:00:00.001Z", role: "user", content: "Tighten the validation in app/models/user.rb" },
  { type: "message", timestamp: "2026-09-14T00:00:03.000Z", role: "assistant", content: "Reading the model first.", delta: true },
  { type: "tool_use", timestamp: "2026-09-14T00:00:03.100Z", tool_name: "read_file", tool_id: "read_file-1757808003100",
    parameters: { file_path: "app/models/user.rb" } },
  { type: "tool_result", timestamp: "2026-09-14T00:00:03.200Z", tool_id: "read_file-1757808003100", status: "success",
    output: "class User < ApplicationRecord\nend\n" },
  { type: "message", timestamp: "2026-09-14T00:00:07.000Z", role: "assistant", content: " Added the validation.", delta: true },
  { type: "result", timestamp: "2026-09-14T00:00:07.500Z", status: "success",
    stats: {
      total_tokens: 83_480, input_tokens: 82_000, output_tokens: 80, cached: 39_500, input: 42_500,
      duration_ms: 7_400, tool_calls: 1,
      models: {
        "gemini-3.1-pro-preview": { total_tokens: 83_480, input_tokens: 82_000, output_tokens: 80, cached: 39_500, input: 42_500 }
      }
    } }
]

test("stream-json: the cached share leaves input, thinking joins output, and nothing is lost", () => {
  const out = gemini.collapseEvents(STREAM_RUN)

  assert.equal(out.content, "Reading the model first. Added the validation.")
  assert.equal(out.usage.input_tokens, 42_500, "the CLI's own non-cached `input`, not the inclusive prompt count")
  assert.equal(out.usage.cache_read_input_tokens, 39_500)
  assert.equal(out.usage.cache_creation_input_tokens, 0, "Gemini reports no cache writes")
  assert.equal(out.usage.output_tokens, 1_480, "candidates 80 + the 1,400 thoughts Google bills as output")
  assert.equal(out.usage.reasoning_tokens, 1_400, "recovered from total − prompt − candidates")
  // What the server adds up equals the CLI's own total: nothing double-counted, nothing dropped.
  const { input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens } = out.usage
  assert.equal(input_tokens + output_tokens + cache_read_input_tokens + cache_creation_input_tokens, 83_480)
  assert.equal(out.usage.context_tokens, 0, "session sums are not a window reading")
  assert.equal(out.isError, false)
  assert.ok(out.sawResult)
})

test("stream-json: the run's session id, served model and window ride the usage hash", () => {
  const out = gemini.collapseEvents(STREAM_RUN)

  assert.equal(out.usage.runtime_session_id, SESSION)
  assert.equal(out.usage.model_label, "gemini-3.1-pro-preview")
  assert.equal(out.usage.context_window, 1_048_576, "the CLI's own tokenLimit for every Gemini id")
  assert.equal(out.model, "gemini-3.1-pro-preview")
  assert.ok(!("num_turns" in out.usage), "stream-json has no request count (tool_calls is not one)")
  assert.ok(!("total_cost_usd" in out.usage), "the CLI prints no cost")
})

test("stream-json: `auto` routing serves several models — sums across them, label from the one that answered", () => {
  // A flash-lite classifier call beside the answer's model. The top-level
  // totals are the CLI's sums of the per-model entries.
  const out = gemini.collapseEvents([
    { type: "init", session_id: SESSION, model: "auto" },
    { type: "message", role: "assistant", content: "ok", delta: true },
    { type: "result", status: "success",
      stats: {
        total_tokens: 14_110, input_tokens: 13_200, output_tokens: 410, cached: 8_000, input: 5_200,
        duration_ms: 3_000, tool_calls: 0,
        models: {
          "gemini-3.1-flash-lite": { total_tokens: 1_210, input_tokens: 1_200, output_tokens: 10, cached: 0, input: 1_200 },
          "gemini-3.5-flash": { total_tokens: 12_900, input_tokens: 12_000, output_tokens: 400, cached: 8_000, input: 4_000 }
        }
      } }
  ])

  assert.equal(out.usage.input_tokens, 5_200)
  assert.equal(out.usage.cache_read_input_tokens, 8_000)
  assert.equal(out.usage.output_tokens, 910, "400 + 10 answers, plus the 500 thoughts of the flash call")
  assert.equal(out.usage.reasoning_tokens, 500)
  assert.equal(out.usage.model_label, "gemini-3.5-flash", "not the `auto` alias the init event announced")
})

test("stream-json: an older build without total_tokens leaves thinking unknown rather than zero", () => {
  const out = gemini.collapseEvents([
    { type: "init", session_id: SESSION, model: "gemini-2.5-pro" },
    { type: "result", status: "success",
      stats: { input_tokens: 5_000, output_tokens: 70, cached: 1_000, input: 4_000, duration_ms: 900, tool_calls: 0 } }
  ])

  assert.equal(out.usage.input_tokens, 4_000)
  assert.equal(out.usage.output_tokens, 70)
  assert.ok(!("reasoning_tokens" in out.usage), "absent means unknown, never 0")
  assert.equal(out.usage.model_label, "gemini-2.5-pro", "no per-model entry, so the init model is the label")
})

test("stream-json: a failed run still hands over the tokens it spent", () => {
  // utils/errors.ts prints the stats on the error-status result too.
  const out = gemini.collapseEvents([
    { type: "init", session_id: SESSION, model: "gemini-3.1-pro-preview" },
    { type: "result", status: "error", error: { type: "ApiError", message: "429 RESOURCE_EXHAUSTED" },
      stats: { total_tokens: 20_100, input_tokens: 20_000, output_tokens: 0, cached: 15_000, input: 5_000,
               duration_ms: 400, tool_calls: 0,
               models: { "gemini-3.1-pro-preview": { total_tokens: 20_100, input_tokens: 20_000, output_tokens: 0, cached: 15_000, input: 5_000 } } } }
  ])

  assert.equal(out.isError, true)
  assert.equal(out.errorStatus, "429 RESOURCE_EXHAUSTED")
  assert.equal(out.usage.input_tokens, 5_000)
  assert.equal(out.usage.cache_read_input_tokens, 15_000)
  assert.equal(out.usage.output_tokens, 100, "the thoughts spent before the error are still output")
})

test("json output: the raw SessionMetrics names thoughts, tool prompt tokens and the request count", () => {
  // `--output-format json` prints stats as SessionMetrics: models[m].tokens
  // is {prompt, candidates, total, cached, thoughts, tool, input} and
  // models[m].api.totalRequests counts API calls.
  const out = gemini.collapseEvents([
    { type: "init", session_id: SESSION, model: "gemini-2.5-flash" },
    { type: "result", status: "success",
      stats: {
        models: {
          "gemini-2.5-flash": {
            api: { totalRequests: 2, totalErrors: 0, totalLatencyMs: 2_450 },
            tokens: { prompt: 3_000, candidates: 40, total: 3_180, cached: 1_000, thoughts: 120, tool: 20, input: 2_000 }
          }
        },
        tools: { totalCalls: 1, totalSuccess: 1, totalFail: 0, totalDurationMs: 30, totalDecisions: { accept: 0, reject: 0, modify: 0, auto_accept: 1 }, byName: {} },
        files: { totalLinesAdded: 0, totalLinesRemoved: 0 }
      } }
  ])

  assert.equal(out.usage.input_tokens, 2_020, "non-cached prompt plus the tool-use prompt tokens Google counts outside the prompt")
  assert.equal(out.usage.cache_read_input_tokens, 1_000)
  assert.equal(out.usage.output_tokens, 160, "candidates + the explicit thoughts")
  assert.equal(out.usage.reasoning_tokens, 120)
  assert.equal(out.usage.num_turns, 2)
  assert.equal(out.usage.model_label, "gemini-2.5-flash")
})

test("json output: an explicit zero thoughts count is believed", () => {
  const out = gemini.collapseEvents([
    { type: "result", status: "success",
      stats: { models: { "gemini-2.5-flash": { api: { totalRequests: 1 },
        tokens: { prompt: 1_000, candidates: 30, total: 1_030, cached: 0, thoughts: 0, tool: 0, input: 1_000 } } } } }
  ])

  assert.equal(out.usage.output_tokens, 30)
  assert.equal(out.usage.reasoning_tokens, 0)
})

test("nothing is invented: no init and no served model means no label, window or session id", () => {
  const out = gemini.collapseEvents([
    { type: "message", role: "assistant", content: "hi", delta: true },
    { type: "result", status: "success", stats: { total_tokens: 12, input_tokens: 8, output_tokens: 4, cached: 0, input: 8, duration_ms: 100, tool_calls: 0 } }
  ])

  assert.equal(out.usage.input_tokens, 8)
  for (const key of ["model_label", "context_window", "runtime_session_id", "num_turns"]) {
    assert.ok(!(key in out.usage), `${key} must be absent, not empty`)
  }
})

test("an unrecognised stats shape yields the empty usage, and a missing result still yields the text", () => {
  const odd = gemini.collapseEvents([{ type: "result", status: "success", stats: { duration_ms: 5, tool_calls: 0 } }])
  assert.equal(odd.usage.input_tokens, 0)
  assert.equal(odd.usage.output_tokens, 0)

  const cut = gemini.collapseEvents([{ type: "init", session_id: SESSION, model: "gemini-3.5-flash" },
                                     { type: "message", role: "assistant", content: "partial", delta: true }])
  assert.equal(cut.content, "partial")
  assert.equal(cut.sawResult, false)
  assert.equal(cut.usage.input_tokens, 0)
})

// ---------------------------------------------------------------------------
// Continuity: `--resume <uuid>` from the id a previous run reported.
// ---------------------------------------------------------------------------

test("a previous run's session id becomes --resume", () => {
  const args = streamingArgs({ model: "gemini-3.1-pro-preview", runtime_session_id: SESSION }, "next step")
  const at = args.indexOf("--resume")
  assert.ok(at > -1)
  assert.equal(args[at + 1], SESSION)
  assert.equal(args[0], "--prompt", "the prompt stays the first argument")
  assert.equal(args[1], "next step")
})

test("no session id, no --resume — and the camelCase spelling is read too", () => {
  assert.ok(!streamingArgs({ model: "gemini-3.5-flash" }, "hi").includes("--resume"))
  assert.ok(!streamingArgs({ runtime_session_id: null }, "hi").includes("--resume"))
  assert.equal(resumeIdOf({ runtimeSessionId: SESSION }), SESSION)
})

test("only a uuid-shaped id is ever resumed — never `latest`, an index, or shell noise", () => {
  for (const bad of ["latest", "3", "0", " ", "", "../x", "a b", "id;rm -rf", "latest\n"]) {
    assert.equal(resumeIdOf({ runtime_session_id: bad }), "", JSON.stringify(bad))
    assert.ok(!streamingArgs({ runtime_session_id: bad }, "hi").includes("--resume"))
  }
  assert.equal(resumeIdOf({ runtime_session_id: ` ${SESSION} ` }), SESSION, "whitespace is trimmed, not rejected")
})

// ---------------------------------------------------------------------------
// The window the CLI itself compacts against (core/tokenLimits.ts).
// ---------------------------------------------------------------------------

test("the CLI's token limit table: 1,048,576 for Gemini ids, 256,000 for Gemma 4, nothing for no model", () => {
  assert.equal(contextWindowFor("gemini-3.1-pro-preview"), 1_048_576)
  assert.equal(contextWindowFor("gemini-2.5-flash"), 1_048_576)
  assert.equal(contextWindowFor("gemini-3.1-flash-lite"), 1_048_576)
  assert.equal(contextWindowFor("some-future-id"), 1_048_576, "the switch's default arm")
  assert.equal(contextWindowFor("gemma-4-31b-it"), 256_000)
  assert.equal(contextWindowFor("gemma-4-26b-a4b-it"), 256_000)
  assert.equal(contextWindowFor(""), null)
  assert.equal(contextWindowFor(null), null)
})
