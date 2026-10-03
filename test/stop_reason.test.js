// What this terminal says when the SERVER, not this machine, ends a run.
//
// The companion kills its CLI on the server's word and then has to explain
// itself to whoever is watching the terminal. It used to have one sentence for
// that — "Cancelled from the web app" — and reached for it whenever the job
// came back `cancelled`. But the app reaches `cancelled` two ways: a person
// presses Stop, and the app gives up waiting on a run. So a machine that was
// working perfectly told its owner they had cancelled something they had never
// touched, which sends them to the browser to look for a button nobody pressed.
//
// The server composes the sentence now, because the server is where the reason
// is known. These tests pin the three things that has to get right: the reason
// is used when it is sent, a state the server settled always stops the run, and
// a server too old to send a reason still gets an honest fallback.
//
// Run with: node --test "agent/test/*.test.js"

import { test } from "node:test"
import assert from "node:assert/strict"

const { serverStopReason } = await import("../src/runner.js")

test("a run the server is still waiting on is not stopped", () => {
  assert.equal(serverStopReason({ ok: true, state: "claimed" }), null)
  assert.equal(serverStopReason({ ok: true, state: "queued" }), null)
  // A heartbeat that raced the result it belongs to. The run is over on this
  // side already; there is nothing to kill and nothing to explain.
  assert.equal(serverStopReason({ ok: true, state: "succeeded" }), null)
  assert.equal(serverStopReason(null), null)
  assert.equal(serverStopReason({}), null)
})

test("the server's own reason is what gets printed", () => {
  assert.equal(
    serverStopReason({ state: "cancelled", reason: "The run was cancelled by the requester" }),
    "The run was cancelled by the requester"
  )
  // The case the old code could not tell apart from a person pressing Stop.
  assert.equal(
    serverStopReason({
      state: "cancelled",
      reason: "That machine is connected but never picked this run up"
    }),
    "That machine is connected but never picked this run up"
  )
})

test("every state the server settles ends the run, not just cancelled", () => {
  // `expired` used to be ignored entirely: the server had written the run off,
  // and this machine went on spending the user's subscription producing an
  // answer that would be discarded on arrival.
  assert.equal(serverStopReason({ state: "expired", reason: "The device stopped responding mid-run" }),
               "The device stopped responding mid-run")
  assert.equal(serverStopReason({ state: "failed", reason: "Something went wrong" }),
               "Something went wrong")
})

test("a server too old to send a reason still gets an honest line", () => {
  assert.equal(serverStopReason({ state: "cancelled" }), "Cancelled from the web app")
  assert.equal(serverStopReason({ state: "expired" }), "The server gave up on this run")
  assert.equal(serverStopReason({ state: "failed" }), "The server recorded this run as failed")
  // Whitespace is not a reason.
  assert.equal(serverStopReason({ state: "cancelled", reason: "   " }), "Cancelled from the web app")
})
