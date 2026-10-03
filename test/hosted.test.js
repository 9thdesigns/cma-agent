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
const { findLoginUrl, findUserCode, stripAnsi, updateWanted, LOGIN_PLANS, RESTART_EXIT_CODE, LINK_TIMEOUT_MS, BOOT_UPDATE_DELAY_MS, UPDATE_RETRY_AFTER_MS, enterKeyFor, CODE_TIMEOUT_MS, nudgeDue, NUDGE_EVERY_MS } = await import("../src/hosted.js")
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

test("sign-in words in an unrelated failure are not a sign-in problem", () => {
  // Each of these stopped a cloud machine for every later run: a GitHub 403
  // in the run's output, a git credential helper, an operations token of the
  // app's own that had gone stale, a forbidden page.
  assert.equal(classifySubscription("Error fetching https://github.com/acme/private: github.com returned 403"), null)
  assert.equal(classifySubscription("Couldn't clone acme/widgets on this machine: remote: Repository not found. The clone uses your own git credentials — check you can `git clone` it by hand."), null)
  assert.equal(classifySubscription("403 Forbidden"), null)
  assert.equal(classifySubscription("the certificate has expired"), null)
  // …while the vendors' own sentences still are.
  assert.equal(classifySubscription("OAuth token has expired. Please run /login").state, "needs_login")
  assert.equal(classifySubscription("Not logged in, please run codex login").state, "needs_login")
  assert.equal(classifySubscription("Not authenticated. Run cursor-agent login").state, "needs_login")
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

// ---------------------------------------------------------------------------
// An install that changed nothing is not run again on the next boot
// ---------------------------------------------------------------------------

test("an update just applied for the same target is not wanted again, and one for a new target is", () => {
  const now = Date.parse("2026-09-25T21:00:00Z")
  const plan = { agent: { update: true, target: "0.24.0", command: "npm i -g a" }, runtime: { update: true, key: "claude_code", target: "2.1.283", command: "npm i -g c" } }
  const justApplied = { applied_at: "2026-09-25T20:59:00Z", agent_target: "0.24.0", runtime_target: "2.1.283" }

  assert.equal(updateWanted(plan, justApplied, now), false, "both steps were installed a minute ago")
  assert.equal(updateWanted(plan, { ...justApplied, runtime_target: "2.1.282" }, now), true, "the runtime target moved on")
  assert.equal(updateWanted(plan, { ...justApplied, applied_at: new Date(now - UPDATE_RETRY_AFTER_MS - 1000).toISOString() }, now), true, "the retry window passed")
  assert.equal(updateWanted(plan, {}, now), true, "nothing was ever installed")

  // An installer runtime has no target; within the window it is the same install.
  const installer = { agent: { update: false }, runtime: { update: true, key: "cursor", target: null, command: "curl … | bash" } }
  assert.equal(updateWanted(installer, { applied_at: "2026-09-25T20:59:00Z", runtime_target: null }, now), false)
  assert.equal(updateWanted(installer, {}, now), true)
  assert.ok(BOOT_UPDATE_DELAY_MS >= 30000, "a boot never restarts itself in its first half minute")
})

test("Enter is a carriage return on a pseudo-terminal and a line feed on a pipe", () => {
  assert.equal(enterKeyFor(LOGIN_PLANS.claude_code), "\r", "Claude Code's raw-mode input ignores a line feed")
  assert.equal(enterKeyFor(LOGIN_PLANS.codex), "\n")
  assert.equal(enterKeyFor(null), "\n")
  assert.ok(CODE_TIMEOUT_MS >= 15000 && CODE_TIMEOUT_MS < LOGIN_TIMEOUT_MS_FOR_TEST(), "a code that did not take fails well before the sign-in's own clock")
})

function LOGIN_TIMEOUT_MS_FOR_TEST() { return 15 * 60 * 1000 }

test("a heartbeat nudge is answered with a check at most once per interval", () => {
  const now = Date.parse("2026-09-25T23:00:00Z")
  assert.equal(nudgeDue(now - 1000, now), false, "checked a second ago")
  assert.equal(nudgeDue(now - NUDGE_EVERY_MS, now), true, "the interval has passed")
  assert.ok(NUDGE_EVERY_MS >= 60000, "never more than once a minute")
})

// ---------------------------------------------------------------------------
// Probe verdicts, and the confirmation a run's sign-out verdict needs
// ---------------------------------------------------------------------------

test("a probe is signed out only on the vendor's own sentence; a timeout or an overload is unknown", async () => {
  const { probeVerdict } = await import("../src/engine.js")
  assert.equal(probeVerdict({ code: 0, stderr: "", stdout: "ok" }).status, "ready")
  assert.equal(probeVerdict({ code: 1, stderr: "Not logged in · Please run /login", stdout: "" }).status, "logged_out")
  assert.equal(probeVerdict({ code: 1, stderr: "Invalid API key · Please run /login", stdout: "" }).status, "logged_out")
  assert.equal(probeVerdict({ code: 1, stderr: "OAuth token has expired", stdout: "" }).status, "logged_out")
  // "author" contains "auth"; the first pattern read this as a sign-out.
  const overloaded = probeVerdict({ code: 1, stderr: "API Error: 529 overloaded_error (request author: cli)", stdout: "" })
  assert.equal(overloaded.status, "unknown")
  assert.match(overloaded.detail, /529/)
  assert.equal(probeVerdict({ code: 1, stderr: "You've hit your limit · resets 4pm", stdout: "" }).status, "unknown")
  assert.equal(probeVerdict({ code: null, stderr: "", stdout: "" }).status, "unknown")
})

test("a run's needs_login verdict survives only a probe that agrees", async () => {
  const { confirmLoginVerdict } = await import("../src/runner.js")
  const verdict = { state: "needs_login", detail: "401 authentication_error" }
  assert.deepEqual(confirmLoginVerdict(verdict, { status: "logged_out" }), verdict)
  assert.equal(confirmLoginVerdict(verdict, { status: "ready" }), null)
  assert.equal(confirmLoginVerdict(verdict, { status: "unknown" }), null)
  assert.equal(confirmLoginVerdict(verdict, undefined), null)
  // Other verdicts pass through untouched: only the blocking one is confirmed.
  assert.deepEqual(confirmLoginVerdict({ state: "rate_limited" }, { status: "ready" }), { state: "rate_limited" })
  assert.equal(confirmLoginVerdict(null, { status: "ready" }), null)
})

// ---------------------------------------------------------------------------
// A broken install: the CLI that exists but cannot start
// ---------------------------------------------------------------------------

test("the npm wrapper's launcher error is a broken runtime, not a login or vendor problem", () => {
  // The exact words that looped a cloud machine for a day: npm skipped the
  // failed optional dependency, the wrapper landed on the PATH, and every
  // spawn died with this. No other rule may claim it.
  const wrapper = classifySubscription(
    "Error: claude native binary not installed. Either postinstall did not run (--ignore-scripts, some pnpm configs) " +
    "or the platform-native optional dependency was not downloaded (--omit=optional). " +
    "Run the postinstall manually: node node_modules/@anthropic-ai/claude-code/install.cjs"
  )
  assert.equal(wrapper.state, "runtime_broken")

  // The engine's own sentence for a binary that is nowhere at all.
  assert.equal(classifySubscription("Claude Code isn't installed on this machine, or isn't on PATH.").state, "runtime_broken")
  // The runner's hosted refusal round-trips to the same verdict.
  assert.equal(classifySubscription("Claude Code is missing from this cloud machine.").state, "runtime_broken")
})

test("install-shaped words do not swallow the verdicts that are about the plan", () => {
  // Nothing about these is an install problem; the first rule must not grab them.
  assert.equal(classifySubscription("You've hit your usage limit · resets at 3pm").state, "rate_limited")
  assert.equal(classifySubscription("Not logged in · Please run /login").state, "needs_login")
  assert.equal(classifySubscription("card was declined").state, "payment")
})

test("runtime health answers runs-or-not, with the runtime's own last words", async () => {
  const { runtimeHealth } = await import("../src/hosted.js")

  const binDir = path.join(HOME, "health-bins")
  fs.mkdirSync(binDir, { recursive: true })
  const okBin = path.join(binDir, "ok-cli")
  fs.writeFileSync(okBin, "#!/bin/sh\necho 1.2.3\nexit 0\n", { mode: 0o755 })
  const brokenBin = path.join(binDir, "broken-cli")
  fs.writeFileSync(brokenBin, "#!/bin/sh\necho 'Error: fake native binary not installed' >&2\nexit 1\n", { mode: 0o755 })

  const fake = (bin) => ({ name: "Fake CLI", versionArgs: ["--version"], resolveBin: () => ({ bin }) })

  assert.equal((await runtimeHealth(fake(okBin))).status, "ok")

  const broken = await runtimeHealth(fake(brokenBin))
  assert.equal(broken.status, "broken")
  assert.match(broken.detail, /native binary not installed/)
  // The detail is what hosted_status.js classifies — the loop only closes if
  // the health check's own words carry the verdict.
  assert.equal(classifySubscription(broken.detail).state, "runtime_broken")

  const missing = await runtimeHealth({ name: "Fake CLI", versionArgs: ["--version"], resolveBin: () => ({ bin: null }) })
  assert.equal(missing.status, "missing")

  assert.equal((await runtimeHealth(null)).status, "unknown")
})

test("a repair is not retried inside its window", async () => {
  const { repairTriedRecently, REPAIR_RETRY_MS } = await import("../src/hosted.js")
  const now = Date.now()
  assert.equal(repairTriedRecently({ repair_at: new Date(now - REPAIR_RETRY_MS + 60000).toISOString() }, now), true)
  assert.equal(repairTriedRecently({ repair_at: new Date(now - REPAIR_RETRY_MS - 60000).toISOString() }, now), false)
  assert.equal(repairTriedRecently({}, now), false)
  assert.equal(repairTriedRecently(undefined, now), false)
  assert.equal(repairTriedRecently({ repair_at: "not a date" }, now), false)
})

test("the refusal for a missing CLI sends a laptop's owner and a cloud machine to different places", async () => {
  const { installRefusal } = await import("../src/runner.js")
  const runtime = { name: "Claude Code", install: "https://claude.com/product/claude-code" }

  // Hosted (CMA_HOSTED=1 is staged above): nobody can run a terminal
  // command here, so the message says the machine repairs itself and the
  // refusal carries the verdict that stops dispatch.
  const hosted = installRefusal(runtime, {})
  assert.match(hosted.message, /reinstalls itself/)
  assert.doesNotMatch(hosted.message, /runtimes:scan/)
  assert.equal(hosted.subscription.state, "runtime_broken")
  assert.equal(classifySubscription(hosted.subscription.detail).state, "runtime_broken")

  // A laptop keeps the install link and the rescan command, and no verdict.
  delete process.env.CMA_HOSTED
  try {
    const laptop = installRefusal(runtime, {})
    assert.match(laptop.message, /Install it from/)
    assert.match(laptop.message, /runtimes:scan/)
    assert.equal(laptop.subscription, null)
  } finally {
    process.env.CMA_HOSTED = "1"
  }

  // A runtime this build has never heard of is an update problem, not an
  // install problem, on both kinds of machine.
  const unknown = installRefusal(null, { runtime: "newfangled" })
  assert.match(unknown.message, /can't drive "newfangled"/)
  assert.equal(unknown.subscription, null)
})
