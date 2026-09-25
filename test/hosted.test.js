// Hosted mode — the companion on a machine Configure My AI runs.
//
// What is pinned here is the part a person cannot see: the verdict a
// failure produces about the subscription, the link the relay pulls out of a
// vendor's terminal output (wrapped, coloured, redrawn), the code it finds
// beside that link, and the token a headless sign-in leaves behind. Each is
// a pure function, because each is the kind of thing that looks obvious and
// is wrong in exactly one vendor's output.
//
// Run with: node --test agent/test

import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "cma-hosted-"))
process.env.CMA_AGENT_HOME = HOME
process.env.CMA_HOSTED = "1"

const { classifySubscription, subscriptionFromProbe, isHosted, LOGIN_KINDS } = await import("../src/hosted_status.js")
const { hostedAuthEnv, saveAuth, forgetAuth, AUTH_PATH } = await import("../src/hosted_auth.js")
const { findLoginUrl, findUserCode, stripAnsi, updateWanted, LOGIN_PLANS, RESTART_EXIT_CODE, LINK_TIMEOUT_MS } = await import("../src/hosted.js")
const { envForProfile } = await import("../src/engine.js")
const { claudeCode } = await import("../src/runtimes/claude-code.js")

// ---------------------------------------------------------------------------
// Subscription verdicts
// ---------------------------------------------------------------------------

test("a rate limit is a rate limit, not a sign-in problem", () => {
  const verdict = classifySubscription("You've hit your usage limit. Your limit resets at 3pm (America/Chicago).")
  assert.equal(verdict.state, "rate_limited")
  assert.match(verdict.detail, /resets at 3pm/)

  // The engine's own wrapper for these, which mentions "included usage" —
  // still a limit, never a quota it cannot verify.
  assert.equal(classifySubscription("Your Claude plan is rate limited or out of included usage right now. 429").state, "rate_limited")
})

test("an expired login needs a sign-in", () => {
  assert.equal(classifySubscription("That Claude login needs signing in again (cma-agent runtimes:login --runtime claude_code). Not logged in · Please run /login").state, "needs_login")
  assert.equal(classifySubscription("401 authentication_error: invalid x-api-key").state, "needs_login")
})

test("billing and account refusals are told apart from limits", () => {
  assert.equal(classifySubscription("Your subscription has expired. Purchase a plan to continue.").state, "payment")
  assert.equal(classifySubscription("This organization has been disabled.").state, "account")
  assert.equal(classifySubscription("Your credit balance is too low to access the API.").state, "quota")
})

test("a vendor that could not be reached is unreachable, and silence is no verdict", () => {
  assert.equal(classifySubscription("fetch failed: getaddrinfo ENOTFOUND api.anthropic.com").state, "unreachable")
  assert.equal(classifySubscription("Claude Code finished without producing an answer."), null)
  assert.equal(classifySubscription(""), null)
  assert.equal(classifySubscription(null), null)
})

test("a probe's status maps onto the same vocabulary", () => {
  assert.deepEqual(subscriptionFromProbe({ status: "ready" }), { state: "connected" })
  assert.equal(subscriptionFromProbe({ status: "logged_out" }).state, "needs_login")
  assert.equal(subscriptionFromProbe({ status: "unknown", detail: "rate limit exceeded" }).state, "rate_limited")
  assert.equal(subscriptionFromProbe({ status: "unknown", detail: "segfault" }), null)
  assert.equal(subscriptionFromProbe({ status: "not_installed" }), null)
})

test("hosted mode is an environment flag, and the relay has three commands", () => {
  assert.ok(isHosted())
  assert.deepEqual([...LOGIN_KINDS].sort(), ["login.cancel", "login.code", "login.start"])
})

// ---------------------------------------------------------------------------
// The relay: what the vendor printed
// ---------------------------------------------------------------------------

test("the sign-in link is found under the colour codes a TUI paints it with", () => {
  const output = "\x1b[1mBrowser didn't open? Use the url below to sign in:\x1b[0m\r\n" +
    "\x1b[36mhttps://claude.ai/oauth/authorize?code=true&client_id=abc&redirect_uri=https%3A%2F%2Fconsole.anthropic.com%2Foauth%2Fcode%2Fcallback&state=xyz\x1b[0m\r\n" +
    "Paste code here if prompted > "
  assert.equal(findLoginUrl(output), "https://claude.ai/oauth/authorize?code=true&client_id=abc&redirect_uri=https%3A%2F%2Fconsole.anthropic.com%2Foauth%2Fcode%2Fcallback&state=xyz")
  assert.equal(stripAnsi("\x1b[32m✓\x1b[0m ok"), "✓ ok")
})

test("a link wrapped by a narrow terminal is joined back together", () => {
  const output = "Visit https://auth.openai.com/oauth/device?user_code=ABCD-EFGH&client=cod\n" +
    "ex_cli_rs&state=123456\n" +
    "and enter code: ABCD-EFGH\n"
  assert.equal(findLoginUrl(output), "https://auth.openai.com/oauth/device?user_code=ABCD-EFGH&client=codex_cli_rs&state=123456")
})

test("a documentation link is never mistaken for the sign-in", () => {
  const output = "See https://docs.anthropic.com/claude-code for help.\nOpen https://claude.ai/oauth/authorize?code=true&state=1 to continue."
  assert.equal(findLoginUrl(output), "https://claude.ai/oauth/authorize?code=true&state=1")
  assert.equal(findLoginUrl("nothing here"), null)
})

test("a device flow's one-time code is found beside its link", () => {
  assert.equal(findUserCode("Open https://x.ai/device and enter code: WXYZ-9876 to continue"), "WXYZ-9876")
  assert.equal(findUserCode("Enter the code ABCDEFGH shown"), "ABCDEFGH")
  assert.equal(findUserCode("Paste code here if prompted >"), null)
})

test("the plans say which runtimes paste a code back and which only approve a link", () => {
  assert.equal(LOGIN_PLANS.claude_code.pasteCode, true)
  assert.ok(LOGIN_PLANS.claude_code.tokenPattern.test("sk-ant-oat01-" + "a".repeat(40)))
  assert.equal(LOGIN_PLANS.codex.pasteCode, false)
  assert.equal(LOGIN_PLANS.grok.pasteCode, false)
  assert.equal(RESTART_EXIT_CODE, 75)
})

// ---------------------------------------------------------------------------
// The token a headless Claude sign-in leaves behind
// ---------------------------------------------------------------------------

test("a saved token reaches the CLI as its environment variable, and only on a cloud machine", () => {
  fs.rmSync(AUTH_PATH, { force: true })
  assert.deepEqual(hostedAuthEnv(claudeCode, ""), {})

  saveAuth("claude_code", "", "CLAUDE_CODE_OAUTH_TOKEN", "sk-ant-oat01-secret")
  assert.deepEqual(hostedAuthEnv(claudeCode, ""), { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-secret" })
  assert.deepEqual(hostedAuthEnv(claudeCode, "work"), {}, "a token is per login")
  // The engine's per-profile environment carries it.
  assert.equal(envForProfile(claudeCode, "").CLAUDE_CODE_OAUTH_TOKEN, "sk-ant-oat01-secret")

  const mode = fs.statSync(AUTH_PATH).mode & 0o777
  assert.equal(mode, 0o600, "the token file is private to the machine's user")

  forgetAuth("claude_code", "")
  assert.deepEqual(hostedAuthEnv(claudeCode, ""), {})

  saveAuth("claude_code", "", "CLAUDE_CODE_OAUTH_TOKEN", "sk-ant-oat01-secret")
  process.env.CMA_HOSTED = "0"
  assert.deepEqual(hostedAuthEnv(claudeCode, ""), {}, "a laptop never reads this file")
  process.env.CMA_HOSTED = "1"
})

// ---------------------------------------------------------------------------
// Updates
// ---------------------------------------------------------------------------

test("an update is wanted only when the server named something behind with a command", () => {
  assert.equal(updateWanted(null), false)
  assert.equal(updateWanted({ agent: { update: false }, runtime: { update: false } }), false)
  assert.equal(updateWanted({ agent: { update: true, command: "npm install -g x" }, runtime: { update: false } }), true)
  assert.equal(updateWanted({ agent: { update: true }, runtime: { update: true, command: "npm install -g y" } }), true)
  assert.equal(updateWanted({ agent: { update: true } }), false, "a target with no command is not installable")
})

// ---------------------------------------------------------------------------
// What a failed sign-in leaves behind: nothing
// ---------------------------------------------------------------------------

test("every runtime that keeps its own credential has a logout to undo a failed sign-in", () => {
  assert.deepEqual(LOGIN_PLANS.codex.logoutArgs, ["logout"])
  assert.deepEqual(LOGIN_PLANS.cursor.logoutArgs, ["logout"])
  assert.equal(LOGIN_PLANS.claude_code.logoutArgs, undefined, "Claude Code's token is the companion's file, forgotten there")
  assert.ok(LINK_TIMEOUT_MS >= 15000 && LINK_TIMEOUT_MS <= 15 * 60 * 1000, "a link that never comes fails well before the sign-in's own clock")
})
