// A turn that produced no answer — the two ways that can end.
//
// This is the failure a real Grok run hit twice. Both times the run edited a
// file, pushed a branch and opened a pull request; both times the web app said
// only "Grok Build finished without producing an answer." Two separate problems
// wearing one sentence, and these pin the fix for each:
//
//   * the sentence itself was unactionable. Nobody — the user, us, or the next
//     reader of the log — could tell a turn limit from a refusal from an adapter
//     that no longer recognises the build's event shape. It now carries the
//     run's own evidence.
//   * a run that DID the work should not be reported as a failure at all. The
//     work existed on GitHub while the session recorded an error, which is the
//     worst of both: the person believes nothing happened, and the turn's
//     documents are discarded on the way out.
import { test } from "node:test"
import assert from "node:assert/strict"

const { noAnswerError, salvagedAnswer } = await import("../src/engine.js")

const RUNTIME = { name: "Grok Build" }
const ended = (extra = {}) => ({ sawResult: true, isError: false, stopReason: "end_turn", ...extra })

// ── The diagnostic ─────────────────────────────────────────────────────────

test("the failure names the stop reason and what the run actually emitted", () => {
  // The exact shape of the run that started all this: it thought and worked for
  // minutes and never emitted a `text` event. That tally IS the diagnosis —
  // an adapter that read the stream and missed the answer.
  const result = { events: [
    { type: "thought" }, { type: "tool_call" }, { type: "thought" }, { type: "tool_call" },
    { type: "plan" }, { type: "end" }
  ] }
  const message = noAnswerError(RUNTIME, result, ended()).message

  assert.match(message, /Grok Build finished without producing an answer\./)
  assert.match(message, /stopped with "end_turn"/)
  assert.match(message, /thought×2/)
  assert.match(message, /tool_call×2/)
  assert.match(message, /plan/)
  // No `text` in the tally is the whole point — nothing should claim there was.
  refuteMatch(message, /\btext\b/)
})

test("a run that emitted nothing at all says so, rather than listing nothing", () => {
  const message = noAnswerError(RUNTIME, { events: [] }, null).message
  assert.match(message, /no events this adapter could read/)
})

test("the adapter's own warning is the most useful line, so it is carried", () => {
  const output = ended({ warnings: ["Grok stopped at its turn limit before the task was finished."] })
  assert.match(noAnswerError(RUNTIME, { events: [{ type: "end" }] }, output).message, /turn limit/)
})

// ── The salvage ────────────────────────────────────────────────────────────

test("a run that finished and did work is reported, not failed", () => {
  const result = { events: [{ type: "tool_call" }, { type: "tool_call" }, { type: "end" }] }
  const salvaged = salvagedAnswer(RUNTIME, result, ended(), new Set(["app/views/shared/_nav.html.erb"]))

  assert.ok(salvaged, "a finished run with tool calls must not be thrown away")
  // It never pretends to be the answer, and it never invents one.
  assert.match(salvaged, /without a closing message/)
  assert.match(salvaged, /Tool calls: 2\./)
  assert.match(salvaged, /app\/views\/shared\/_nav\.html\.erb/)
  // And it warns against the thing that wastes the work: asking again.
  assert.match(salvaged, /repeating the request would repeat the work/)
})

test("a run with nothing to show for itself is still a failure", () => {
  // No tool call, no write: a run that genuinely did nothing has nothing to
  // salvage, and dressing that up as a turn would hide a real problem.
  assert.equal(salvagedAnswer(RUNTIME, { events: [{ type: "thought" }, { type: "end" }] }, ended(), new Set()), null)
})

test("an error or an unfinished run is never salvaged", () => {
  const result = { events: [{ type: "tool_call" }, { type: "end" }] }
  // An in-band error must keep reaching the classifier — salvaging it would
  // turn a rate limit or a refusal into a cheerful summary.
  assert.equal(salvagedAnswer(RUNTIME, result, ended({ isError: true }), new Set(["a.rb"])), null)
  // No `end` event means the run was cut off, not that it finished quietly.
  assert.equal(salvagedAnswer(RUNTIME, result, ended({ sawResult: false }), new Set(["a.rb"])), null)
})

test("a long list of files is bounded", () => {
  const written = new Set(Array.from({ length: 25 }, (_, i) => `file-${i}.rb`))
  const salvaged = salvagedAnswer(RUNTIME, { events: [{ type: "tool_call" }] }, ended(), written)
  assert.match(salvaged, /…and 5 more/)
})

test("a nested tool_call still counts as work, so the run is salvaged", () => {
  // The shape a projector that stopped flattening actually writes: the type
  // tag is still `tool_call`, but the call itself sits under `data`. Counting
  // only `event.type === "tool_call"` already caught this; counting a line
  // whose type moved onto `sessionUpdate` is the one 0.22.0 still missed.
  const nested = { events: [
    { sessionUpdate: "tool_call", toolName: "read_file" },
    { type: "end" }
  ] }
  const salvaged = salvagedAnswer(RUNTIME, nested, ended(), new Set())
  assert.ok(salvaged, "an ACP-shaped tool call must not look like a run that did nothing")
  assert.match(salvaged, /Tool calls: 1\./)
})

function refuteMatch(value, pattern) {
  assert.ok(!pattern.test(value), `expected ${pattern} not to match: ${value}`)
}
