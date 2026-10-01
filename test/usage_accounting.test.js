// The cache-token split, checked against every local runtime's real output
// shape — the local half of the server's agent_driver_cache_accounting_test.
//
// The session meter's "measured here: N% cached re-reads" line is fed by
// whatever each adapter's collapseEvents reports as
// usage.cache_read_input_tokens. A runtime whose adapter drops the figure
// doesn't error — the meter just stays silent and the user's cheapest
// tokens look unmeasured. Gemini was exactly that: tokensFrom read only the
// API's `cachedContentTokenCount` spelling while accepting shapes whose
// spelling is `cached`, and skipped the current CLI's per-model nesting
// entirely. The fixtures here are the CLI's real `result.stats` shapes
// (StreamStats from `--output-format stream-json`, the raw SessionMetrics
// from `--output-format json`), whose prompt count is INCLUSIVE of the cached
// share — what reaches the server is the additive split. The full Gemini CLI
// contract is exercised in runtime_gemini_cli.test.js.
//
// Run with: node --test "agent/test/*.test.js"

import { test } from "node:test"
import assert from "node:assert/strict"

import { antigravity } from "../src/runtimes/antigravity.js"
import { claudeCode } from "../src/runtimes/claude-code.js"
import { codewhale } from "../src/runtimes/codewhale.js"
import { codex } from "../src/runtimes/codex.js"
import { cursor } from "../src/runtimes/cursor.js"
import { gemini } from "../src/runtimes/gemini.js"
import { ollama } from "../src/runtimes/ollama.js"

test("claude_code: the result event's cache traffic reaches the run totals", () => {
  const out = claudeCode.collapseEvents([
    {
      type: "result", result: "done", stop_reason: "end_turn",
      usage: {
        input_tokens: 1_000, output_tokens: 50,
        cache_creation_input_tokens: 400, cache_read_input_tokens: 9_000
      },
      modelUsage: { "claude-opus-5": {} }
    }
  ])

  assert.equal(out.usage.cache_read_input_tokens, 9_000)
  assert.equal(out.usage.cache_creation_input_tokens, 400)
})

test("cursor: the SDK's camelCase, additive usage reaches the run totals", () => {
  // The literal `result` usage a cursor-agent build (2026.05.04) printed for
  // `echo "what is 1+1" | cursor-agent --print --output-format stream-json`.
  // The 10,624 cached tokens are Cursor's own system prompt, rules and tool
  // schemas, read against 1,227 fresh ones — so inputTokens cannot contain
  // them: the shape is additive, like Anthropic's, not inclusive like
  // OpenAI's. The shared normalizer knows neither name; the adapter maps them.
  const out = cursor.collapseEvents([
    {
      type: "result", subtype: "success", is_error: false, result: "2",
      usage: { inputTokens: 1227, outputTokens: 13, cacheReadTokens: 10624, cacheWriteTokens: 0 }
    }
  ])

  assert.equal(out.usage.input_tokens, 1227)
  assert.equal(out.usage.output_tokens, 13)
  assert.equal(out.usage.cache_read_input_tokens, 10624)
  assert.equal(out.usage.cache_creation_input_tokens, 0)
})

test("codex: turn.completed's cached_input_tokens is recognised, and taken OUT of input", () => {
  // Codex's input_tokens is the gross prompt with cached_input_tokens inside
  // it (a fixture with cached > input is not a shape the CLI can emit). The
  // shared accounting is additive, so the adapter subtracts before reporting.
  const out = codex.collapseEvents([
    { type: "item.completed", item: { item_type: "agent_message", text: "done" } },
    {
      type: "turn.completed",
      usage: { input_tokens: 9_200, cached_input_tokens: 8_200, output_tokens: 60 }
    }
  ])

  assert.equal(out.usage.cache_read_input_tokens, 8_200)
  assert.equal(out.usage.input_tokens, 1_000)
})

test("codewhale: per-turn prompt_cache_hit_tokens sum across the run, from INSIDE input_tokens", () => {
  // CodeWhale's counts follow DeepSeek's: `input_tokens` is the whole prompt
  // and the hits are part of it (its own shape lock: prompt_tokens 20 = hit
  // 12 + miss 8 → input_tokens 20). A hit count larger than the input is not
  // a shape this runtime can emit; the fresh input is what the hits leave.
  const out = codewhale.collapseEvents([
    { type: "turn_usage", input_tokens: 4_500, output_tokens: 20, prompt_cache_hit_tokens: 4_000 },
    { type: "turn_usage", input_tokens: 5_300, output_tokens: 10, prompt_cache_hit_tokens: 5_000 },
    { type: "done" }
  ])

  assert.equal(out.usage.cache_read_input_tokens, 9_000)
  assert.equal(out.usage.input_tokens, 800, "fresh input is 500 + 300, not the two whole prompts")
})

test("gemini: stream-json's StreamStats — `cached` is inside `input_tokens`, so input is sent net of it", () => {
  // `result.stats` as stream-json-formatter.ts prints it: input_tokens is the
  // summed promptTokenCount (inclusive of cached), `input` the CLI's own
  // non-cached figure, output_tokens the visible answer only.
  const out = gemini.collapseEvents([
    {
      type: "result", timestamp: "2026-09-14T00:00:02.000Z", status: "success",
      stats: {
        total_tokens: 10_050, input_tokens: 10_000, output_tokens: 50, cached: 9_000, input: 1_000,
        duration_ms: 1_800, tool_calls: 0,
        models: { "gemini-3.5-flash": { total_tokens: 10_050, input_tokens: 10_000, output_tokens: 50, cached: 9_000, input: 1_000 } }
      }
    }
  ])

  assert.equal(out.usage.cache_read_input_tokens, 9_000)
  assert.equal(out.usage.input_tokens, 1_000, "the inclusive count would be added to the cached share again server-side")
  assert.equal(out.usage.output_tokens, 50)
})

test("gemini: the raw SessionMetrics nesting is summed across models, net of cache", () => {
  // `--output-format json` prints stats as the raw SessionMetrics: per model,
  // tokens {prompt, candidates, total, cached, thoughts, tool, input}.
  const out = gemini.collapseEvents([
    {
      type: "result", status: "success",
      stats: {
        models: {
          "gemini-3.1-flash-lite": { api: { totalRequests: 1, totalErrors: 0, totalLatencyMs: 400 },
                                     tokens: { prompt: 2_000, candidates: 10, total: 2_010, cached: 1_500, thoughts: 0, tool: 0, input: 500 } },
          "gemini-3.1-pro-preview": { api: { totalRequests: 1, totalErrors: 0, totalLatencyMs: 2_100 },
                                      tokens: { prompt: 8_000, candidates: 40, total: 8_040, cached: 6_500, thoughts: 0, tool: 0, input: 1_500 } }
        }
      }
    }
  ])

  assert.equal(out.usage.input_tokens, 2_000)
  assert.equal(out.usage.output_tokens, 50)
  assert.equal(out.usage.cache_read_input_tokens, 8_000)
})

test("gemini: the API's cachedContentTokenCount spelling still works", () => {
  const out = gemini.collapseEvents([
    {
      type: "result", status: "success",
      stats: { promptTokenCount: 5_000, candidatesTokenCount: 30, cachedContentTokenCount: 4_200 }
    }
  ])

  assert.equal(out.usage.cache_read_input_tokens, 4_200)
  assert.equal(out.usage.input_tokens, 800, "promptTokenCount includes the cached share")
})

test("antigravity: cache_read_tokens is additive to input_tokens, as agy reports it", () => {
  // kivio's capture on agy 1.1.26: in=5969 out=554 cache=8132 total=6523 —
  // total = input + output, the cache count sits outside input_tokens (and
  // exceeds it on a warm prompt). Anthropic's convention, so nothing is
  // subtracted on the way to the canonical shape.
  const usage = { input_tokens: 5_969, output_tokens: 554, cache_read_tokens: 8_132, total_tokens: 6_523 }
  const out = antigravity.collapseEvents([
    { event: "step_update", step_update: { step_index: 1, state: "DONE", step_type: "agent_response", text_delta: "ok", usage } },
    { event: "result", result: { status: "SUCCESS", response: "ok", error: "", num_turns: 1, usage } }
  ])

  assert.equal(out.usage.input_tokens, 5_969)
  assert.equal(out.usage.cache_read_input_tokens, 8_132)
  assert.equal(out.usage.output_tokens, 554)
  assert.equal(out.usage.context_tokens, 5_969 + 8_132)
})

test("ollama: zero cached when the server does not say, the split when it does", () => {
  // `prompt_eval_count` is the WHOLE prompt on every Ollama since 0.3. A server
  // older than 0.33.3 reports no cached count at all — that is "unknown",
  // recorded as zero rather than guessed at — and the prompt is all input.
  const silent = ollama.collapseEvents([
    { message: { role: "assistant", content: "done" }, prompt_eval_count: 900, eval_count: 40, done: true }
  ])

  assert.equal(silent.usage.cache_read_input_tokens, 0)
  assert.equal(silent.usage.input_tokens, 900)

  // A current server adds `prompt_eval_cached_count`, an INCLUSIVE subset of
  // the prompt count (the OpenAI convention), which the adapter converts to
  // the additive shape: the cached share comes OUT of input, so the two
  // still sum to the prompt rather than to the prompt plus its cached part.
  const reported = ollama.collapseEvents([
    { message: { role: "assistant", content: "done" }, done: true,
      prompt_eval_count: 900, prompt_eval_cached_count: 850, eval_count: 40 }
  ])

  assert.equal(reported.usage.cache_read_input_tokens, 850)
  assert.equal(reported.usage.input_tokens, 50)
  assert.equal(reported.usage.context_tokens, 900)
})
