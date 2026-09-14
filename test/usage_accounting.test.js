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
// entirely.
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

test("cursor: same stream contract, same accounting", () => {
  const out = cursor.collapseEvents([
    {
      type: "result", result: "done",
      usage: { input_tokens: 1_000, output_tokens: 50, cache_read_input_tokens: 7_500 }
    }
  ])

  assert.equal(out.usage.cache_read_input_tokens, 7_500)
})

test("codex: turn.completed's cached_input_tokens is recognised", () => {
  const out = codex.collapseEvents([
    { type: "item.completed", item: { item_type: "agent_message", text: "done" } },
    {
      type: "turn.completed",
      usage: { input_tokens: 1_000, cached_input_tokens: 8_200, output_tokens: 60 }
    }
  ])

  assert.equal(out.usage.cache_read_input_tokens, 8_200)
})

test("codewhale: per-turn prompt_cache_hit_tokens sum across the run", () => {
  const out = codewhale.collapseEvents([
    { type: "turn_usage", input_tokens: 500, output_tokens: 20, prompt_cache_hit_tokens: 4_000 },
    { type: "turn_usage", input_tokens: 300, output_tokens: 10, prompt_cache_hit_tokens: 5_000 },
    { type: "done" }
  ])

  assert.equal(out.usage.cache_read_input_tokens, 9_000)
})

test("gemini: the CLI's own `cached` spelling on a flat stats.tokens shape", () => {
  const out = gemini.collapseEvents([
    {
      type: "result", status: "success",
      stats: { tokens: { prompt: 10_000, candidates: 50, cached: 9_000 } }
    }
  ])

  assert.equal(out.usage.cache_read_input_tokens, 9_000)
  assert.equal(out.usage.input_tokens, 10_000)
})

test("gemini: the current per-model nesting is summed across models", () => {
  const out = gemini.collapseEvents([
    {
      type: "result", status: "success",
      stats: {
        models: {
          "gemini-2.5-flash": { tokens: { prompt: 2_000, candidates: 10, cached: 1_500 } },
          "gemini-3.1-pro": { tokens: { prompt: 8_000, candidates: 40, cached: 6_500 } }
        }
      }
    }
  ])

  assert.equal(out.usage.input_tokens, 10_000)
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
})

test("antigravity: cacheRead spellings on the result event are recognised", () => {
  const out = antigravity.collapseEvents([
    {
      type: "result", status: "success",
      usage: { input_tokens: 1_000, output_tokens: 40, cacheRead: 6_000 }
    }
  ])

  assert.equal(out.usage.cache_read_input_tokens, 6_000)
})

test("ollama: no cache reporting exists, so the figure is an honest zero", () => {
  const out = ollama.collapseEvents([
    { message: { role: "assistant", content: "done" }, prompt_eval_count: 900, eval_count: 40, done: true }
  ])

  assert.equal(out.usage.cache_read_input_tokens, 0)
  assert.equal(out.usage.input_tokens, 900)
})
