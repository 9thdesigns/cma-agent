import test from "node:test"
import assert from "node:assert/strict"

import {
  grok, effortArg, EFFORT_LEVELS, fallbackJob, resumePlan, renderPrompt, streamingArgs
} from "../src/runtimes/grok.js"

// ---------------------------------------------------------------------------
// Fixtures. Every line below is the documented `--output-format streaming-json`
// shape (xai-org/grok-build, crates/codegen/xai-grok-pager/docs/user-guide/
// 14-headless-mode.md, pager-bin 1.0.24) — the per-response `usage` line and
// the `end` spend fields verbatim from the doc's own examples, with the
// json-format numbers (7,210 / 41,000 / 0 / 1,893, reasoning 412, 7 turns,
// $0.01268905) on `end`, which the doc says carries "the json object shape".
// ---------------------------------------------------------------------------

const SESSION = "0192b4c6-7d2e-7a3b-8c4d-5e6f70819a2b"

const USAGE_LINE = (overrides = {}) => ({
  type: "usage", messageId: "resp_1", stopReason: "tool_use", signature: "...",
  usage: { input_tokens: 812, output_tokens: 45, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, reasoning_tokens: 0, ...overrides }
})

const END_SPEND = {
  usage: {
    input_tokens: 7210, cache_read_input_tokens: 41000, cache_creation_input_tokens: 0,
    output_tokens: 1893, reasoning_tokens: 412, total_tokens: 50103
  },
  num_turns: 7,
  modelUsage: {
    "grok-4.6": { inputTokens: 7210, outputTokens: 1893, cacheReadInputTokens: 41000, cacheCreationInputTokens: 0, modelCalls: 7, costUSD: 0.01268905 }
  },
  total_cost_usd: 0.01268905,
  total_cost_usd_ticks: 126890500
}

const DOC_STREAM = [
  { type: "thought", data: "Analyzing the directory structure..." },
  { type: "tool_call", toolCallId: "call_1", title: "Read", kind: "read", status: "in_progress",
    toolName: "read_file", rawInput: { path: "src/main.rs" }, content: [], locations: [] },
  { type: "tool_call_update", toolCallId: "call_1", status: "completed", content: [], rawOutput: { lines: 42 }, locations: [] },
  USAGE_LINE({ input_tokens: 700, output_tokens: 30, cache_read_input_tokens: 20000 }),
  { type: "text", data: "Here's a summary" },
  USAGE_LINE({ input_tokens: 812, output_tokens: 45, cache_read_input_tokens: 41000, reasoning_tokens: 12 }),
  { type: "end", stopReason: "end_turn", sessionId: SESSION, requestId: "xyz789", ...END_SPEND }
]

const REPO_JOB = { id: "j", model: "grok-4.6", workdir: "/r", system: "operator instructions", messages: [] }

test("the documented stream folds to the additive contract, from the CLI's own aggregate", () => {
  const out = grok.collapseEvents(DOC_STREAM)

  assert.equal(out.content, "Here's a summary")
  assert.equal(out.stopReason, "end_turn")
  assert.ok(out.sawResult)
  assert.ok(!out.isError)

  // The run total is `end.usage`, as reported: input is already the uncached
  // share, the cache buckets sit beside it, nothing is folded or subtracted.
  assert.equal(out.usage.input_tokens, 7210)
  assert.equal(out.usage.cache_read_input_tokens, 41000)
  assert.equal(out.usage.cache_creation_input_tokens, 0)
  assert.equal(out.usage.output_tokens, 1893)
  assert.equal(out.usage.input_tokens + out.usage.cache_read_input_tokens +
               out.usage.cache_creation_input_tokens + out.usage.output_tokens, 50103,
               "the documented identity: total = input + cache_read + cache_creation + output")

  // Reasoning is INSIDE output_tokens on this CLI — informational only.
  assert.equal(out.usage.reasoning_tokens, 412)

  // The extras of the additive contract.
  assert.equal(out.usage.num_turns, 7)
  assert.equal(out.usage.total_cost_usd, 0.01268905)
  assert.equal(out.usage.model_label, "grok-4.6")
  assert.equal(out.model, "grok-4.6")
  assert.equal(out.usage.runtime_session_id, SESSION)
  assert.ok(!("context_window" in out.usage), "no window on this format — unknown, never a guess")
  assert.deepEqual(out.warnings, [])
})

test("the last usage line is the context reading: input plus both cache buckets, since input is uncached", () => {
  const out = grok.collapseEvents(DOC_STREAM)
  assert.equal(out.usage.context_tokens, 812 + 41000)
})

test("without an aggregate, the per-response lines are summed — and never added to one that arrives", () => {
  const lines = [
    USAGE_LINE({ input_tokens: 700, output_tokens: 30, cache_read_input_tokens: 20000, reasoning_tokens: 5 }),
    USAGE_LINE({ input_tokens: 812, output_tokens: 45, cache_read_input_tokens: 41000, reasoning_tokens: 12 })
  ]

  // A run cut off before `end`: the sum is the best figure there is.
  const partial = grok.collapseEvents(lines)
  assert.equal(partial.usage.input_tokens, 1512)
  assert.equal(partial.usage.cache_read_input_tokens, 61000)
  assert.equal(partial.usage.output_tokens, 75)
  assert.equal(partial.usage.reasoning_tokens, 17)
  assert.equal(partial.usage.num_turns, 2, "the count of completed responses, the CLI's own fallback")
  assert.equal(partial.usage.context_tokens, 41812)
  assert.ok(!partial.sawResult)
  assert.ok(!("model_label" in partial.usage))
  assert.ok(!("total_cost_usd" in partial.usage))

  // The same lines followed by an `end` with the ledger: the ledger REPLACES
  // the sum. The doc's numbers differ from the sum on purpose.
  const whole = grok.collapseEvents([...lines, { type: "end", stopReason: "end_turn", sessionId: SESSION, requestId: "r", ...END_SPEND }])
  assert.equal(whole.usage.input_tokens, 7210)
  assert.equal(whole.usage.output_tokens, 1893)
  assert.equal(whole.usage.reasoning_tokens, 412)
  assert.equal(whole.usage.num_turns, 7)
})

test("an error line is a failure and keeps whatever spend it carries", () => {
  const withSpend = grok.collapseEvents([
    USAGE_LINE(),
    { type: "error", message: "rate limited", ...END_SPEND }
  ])
  assert.equal(withSpend.isError, true)
  assert.match(withSpend.errorStatus, /rate limited/)
  assert.equal(withSpend.usage.input_tokens, 7210)
  assert.equal(withSpend.usage.num_turns, 7)
  assert.ok(!withSpend.sawResult)

  const bare = grok.collapseEvents([{ type: "error", message: "Couldn't start session: ..." }])
  assert.equal(bare.isError, true)
  assert.equal(bare.usage.input_tokens, 0)
  assert.ok(!("reasoning_tokens" in bare.usage))
})

// Shapes the source does not promise: a `usage` line without its object, a
// bare `end`, flat counts where the nest should be. Zeros, never a guess.
test("an unknown usage shape reports zeros, not a guess", () => {
  const out = grok.collapseEvents([
    { type: "usage" },
    { type: "usage", input_tokens: 999, output_tokens: 999 },
    { type: "text", data: "ok" },
    { type: "end", stopReason: "end_turn", sessionId: SESSION, requestId: "r" }
  ])
  assert.equal(out.content, "ok")
  assert.deepEqual(out.usage, {
    input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
    context_tokens: 0, runtime_session_id: SESSION
  })
  assert.ok(out.sawResult)
})

test("a window and a cost are sent only when the build put them on the wire", () => {
  const withWindow = grok.collapseEvents([{
    type: "end", stopReason: "end_turn", sessionId: SESSION, requestId: "r", ...END_SPEND,
    // The streaming-messages-json spelling, on the current model's row only.
    modelUsage: { "grok-4.6": { ...END_SPEND.modelUsage["grok-4.6"], contextWindow: 256000 } }
  }])
  assert.equal(withWindow.usage.context_window, 256000)

  // The CLI omits every cost float when the bill is partial: absent means
  // unknown, and the adapter must not invent one from the model rows.
  const partialCost = grok.collapseEvents([{
    type: "end", stopReason: "end_turn", sessionId: SESSION, requestId: "r",
    usage: END_SPEND.usage, num_turns: 7, cost_is_partial: true,
    modelUsage: { "grok-4.6": { inputTokens: 7210, outputTokens: 1893, cacheReadInputTokens: 41000, cacheCreationInputTokens: 0, modelCalls: 7 } }
  }])
  assert.ok(!("total_cost_usd" in partialCost.usage))
  assert.equal(partialCost.usage.model_label, "grok-4.6")
})

test("the model label is the row that did the work, and the CLI's own caveats become warnings", () => {
  const out = grok.collapseEvents([
    { type: "max_turns_reached" },
    { type: "end", stopReason: "max_turn_requests", sessionId: SESSION, requestId: "r",
      usage: END_SPEND.usage, num_turns: 3, usage_is_incomplete: true,
      modelUsage: {
        "grok-4.5": { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, modelCalls: 1 },
        "grok-4.6": { inputTokens: 5, outputTokens: 5, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, modelCalls: 6 }
      } }
  ])
  assert.equal(out.usage.model_label, "grok-4.6")
  assert.equal(out.stopReason, "max_turn_requests")
  assert.equal(out.warnings.length, 2)
  assert.match(out.warnings[0], /turn limit/)
  assert.match(out.warnings[1], /incomplete/)
  assert.equal(out.usage.input_tokens, 7210, "an incomplete ledger is still the best figure there is")
})

test("the ticker reads the ACP kind when the tool name is not one xAI documents", () => {
  const line = (event) => grok.describeEvent(event)
  assert.equal(line({ type: "tool_call", toolName: "apply_patch", kind: "edit", rawInput: {}, locations: [{ path: "lib/a.rb", line: 3 }] }),
               "Editing lib/a.rb")
  assert.equal(line({ type: "tool_call", toolName: "shell", kind: "execute", title: "npm test", rawInput: {} }), "Running npm test")
  assert.equal(line({ type: "tool_call", toolName: "web_fetch", kind: "fetch", rawInput: {} }), "Fetching a page")
  assert.equal(line({ type: "tool_call", toolName: "list_dir", kind: "read", rawInput: { path: "app" } }), "Listing files")
  assert.equal(line({ type: "auto_compact_started", percentage: 80 }), "Compacting the conversation")
  assert.equal(line({ type: "tool_call_update", toolCallId: "c1", status: "completed" }), null)
  // A write named only by its kind still reaches the documents channel.
  assert.equal(grok.writtenPathFrom({ type: "tool_call", toolName: "apply_patch", kind: "edit", rawInput: {}, locations: [{ path: "docs/plan.md" }] }),
               "docs/plan.md")
})

// ---------------------------------------------------------------------------
// The effort dial: `--effort <level>`, max → xhigh (the CLI's built-in menu
// tops out at xhigh and a level a menu lacks fails the run).
// ---------------------------------------------------------------------------

test("the effort dial reaches the CLI as --effort, with max sent as xhigh", () => {
  assert.deepEqual(EFFORT_LEVELS, { low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "xhigh" })
  assert.deepEqual(effortArg({ effort: "high" }), ["--effort", "high"])
  assert.deepEqual(effortArg({ effort: "max" }), ["--effort", "xhigh"])
  assert.deepEqual(effortArg({ effort: "MEDIUM " }), ["--effort", "medium"])
  assert.deepEqual(effortArg({ effort: "deep" }), [], "only Ai::Effort's own levels, never a menu id we have not seen")
  assert.deepEqual(effortArg({}), [])

  const args = streamingArgs({ ...REPO_JOB, effort: "max" }, "do it")
  assert.equal(args[args.indexOf("--effort") + 1], "xhigh")
  assert.equal(args.at(-1), "do it", "the prompt is still last")
  assert.ok(!streamingArgs(REPO_JOB, "do it").includes("--effort"), "no dial, no flag")
})

// ---------------------------------------------------------------------------
// Session continuity: `--resume <uuid>` with only the new user turn(s).
// ---------------------------------------------------------------------------

const HISTORY = [
  { role: "user", content: "first" },
  { role: "assistant", content: "answer" },
  { role: "user", content: "second" }
]

test("a continuation resumes the session and sends only the new turns", () => {
  const job = { ...REPO_JOB, runtime_session_id: SESSION, messages: HISTORY }
  assert.deepEqual(resumePlan(job), { sessionId: SESSION, tail: [{ role: "user", content: "second" }] })

  const args = streamingArgs(job, "rendered history")
  assert.equal(args[args.indexOf("--resume") + 1], SESSION)
  assert.equal(renderPrompt(job, "rendered history"), "second", "the transcript already holds the rest")
  assert.equal(args.at(-2), "-p")
})

test("a resume is refused whenever it could change the answer", () => {
  // Not a UUID: Grok would match it against session TITLES.
  assert.equal(resumePlan({ ...REPO_JOB, runtime_session_id: "abc123", messages: HISTORY }), null)
  // A first turn has nothing to resume into.
  assert.equal(resumePlan({ ...REPO_JOB, runtime_session_id: SESSION, messages: [{ role: "user", content: "hi" }] }), null)
  // An edited history — the last message is not a new user turn.
  assert.equal(resumePlan({ ...REPO_JOB, runtime_session_id: SESSION, messages: HISTORY.slice(0, 2) }), null)
  // No id offered: the ordinary rendering, system text fenced in.
  assert.match(renderPrompt({ ...REPO_JOB, messages: HISTORY }, "rendered"), /^<system>\noperator instructions\n<\/system>\n\nrendered$/)
  assert.ok(!streamingArgs({ ...REPO_JOB, messages: HISTORY }).includes("--resume"))
})

test("fallbackJob retries once without the dial or the session, only when nothing was spent", () => {
  const resumed = { ...REPO_JOB, runtime_session_id: SESSION, messages: HISTORY, effort: "high" }

  // The CLI's own effort rejection, on stderr or as the error line.
  assert.deepEqual(fallbackJob(resumed, { code: 1, stderr: "--effort/--reasoning-effort: unknown effort level 'high' (offered: low, medium)", events: [] }),
                   { ...resumed, effort: null })
  assert.deepEqual(fallbackJob(resumed, { code: 1, stderr: "", events: [{ type: "error", message: "--effort/--reasoning-effort: unknown effort level 'high'" }] }),
                   { ...resumed, effort: null })

  // A dead resume: exit 1, nothing reached the model.
  assert.deepEqual(fallbackJob(resumed, { code: 1, stderr: "", events: [{ type: "error", message: "Couldn't start session: not found" }] }),
                   { ...resumed, runtime_session_id: null })

  // A real run that failed is not retried — the history would be spent twice.
  assert.equal(fallbackJob(resumed, { code: 1, stderr: "", events: [USAGE_LINE(), { type: "error", message: "rate limited" }] }), null)
  assert.equal(fallbackJob(resumed, { code: 1, stderr: "", events: [{ type: "text", data: "partial" }] }), null)
  assert.equal(fallbackJob(resumed, { code: 1, stderr: "", events: [{ type: "error", message: "rate limited", ...END_SPEND }] }), null,
               "an error line carrying spend fields is a run that spent")
  // An argv rejection is the engine's own degrade path.
  assert.equal(fallbackJob(resumed, { code: 2, stderr: "error: unknown option '--effort'", events: [] }), null)
  // Nothing to fall back from.
  assert.equal(fallbackJob({ ...REPO_JOB, messages: HISTORY }, { code: 1, stderr: "boom", events: [] }), null)
  assert.equal(grok.fallbackJob, fallbackJob)
})

// ---------------------------------------------------------------------------
// The shape that arrives when a build stops projecting the payload flat.
//
// This is the bug a real run hit: the run thought, worked and planned for
// minutes, then failed with "Grok Build finished without producing an answer."
// Nothing was wrong with the CLI or the login — every line was READ, because
// the `type` tag is still at the top level, and every payload was MISSED,
// because it had moved one level down. The answer never accumulated (`data` was
// an object, not a string) and every tool call described itself as the bare
// word "Working" (no `toolName`, `kind` or `title` where they were looked for).
//
// Both are one cause, so both are pinned here. The flat shape above must keep
// parsing exactly as it did — these are additional shapes, not a replacement.
// ---------------------------------------------------------------------------

const NESTED_STREAM = [
  { type: "thought", data: { type: "text", text: "Analyzing the directory structure..." } },
  { type: "tool_call", data: { toolCallId: "call_1", title: "Read", kind: "read", status: "in_progress",
                               toolName: "read_file", rawInput: { path: "src/main.rs" }, locations: [] } },
  { type: "text", data: { type: "text", text: "Here's " } },
  { type: "text", data: { type: "text", text: "a summary" } },
  { type: "end", data: { stopReason: "end_turn", sessionId: SESSION, usage: END_SPEND.usage,
                         num_turns: 7, modelUsage: END_SPEND.modelUsage, total_cost_usd: 0.01268905 } }
]

test("a nested payload still yields the answer, not an answerless run", () => {
  const out = grok.collapseEvents(NESTED_STREAM)

  assert.equal(out.content, "Here's a summary")
  assert.equal(out.stopReason, "end_turn")
  assert.ok(out.sawResult)
  assert.ok(!out.isError)

  // The whole ledger reads through too — a moved payload must not silently
  // cost the run its spend, its model or its resumable session id.
  assert.equal(out.usage.input_tokens, 7210)
  assert.equal(out.usage.cache_read_input_tokens, 41000)
  assert.equal(out.usage.num_turns, 7)
  assert.equal(out.usage.total_cost_usd, 0.01268905)
  assert.equal(out.model, "grok-4.6")
  assert.equal(out.usage.runtime_session_id, SESSION)
})

test("a nested tool call describes what it is doing, not 'Working'", () => {
  const line = (event) => grok.describeEvent(event)

  assert.equal(line(NESTED_STREAM[1]), "Reading src/main.rs")
  assert.equal(line({ type: "tool_call", toolCall: { toolName: "bash", kind: "execute", title: "npm test" } }),
               "Running npm test")
  assert.equal(line({ type: "tool_call", data: { kind: "search" } }), "Searching the code")
  // The raw ACP spelling a build that stops projecting would emit.
  assert.equal(line({ type: "agent_thought_chunk", content: { type: "text", text: "hmm" } }), "Thinking")

  // A write is still spotted for the documents channel through the nest.
  assert.equal(grok.writtenPathFrom({ type: "tool_call", data: { toolName: "search_replace", kind: "edit",
                                                                 rawInput: { path: "lib/a.rb" } } }),
               "lib/a.rb")
})

test("the answer is the answer — reasoning is never collected as content", () => {
  const out = grok.collapseEvents([
    { type: "thought", data: { type: "text", text: "the user probably wants X" } },
    { type: "agent_thought_chunk", content: { type: "text", text: "and also Y" } },
    { type: "end", stopReason: "end_turn", sessionId: SESSION, requestId: "r", ...END_SPEND }
  ])
  // Answerless, and deliberately so: a turn that only ever thought has no
  // answer, and passing the reasoning off as one would be worse than failing.
  assert.equal(out.content, "")
})

test("the flat and nested spellings of one chunk agree", () => {
  const flat = grok.collapseEvents([{ type: "text", data: "hello" }])
  const block = grok.collapseEvents([{ type: "text", content: [{ type: "text", text: "hello" }] }])
  const chunk = grok.collapseEvents([{ type: "agent_message_chunk", delta: "hello" }])

  assert.equal(flat.content, "hello")
  assert.equal(block.content, "hello")
  assert.equal(chunk.content, "hello")
})
