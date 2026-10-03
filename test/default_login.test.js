// Which login work runs on when nothing names one.
//
// A provider in the web app either names a login or leaves it blank, and blank
// has always meant the ambient one — whichever account the vendor CLI happens
// to be signed into. That is right on a one-account machine and a coin toss on
// a two-account one: every provider created before the second login existed
// keeps spending the first, with nothing in a terminal able to change it.
//
// `cma-agent use` makes that meaning a choice. The invariants worth pinning:
// a named login still wins (the web app stays authoritative), a default
// pointing at a deleted login degrades to ambient rather than to a directory
// with no credential in it, and what gets REPORTED is the destination — the
// web app says which account a run spent, so a silent redirect would turn that
// display into a lie.
//
// Run with: node --test agent/test

import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "cma-default-login-"))
process.env.CMA_AGENT_HOME = HOME

const { addProfile, defaultProfileSlug, removeProfile, resolveSlug, setDefaultProfile } =
  await import("../src/profiles.js")

const CLAUDE = "claude_code"

function reset() {
  fs.rmSync(path.join(HOME, "config.json"), { force: true })
}

test("with nothing chosen, unnamed work is the ambient login", () => {
  reset()

  assert.equal(defaultProfileSlug(CLAUDE), "")
  assert.equal(resolveSlug("", CLAUDE), "")
  assert.equal(resolveSlug("default", CLAUDE), "")
  assert.equal(resolveSlug(null, CLAUDE), "")
})

test("choosing a login redirects only the unnamed work", () => {
  reset()
  addProfile(CLAUDE, "9th")

  assert.equal(setDefaultProfile(CLAUDE, "9th"), "9th")
  assert.equal(defaultProfileSlug(CLAUDE), "9th")

  assert.equal(resolveSlug("", CLAUDE), "9th", "blank means the machine's default")
  assert.equal(resolveSlug("default", CLAUDE), "9th", "so does the wire's word for it")

  // The one that matters: a provider pointed at a specific login is the
  // server's decision, and this must never quietly overrule it.
  addProfile(CLAUDE, "Work")
  assert.equal(resolveSlug("work", CLAUDE), "work")
})

test("use default puts it back", () => {
  reset()
  addProfile(CLAUDE, "9th")
  setDefaultProfile(CLAUDE, "9th")

  assert.equal(setDefaultProfile(CLAUDE, "default"), "")
  assert.equal(defaultProfileSlug(CLAUDE), "")
  assert.equal(resolveSlug("", CLAUDE), "")
})

test("a login that no longer exists degrades to ambient, not to an empty directory", () => {
  reset()
  addProfile(CLAUDE, "9th")
  setDefaultProfile(CLAUDE, "9th")
  removeProfile(CLAUDE, "9th")

  assert.equal(defaultProfileSlug(CLAUDE), "",
    "a default pointing at a deleted login would send every run somewhere with no credential")
  assert.equal(resolveSlug("", CLAUDE), "")
})

test("choosing a login that was never added is refused, and says what is there", () => {
  reset()
  addProfile(CLAUDE, "9th")

  assert.throws(() => setDefaultProfile(CLAUDE, "nope"), /No Claude Code login called "nope"/)
  assert.throws(() => setDefaultProfile(CLAUDE, "nope"), /9th/)
  assert.equal(defaultProfileSlug(CLAUDE), "", "a refused choice changes nothing")
})

test("the choice is per runtime — one word, two different logins", () => {
  reset()
  addProfile(CLAUDE, "Work")
  addProfile("cursor", "Work")

  setDefaultProfile(CLAUDE, "work")

  assert.equal(defaultProfileSlug(CLAUDE), "work")
  assert.equal(defaultProfileSlug("cursor"), "", "Cursor's default is its own to set")
  assert.equal(resolveSlug("", "cursor"), "")
})
