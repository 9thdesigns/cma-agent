// The Claude Code adapter against Claude Code 2.1.270's REAL output.
//
// The fixtures here are the two live `claude -p` runs captured for the
// runtime audit (docs/internal/provider-wire-contracts.md):
//   run A — `--output-format json --model sonnet`: the buffered `result`
//           envelope, verbatim minus timing noise;
//   run B — `--output-format stream-json --verbose --include-partial-messages
//           --model haiku --effort low`: the events in the order they came.
// Field names and numbers are the CLI's own, so a test that goes red here is
// a contract change on the CLI's side or a regression on ours — never a
// fixture that assumed the Anthropic API's spelling.
//
// Run with: node --test "agent/test/*.test.js"

import { test } from "node:test"
import assert from "node:assert/strict"

import {
  accountingFrom, baseArgs, claudeCode, effortFor, fallbackJob, planUsageFrom, renderPrompt,
  resumePlan, streamingArgs
} from "../src/runtimes/claude-code.js"
import { withoutCapabilityFlags } from "../src/engine.js"

const SESSION = "98d1dfb0-e3e5-5e62-a388-fada5a450d92"

// Run A. Sonnet 5 on a subscription: 2,005 tokens written at the ONE-HOUR
// TTL (the subscription default for the main conversation), 3,289 read.
// costUSD = 2×$2 + 2,005×$4 + 3,289×$0.20 + 4×$10 per 1M = $0.0087218.
const RUN_A = {
  duration_api_ms: 1190, stop_reason: "end_turn", session_id: SESSION, total_cost_usd: 0.0087218,
  usage: {
    input_tokens: 2, cache_creation_input_tokens: 2005, cache_read_input_tokens: 3289, output_tokens: 4,
    output_tokens_details: { thinking_tokens: 0 },
    server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
    service_tier: "standard",
    cache_creation: { ephemeral_1h_input_tokens: 2005, ephemeral_5m_input_tokens: 0 },
    inference_geo: "not_available",
    iterations: [{ input_tokens: 2, output_tokens: 4, cache_read_input_tokens: 3289, cache_creation_input_tokens: 2005,
                   cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 2005 }, type: "message" }],
    speed: "standard"
  },
  modelUsage: {
    "claude-sonnet-5": {
      inputTokens: 2, outputTokens: 4, cacheReadInputTokens: 3289, cacheCreationInputTokens: 2005,
      webSearchRequests: 0, costUSD: 0.0087218, contextWindow: 1000000, maxOutputTokens: 64000,
      thinkingTokens: 0, canonicalModel: "claude-sonnet-5", provider: "firstParty", costBasis: "list"
    }
  },
  permission_denials: [], terminal_reason: "completed", is_error: false, num_turns: 1, subtype: "success",
  api_error_status: null, result: "ok", type: "result", duration_ms: 2092, uuid: "d5293564-f366-4cc1-a617-15d418f1a48d"
}

// Run B, the stream. `assistant` usage is what the API said at message_start
// — real prompt-side counts, PLACEHOLDER output (4; the real figure, 50, only
// arrives on message_delta and the result).
const RUN_B_USAGE = {
  input_tokens: 3812, cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
  cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
  output_tokens: 4, service_tier: "standard", inference_geo: "not_available"
}
const RUN_B = [
  { type: "autocompact_state", value: { enabled: true, effective_window: 180000, threshold: 144000, enforced: true, source: "auto" }, session_id: SESSION },
  { type: "system", subtype: "init", cwd: "/tmp", session_id: SESSION, tools: [], mcp_servers: [],
    model: "claude-haiku-4-5-20251001", permissionMode: "default", apiKeySource: "none", claude_code_version: "2.1.270" },
  { type: "system", subtype: "status", status: "requesting", session_id: SESSION },
  { type: "assistant", message: { model: "claude-haiku-4-5-20251001", id: "msg_011Cf29Am8fS74Qjj8bmSkdC", type: "message", role: "assistant",
    content: [{ type: "thinking", thinking: "", signature: "…" }], stop_reason: null, usage: RUN_B_USAGE },
    parent_tool_use_id: null, session_id: SESSION },
  { type: "stream_event", event: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "ok" } }, session_id: SESSION, parent_tool_use_id: null },
  { type: "assistant", message: { model: "claude-haiku-4-5-20251001", id: "msg_011Cf29Am8fS74Qjj8bmSkdC", type: "message", role: "assistant",
    content: [{ type: "text", text: "ok" }], stop_reason: null, usage: RUN_B_USAGE },
    parent_tool_use_id: null, session_id: SESSION },
  { type: "stream_event", event: { type: "message_delta", delta: { stop_reason: "end_turn" },
    usage: { input_tokens: 3812, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 50,
             output_tokens_details: { thinking_tokens: 44 } } }, session_id: SESSION, parent_tool_use_id: null },
  { type: "rate_limit_event",
    rate_limit_info: { status: "allowed", resetsAt: 1789340400, rateLimitType: "five_hour", overageStatus: "rejected",
                       overageDisabledReason: "out_of_credits", isUsingOverage: false,
                       unifiedWindows: { five_hour: { utilization: 0.46, resetsAt: 1789340400 },
                                         seven_day: { utilization: 0.09, resetsAt: 1789927200 } } },
    session_id: SESSION },
  { type: "system", subtype: "post_turn_summary", status_category: "completed", session_id: SESSION },
  { duration_api_ms: 914, stop_reason: "end_turn", session_id: SESSION, total_cost_usd: 0.004062,
    usage: { input_tokens: 3812, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 50,
             output_tokens_details: { thinking_tokens: 44 },
             cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 } },
    modelUsage: { "claude-haiku-4-5-20251001": {
      inputTokens: 3812, outputTokens: 50, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, webSearchRequests: 0,
      costUSD: 0.004062, contextWindow: 200000, maxOutputTokens: 32000, thinkingTokens: 44,
      canonicalModel: "claude-haiku-4-5", provider: "firstParty", costBasis: "list" } },
    permission_denials: [], terminal_reason: "completed", is_error: false, num_turns: 1, subtype: "success",
    api_error_status: null, result: "ok", type: "result", duration_ms: 1808 }
]

function valueOf(args, flag) {
  const index = args.indexOf(flag)
  return index >= 0 ? args[index + 1] : undefined
}

// ---------------------------------------------------------------------------
// The result envelope: run totals, the additive contract keys
// ---------------------------------------------------------------------------

test("run A: the buffered envelope carries the 1h write split, the cost, the window and the session", () => {
  const out = claudeCode.parseBuffered(JSON.stringify(RUN_A))

  assert.equal(out.content, "ok")
  assert.equal(out.isError, false)
  assert.equal(out.model, "claude-sonnet-5")
  // The four totals, additive as Anthropic reports them: input EXCLUDES the
  // 3,289 read and the 2,005 written.
  assert.equal(out.usage.input_tokens, 2)
  assert.equal(out.usage.output_tokens, 4)
  assert.equal(out.usage.cache_read_input_tokens, 3289)
  assert.equal(out.usage.cache_creation_input_tokens, 2005)
  // Every one of the 2,005 written tokens was written at the 1-hour TTL —
  // the 2x premium, not the 1.25x a naive estimate would price.
  assert.equal(out.usage.cache_write_1h_tokens, 2005)
  assert.equal(out.usage.reasoning_tokens, 0)
  assert.equal(out.usage.context_window, 1_000_000)
  assert.equal(out.usage.total_cost_usd, 0.0087218)
  assert.equal(out.usage.num_turns, 1)
  assert.equal(out.usage.runtime_session_id, SESSION)
  assert.equal(out.usage.model_label, "claude-sonnet-5")
  // Buffered has no per-turn events, so the occupancy stays "unknown".
  assert.equal(out.usage.context_tokens, 0)
  assert.equal(out.usage.plan_usage, undefined, "rate_limit_event is stream-json only")
})

test("run B: the stream reports thinking, the resolved model, the enforced window and the plan's own bars", () => {
  const out = claudeCode.collapseEvents(RUN_B)

  assert.equal(out.sawResult, true)
  assert.equal(out.content, "ok")
  assert.equal(out.usage.input_tokens, 3812)
  // The REAL output count from the result, not the message_start placeholder.
  assert.equal(out.usage.output_tokens, 50)
  // thinking_tokens sit INSIDE output_tokens; carried as the informational split.
  assert.equal(out.usage.reasoning_tokens, 44)
  assert.equal(out.usage.cache_write_1h_tokens, 0, "a present zero is a real zero")
  // Haiku's window is 200K even though the same subscription runs Sonnet 5 at 1M.
  assert.equal(out.usage.context_window, 200_000)
  assert.equal(out.usage.total_cost_usd, 0.004062)
  assert.equal(out.usage.num_turns, 1)
  assert.equal(out.usage.runtime_session_id, SESSION)
  // What the CLI ran is the dated build from system/init; the row model is
  // the family id the picker shows, so per-model usage does not split in two.
  assert.equal(out.usage.model_label, "claude-haiku-4-5-20251001")
  assert.equal(out.model, "claude-haiku-4-5")
  // Occupancy is still the last top-level assistant prompt.
  assert.equal(out.usage.context_tokens, 3812)
  assert.deepEqual(out.usage.plan_usage, {
    status: "allowed", rate_limit_type: "five_hour", overage_status: "rejected", is_using_overage: false,
    five_hour: { utilization: 0.46, resets_at: 1789340400 },
    seven_day: { utilization: 0.09, resets_at: 1789927200 }
  })
})

test("modelUsage is the whole pipeline; a compaction the main loop's usage never saw is counted", () => {
  // `usage` excludes compaction; modelUsage includes it. On a repository run
  // that auto-compacted, the difference is one full context re-read.
  const out = claudeCode.collapseEvents([
    { type: "result", subtype: "success", result: "done", is_error: false, session_id: SESSION, num_turns: 14,
      usage: { input_tokens: 1_000, output_tokens: 900, cache_read_input_tokens: 400_000, cache_creation_input_tokens: 9_000,
               cache_creation: { ephemeral_1h_input_tokens: 8_000, ephemeral_5m_input_tokens: 1_000 } },
      modelUsage: { "claude-opus-5": { inputTokens: 181_000, outputTokens: 2_400, cacheReadInputTokens: 400_000,
                                       cacheCreationInputTokens: 9_000, thinkingTokens: 1_200, costUSD: 1.5, contextWindow: 200_000,
                                       canonicalModel: "claude-opus-5" } } }
  ])

  assert.equal(out.usage.input_tokens, 181_000, "the compaction's re-read is spend too")
  assert.equal(out.usage.output_tokens, 2_400)
  assert.equal(out.usage.cache_write_1h_tokens, 8_000, "only the main loop's share was written at 1h")
  assert.equal(out.usage.reasoning_tokens, 1_200)
  assert.equal(out.usage.num_turns, 14)
  // A Max-plan Opus 5 session held at 200K (CLAUDE_CODE_DISABLE_1M_CONTEXT):
  // the meter must divide by what the CLI enforced, not by the API's 1M.
  assert.equal(out.usage.context_window, 200_000)
})

test("with several models the window and label follow the one that did the work", () => {
  const { usage, model } = accountingFrom({
    session_id: SESSION,
    usage: { input_tokens: 10, output_tokens: 5 },
    modelUsage: {
      "claude-haiku-4-5-20251001": { inputTokens: 300, outputTokens: 20, contextWindow: 200_000, canonicalModel: "claude-haiku-4-5" },
      "claude-opus-5": { inputTokens: 90_000, outputTokens: 4_000, cacheReadInputTokens: 500_000, contextWindow: 1_000_000, canonicalModel: "claude-opus-5" }
    }
  })

  assert.equal(usage.input_tokens, 90_300)
  assert.equal(usage.context_window, 1_000_000)
  assert.equal(usage.model_label, "claude-opus-5")
  assert.equal(model, "claude-opus-5")
})

test("an older build without modelUsage still reports the main loop, and says nothing it does not know", () => {
  const out = claudeCode.collapseEvents([
    { type: "result", subtype: "success", result: "done", is_error: false,
      usage: { input_tokens: 900, output_tokens: 40, cache_read_input_tokens: 5_000 } }
  ])

  assert.equal(out.usage.input_tokens, 900)
  assert.equal(out.usage.cache_read_input_tokens, 5_000)
  // Absent is "unknown". The server whitelist reads a missing key as nil,
  // never as 0 — a 0 here would claim a measurement nobody took.
  for (const key of ["cache_write_1h_tokens", "reasoning_tokens", "context_window", "total_cost_usd",
                     "num_turns", "runtime_session_id", "model_label", "plan_usage"]) {
    assert.equal(out.usage[key], undefined, `${key} must be absent, not zero`)
  }
})

test("modelUsage can only add to the main loop's buckets, never zero one it reports", () => {
  const { usage } = accountingFrom({
    usage: { input_tokens: 500, output_tokens: 50, cache_creation_input_tokens: 7_000 },
    // A hypothetical build that publishes modelUsage without the cache fields.
    modelUsage: { "claude-sonnet-5": { inputTokens: 500, outputTokens: 50 } }
  })

  assert.equal(usage.cache_creation_input_tokens, 7_000)
  assert.equal(usage.input_tokens, 500)
})

test("the 1h share can never exceed the writes it is a share of", () => {
  const { usage } = accountingFrom({
    usage: { input_tokens: 1, cache_creation_input_tokens: 100, cache_creation: { ephemeral_1h_input_tokens: 250 } }
  })
  assert.equal(usage.cache_write_1h_tokens, 100)
})

test("the error arm keeps its accounting: a turn that hit --max-turns still spent tokens", () => {
  const out = claudeCode.collapseEvents([
    { type: "result", subtype: "error_max_turns", is_error: true, num_turns: 3, session_id: SESSION,
      usage: { input_tokens: 40, output_tokens: 10 },
      modelUsage: { "claude-sonnet-5": { inputTokens: 40, outputTokens: 10, costUSD: 0.01, contextWindow: 1_000_000 } } }
  ])

  assert.equal(out.isError, true)
  assert.equal(out.stopReason, "error_max_turns")
  assert.equal(out.usage.num_turns, 3)
  assert.equal(out.usage.total_cost_usd, 0.01)
})

test("plan usage is read defensively and dropped when the event carries nothing usable", () => {
  assert.equal(planUsageFrom({ type: "rate_limit_event" }), null)
  assert.equal(planUsageFrom({ rate_limit_info: "nope" }), null)
  assert.deepEqual(planUsageFrom({ rate_limit_info: { isUsingOverage: true } }), { is_using_overage: true })
  assert.deepEqual(planUsageFrom({ rate_limit_info: { unifiedWindows: { five_hour: { utilization: "0.5" } } } }),
                   { five_hour: { utilization: 0.5 } })
})

// ---------------------------------------------------------------------------
// The effort dial
// ---------------------------------------------------------------------------

test("the composer's effort level reaches the CLI as --effort", () => {
  for (const level of ["low", "medium", "high", "xhigh", "max"]) {
    assert.equal(valueOf(baseArgs({ model: "claude-opus-5", effort: level }), "--effort"), level)
  }
  assert.equal(effortFor({ effort: " High " }), "high", "normalised like Ai::Effort.normalize")
})

test("no level, or a level that is not one of the five, sends nothing", () => {
  // The default is absence: the CLI's own default applies, exactly as an
  // untouched dial does on the API path.
  for (const effort of [undefined, null, "", "standard", "ultracode", "max; rm -rf /"]) {
    assert.ok(!baseArgs({ model: "claude-opus-5", effort }).includes("--effort"), `${effort} must send nothing`)
  }
})

test("--effort is a capability flag: a build older than it degrades instead of dying", () => {
  const stripped = withoutCapabilityFlags(streamingArgs({ model: "claude-opus-5", effort: "low", system: "…" }))
  assert.ok(!stripped.includes("--effort"))
  assert.ok(!stripped.includes("low"), "the flag's value goes with it")
  assert.ok(stripped.includes("--append-system-prompt"), "everything else survives")
})

// ---------------------------------------------------------------------------
// Session continuity (--resume)
// ---------------------------------------------------------------------------

const HISTORY = [
  { role: "user", content: "Add a health endpoint" },
  { role: "assistant", content: "Done — GET /health returns 200." },
  { role: "user", content: "Now add a test for it" }
]

test("a follow-up turn with a session id resumes the transcript and sends only the new message", () => {
  const job = { model: "claude-opus-5", system: "You write Rails.", messages: HISTORY, runtime_session_id: SESSION }
  const args = baseArgs(job)

  assert.equal(valueOf(args, "--resume"), SESSION)
  assert.equal(renderPrompt(job, "User: …rendered by the engine…\n\nAssistant:"), "Now add a test for it",
               "the transcript already holds every earlier turn; only the new one is sent, unframed")
  // The system prompt is still passed: Claude Code reuses the recorded one
  // until compaction, and this is the text it records once compaction
  // happens. The server only offers an id when the text is unchanged.
  assert.equal(valueOf(args, "--append-system-prompt"), "You write Rails.")
})

test("the bot's hoisted clock band rides the resumed prompt as a second user turn", () => {
  const job = {
    model: "claude-sonnet-5", runtime_session_id: SESSION,
    messages: [...HISTORY, { role: "user", content: "## Now\n\nCurrent date and time: Monday 09:15" }]
  }
  assert.equal(renderPrompt(job, "ignored"), "Now add a test for it\n\n## Now\n\nCurrent date and time: Monday 09:15")
})

test("a first turn never resumes, whatever id the server had", () => {
  const job = { model: "claude-opus-5", messages: [{ role: "user", content: "hi" }], runtime_session_id: SESSION }
  assert.equal(resumePlan(job), null)
  assert.ok(!baseArgs(job).includes("--resume"))
  assert.equal(renderPrompt(job, "rendered"), "rendered", "the engine's full rendering goes through untouched")
})

test("a history that is not an append-only continuation is sent in full", () => {
  // The user deleted the last answer and asked again: the transcript holds
  // an assistant turn the app no longer has. Resuming would show the model
  // a history that is not the one on screen.
  const edited = [...HISTORY.slice(0, 2), { role: "assistant", content: "stray" }, { role: "assistant", content: "stray 2" }]
  assert.equal(resumePlan({ messages: edited, runtime_session_id: SESSION }), null)
  // Nothing after the last assistant turn: nothing to send.
  assert.equal(resumePlan({ messages: HISTORY.slice(0, 2), runtime_session_id: SESSION }), null)
})

test("only a UUID reaches argv as a session id", () => {
  for (const bad of ["", "latest", "../x", `${SESSION} --dangerously-skip-permissions`, 42]) {
    const job = { model: "claude-opus-5", messages: HISTORY, runtime_session_id: bad }
    assert.equal(resumePlan(job), null, `${bad} must not resume`)
    assert.ok(!baseArgs(job).includes("--resume"))
  }
})

test("a resume whose transcript is gone is retried as a full-history turn, once", () => {
  const job = { model: "claude-opus-5", messages: HISTORY, runtime_session_id: SESSION }
  const failed = { code: 1, events: [], stderr: `No conversation found with session ID: ${SESSION}` }

  const retry = fallbackJob(job, failed)
  assert.ok(retry, "the turn is worth running the old way")
  assert.equal(retry.runtime_session_id, null)
  assert.ok(!baseArgs(retry).includes("--resume"))
  assert.equal(renderPrompt(retry, "full rendering"), "full rendering")
  assert.equal(fallbackJob(retry, failed), null, "and the retry cannot ask again")
})

test("a real failure after the session loaded is not retried — re-sending the history would double the spend", () => {
  const job = { model: "claude-opus-5", messages: HISTORY, runtime_session_id: SESSION }
  const events = [{ type: "system", subtype: "init", session_id: SESSION, model: "claude-opus-5" }]

  assert.equal(fallbackJob(job, { code: 1, events, stderr: "API error: rate limited" }), null)
  assert.equal(fallbackJob(job, { code: 1, events: [], stderr: "error: unknown option '--effort'" }), null,
               "an argv rejection belongs to the engine's degrade path")
  assert.equal(fallbackJob({ ...job, runtime_session_id: null }, { code: 1, events: [] }), null,
               "a turn that was not resuming has nothing to fall back to")
})

test("--resume is never stripped by the capability degrade: the prompt behind it is the new message alone", () => {
  const args = streamingArgs({ model: "claude-opus-5", messages: HISTORY, runtime_session_id: SESSION, effort: "low" })
  assert.equal(valueOf(withoutCapabilityFlags(args), "--resume"), SESSION)
})

// ---------------------------------------------------------------------------
// The system text and the tool surface
// ---------------------------------------------------------------------------

test("the system text is handed to Claude Code byte-for-byte — no markers, no rewriting here", () => {
  // The server strips the bot's [[CACHE-BOUNDARY]] markers and hoists the
  // clock band before the job is queued (Ai::ProviderClient.wire_ready). The
  // adapter's job is to change NOTHING: this text sits in the cache-sensitive
  // system layer, and any drift between turns re-writes the whole prefix.
  const system = "tools and rules\n\nmemory notes\n\n— stable across turns —"
  assert.equal(valueOf(baseArgs({ model: "claude-opus-5", system }), "--append-system-prompt"), system)
  assert.ok(!baseArgs({ model: "claude-opus-5", system }).some((arg) => String(arg).includes("[[CACHE-BOUNDARY]]")))
})

test("a repository turn no longer opts the newest models back into the task tools", () => {
  const args = baseArgs({ model: "claude-opus-5", workdir: "/repo", messages: [] })
  const start = args.indexOf("--allowedTools")
  const allowed = args.slice(start + 1, args.indexOf("--disallowedTools"))

  for (const tool of ["TodoWrite", "TaskCreate", "TaskUpdate", "LS"]) {
    assert.ok(!allowed.includes(tool), `${tool} must not be named in --allowedTools`)
  }
  for (const tool of ["Read", "Write", "Edit", "Glob", "Grep"]) {
    assert.ok(allowed.includes(tool), `${tool} is still allowed`)
  }
})

test("the login probe is one turn with no tools", () => {
  const args = claudeCode.probeArgs()
  assert.equal(valueOf(args, "--max-turns"), "1")
  assert.equal(valueOf(args, "--disallowedTools"), "*")
  assert.ok(args.includes("-p"))
})
