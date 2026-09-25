// Signing in the login that actually expired.
//
// The failure this pins is a loop, not a crash. `cma-agent use 9th` sends work
// that names no login to the "9th" profile directory; when that profile's
// OAuth session expired, every run failed with "That Claude login needs
// signing in again (cma-agent runtimes:login --runtime claude_code)" — and
// that command signed in the AMBIENT login, a different directory that no run
// was using. The vendor's own "Welcome back" printed either way. Sign in,
// watch it fail, sign in again, four times over, with nothing on screen
// disagreeing.
//
// Three things had to be true to end it, and each is asserted below:
//
//   1. a sign-in with no --profile goes where unnamed work goes
//   2. the failure names THAT login, so the instruction is one that works
//   3. a signed-out login is said out loud at startup, once per credential,
//      rather than discovered from a browser minutes later
//
// Run with: node --test "agent/test/*.test.js"

import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "cma-login-target-"))
process.env.CMA_AGENT_HOME = HOME

const { addProfile, loginSlug, resolveSlug, setDefaultProfile } = await import("../src/profiles.js")
const { loginCommand } = await import("../src/runtimes/shared.js")
const { claudeCode } = await import("../src/runtimes/claude-code.js")
const { signedOutLogins } = await import("../src/runner.js")

const CLAUDE = "claude_code"

function reset() {
  fs.rmSync(path.join(HOME, "config.json"), { force: true })
}

test("a sign-in with no profile named signs in the login unnamed work runs on", () => {
  reset()
  addProfile(CLAUDE, "9th")
  setDefaultProfile(CLAUDE, "9th")

  // The bug, stated as an equality: these two must resolve to the same login,
  // or the command an error message prints fixes a credential nothing uses.
  assert.equal(loginSlug(CLAUDE, undefined), resolveSlug("default", CLAUDE))
  assert.equal(loginSlug(CLAUDE, undefined), "9th")
  // `--profile` with no value parses as `true`; it is still "nothing named".
  assert.equal(loginSlug(CLAUDE, true), "9th")
})

test("the ambient login is still reachable by the name it is printed under", () => {
  reset()
  addProfile(CLAUDE, "9th")
  setDefaultProfile(CLAUDE, "9th")

  assert.equal(loginSlug(CLAUDE, "default"), "", "the Default row, asked for by name")
  assert.equal(loginSlug(CLAUDE, "9th"), "9th")
})

test("with nothing chosen it is the ambient login, as it always was", () => {
  reset()
  assert.equal(loginSlug(CLAUDE, undefined), "")
  assert.equal(loginSlug(CLAUDE, "default"), "")
})

test("an expired login names itself in the failure it produces", () => {
  const error = claudeCode.classifyFailure(
    "Failed to authenticate: OAuth session expired and could not be refreshed",
    { profileSlug: "9th" }
  )

  assert.match(error.message, /needs signing in again/)
  assert.match(error.message, /--profile 9th/,
    "the command in the message has to reach the credential that expired")
})

test("a run on the ambient login gets the command with no profile in it", () => {
  const error = claudeCode.classifyFailure("401 unauthorized", {})
  assert.match(error.message, /cma-agent runtimes:login --runtime claude_code(?! --profile)/)
})

test("loginCommand is the one place the command is spelled", () => {
  assert.equal(loginCommand(CLAUDE), "cma-agent runtimes:login --runtime claude_code")
  assert.equal(loginCommand(CLAUDE, "9th"), "cma-agent runtimes:login --runtime claude_code --profile 9th")
})

test("startup names a signed-out login once, with the command that fixes it", () => {
  reset()
  addProfile(CLAUDE, "9th")
  setDefaultProfile(CLAUDE, "9th")

  // What a scan reports on that machine: the ambient row probes wherever
  // `cma-agent use` pointed it, so both rows describe the same credential.
  const scanned = [
    { runtime: CLAUDE, slug: "default", label: "Default", status: "logged_out", detail: null },
    { runtime: CLAUDE, slug: "9th", label: "9th", status: "logged_out", detail: null }
  ]

  const warned = signedOutLogins(scanned)
  assert.equal(warned.length, 1, "one expired credential is one warning, not two")
  assert.equal(warned[0].slug, "9th")
  assert.equal(warned[0].command, "cma-agent runtimes:login --runtime claude_code --profile 9th")
})

test("a login that works is not warned about", () => {
  reset()
  const scanned = [
    { runtime: CLAUDE, slug: "default", label: "Default", status: "ready", detail: null },
    { runtime: CLAUDE, slug: "work", label: "Work", status: "logged_out", detail: null }
  ]

  const warned = signedOutLogins(scanned)
  assert.deepEqual(warned.map((w) => w.slug), ["work"])
})

test("a runtime whose sign-in we cannot drive gets its own instruction", () => {
  reset()

  // Gemini is signed in by running `gemini` once — `cma-agent runtimes:login`
  // refuses it, so printing that command would be the same wrong instruction
  // this change exists to remove, one runtime over.
  const warned = signedOutLogins([
    { runtime: "gemini_cli", slug: "default", label: "Default", status: "logged_out", detail: null }
  ])

  assert.equal(warned.length, 1)
  assert.doesNotMatch(warned[0].command, /runtimes:login/)
  assert.match(warned[0].command, /gemini/)
})
