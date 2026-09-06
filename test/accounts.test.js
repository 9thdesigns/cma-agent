// Which Claude account a login actually resolves to.
//
// The label on a profile is what somebody typed; the account is what the CLI
// will sign in as, and the entire value of holding two logins is that those
// two facts can be checked against each other. Two profiles quietly collapsing
// into one account bills the wrong plan and looks, on screen, exactly like
// working correctly — so every branch of the resolution is asserted here
// rather than trusted.
//
// Run with: node --test "agent/test/*.test.js"

import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { accountFromSettings, readAccount, describeAccount as describeClaudeAccount } from "../src/runtimes/claude-code.js"
import { maskAccount } from "../src/runtimes/shared.js"
import { getRuntime } from "../src/runtimes/index.js"

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cma-account-test-"))
}

// A config directory with Claude Code's own settings file in it, which is what
// a signed-in profile looks like from the outside.
function stageProfile(email) {
  const dir = tempDir()
  fs.writeFileSync(path.join(dir, ".claude.json"), JSON.stringify({
    oauthAccount: { emailAddress: email, organizationUuid: "org-1", accountUuid: "acc-1" },
    // Deliberately present: the reader must walk past everything that isn't
    // the account, and a test file with only the account in it would prove
    // nothing about that.
    projects: { "/somewhere": { history: [] } }
  }))
  return dir
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

test("the account comes out of Claude Code's own settings file", () => {
  const account = accountFromSettings({
    oauthAccount: { emailAddress: " you@acme.com ", organizationUuid: "org-9", accountUuid: "acc-9" }
  })

  assert.equal(account.email, "you@acme.com")
  assert.equal(account.organizationUuid, "org-9")
  assert.equal(account.source, "oauth")
})

test("no account in the file means no answer, not a wrong one", () => {
  assert.equal(accountFromSettings({}), null)
  assert.equal(accountFromSettings({ oauthAccount: {} }), null)
  assert.equal(accountFromSettings({ oauthAccount: { emailAddress: "  " } }), null)
  assert.equal(accountFromSettings(null), null)
})

test("a profile directory is read, and a missing one is survivable", () => {
  const dir = stageProfile("work@acme.com")
  assert.equal(readAccount({ configDir: dir }).email, "work@acme.com")

  const empty = tempDir()
  // No settings file at all. The ambient fallbacks must not rescue a profile
  // that was explicitly pointed somewhere — a directory with nothing in it is
  // a login that has not been signed in, and saying "you@personal.com" there
  // would be the exact confusion this feature exists to prevent.
  const previous = process.env.ANTHROPIC_API_KEY
  delete process.env.ANTHROPIC_API_KEY
  try {
    assert.equal(readAccount({ configDir: empty }), null)
  } finally {
    if (previous !== undefined) process.env.ANTHROPIC_API_KEY = previous
  }
})

test("unreadable or corrupt settings are a shrug, never a throw", () => {
  const dir = tempDir()
  fs.writeFileSync(path.join(dir, ".claude.json"), "{ not json at all")
  assert.doesNotThrow(() => readAccount({ configDir: dir }))
  assert.equal(readAccount({ configDir: dir }), null)
})

test("an API key login is named as one, because it spends different money", () => {
  const dir = tempDir()
  const previous = process.env.ANTHROPIC_API_KEY
  process.env.ANTHROPIC_API_KEY = "sk-ant-not-a-real-key"
  try {
    const account = readAccount({ configDir: dir })
    assert.equal(account.source, "api_key")
    assert.equal(account.email, null)
    assert.equal(describeClaudeAccount(account), "account: an Anthropic API key")
  } finally {
    if (previous === undefined) delete process.env.ANTHROPIC_API_KEY
    else process.env.ANTHROPIC_API_KEY = previous
  }
})

// ---------------------------------------------------------------------------
// What leaves the machine
// ---------------------------------------------------------------------------

test("the masked hint keeps the domain and drops the name", () => {
  assert.equal(maskAccount("david@acme.com"), "d•••@acme.com")
  assert.equal(maskAccount("nodomain"), "n•••")
  assert.equal(maskAccount(""), null)
  assert.equal(maskAccount(null), null)
})

// profiles.js reads config.json out of CMA_AGENT_HOME, and config.js resolves
// that ONCE at import time — so the home is staged before the import and every
// case below varies the logins inside it rather than the home itself. (An
// earlier version of this file cache-busted the import instead; config.js kept
// its first home, and the fallback case silently read the previous case's
// login. The test passed for the wrong reason, which is the failure mode this
// whole feature is about.)
const AGENT_HOME = tempDir()
process.env.CMA_AGENT_HOME = AGENT_HOME
fs.mkdirSync(path.join(AGENT_HOME, "claude-profiles"), { recursive: true })

const profiles = await import("../src/profiles.js")
const claude = getRuntime("claude_code")

// `logins` is what config.json holds; `signedIn` is which of them have an
// account in their config directory. Keeping the two separate is the point:
// a login can exist and not resolve, which is precisely the state worth
// reporting.
function stage(logins, signedIn = {}) {
  fs.writeFileSync(path.join(AGENT_HOME, "config.json"), JSON.stringify({ profiles: logins }))

  fs.rmSync(path.join(AGENT_HOME, "claude-profiles"), { recursive: true, force: true })
  for (const [slug, email] of Object.entries(signedIn)) {
    const dir = path.join(AGENT_HOME, "claude-profiles", slug)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: email } }))
  }
}

// Runs `body` with no ambient API key, so "we couldn't tell" is not quietly
// answered by this machine's environment.
function withoutApiKey(body) {
  const previous = process.env.ANTHROPIC_API_KEY
  delete process.env.ANTHROPIC_API_KEY
  try {
    return body()
  } finally {
    if (previous !== undefined) process.env.ANTHROPIC_API_KEY = previous
  }
}

const TWO_LOGINS = [
  { runtime: "claude_code", slug: "work", label: "Work" },
  { runtime: "claude_code", slug: "personal", label: "Personal" }
]

test("two logins resolve to their own accounts", () => {
  stage(TWO_LOGINS, { work: "dave@acme.com", personal: "dave@gmail.com" })

  assert.equal(profiles.describeAccount(claude, "work"), "account: dave@acme.com")
  assert.equal(profiles.describeAccount(claude, "personal"), "account: dave@gmail.com")
  assert.equal(profiles.accountFor(claude, "work").hint, "d•••@acme.com")
})

test("CMA_HIDE_ACCOUNT_EMAIL withholds the address but keeps the two tellable apart", () => {
  stage(TWO_LOGINS, { work: "dave@acme.com", personal: "dave@gmail.com" })

  const previous = process.env.CMA_HIDE_ACCOUNT_EMAIL
  process.env.CMA_HIDE_ACCOUNT_EMAIL = "1"
  try {
    const work = profiles.accountFor(claude, "work")
    assert.equal(work.email, null, "the address must not be reported")
    assert.equal(work.hint, "d•••@acme.com", "the masked hint still travels")
    // Locally it is still worth showing: this machine is the one place the
    // address was never a secret.
    assert.equal(profiles.describeAccount(claude, "work"), "account: d•••@acme.com")
  } finally {
    if (previous === undefined) delete process.env.CMA_HIDE_ACCOUNT_EMAIL
    else process.env.CMA_HIDE_ACCOUNT_EMAIL = previous
  }
})

test("a login we cannot read falls back to what the user declared", () => {
  stage([{ runtime: "claude_code", slug: "work", label: "Work", account_hint: "d•••@acme.com" }])

  withoutApiKey(() => {
    const account = profiles.accountFor(claude, "work")
    assert.equal(account.email, null)
    assert.equal(account.hint, "d•••@acme.com")
    assert.equal(account.source, "declared", "a note to yourself is not a resolved account")
  })
})

test("a login with nothing behind it reports nothing", () => {
  stage([{ runtime: "claude_code", slug: "work", label: "Work" }])

  withoutApiKey(() => {
    assert.equal(profiles.describeAccount(claude, "work"), null)
    assert.deepEqual(profiles.accountFor(claude, "work"), { email: null, hint: null, source: null })
  })
})

// ---------------------------------------------------------------------------
// Two labels, one subscription
// ---------------------------------------------------------------------------

test("two logins on one account are named as the clash they are", () => {
  const clashes = profiles.duplicateAccounts([
    { runtime: "claude_code", slug: "work", label: "Work", account_email: "dave@acme.com" },
    { runtime: "claude_code", slug: "personal", label: "Personal", account_email: "dave@acme.com" },
    { runtime: "claude_code", slug: "other", label: "Other", account_email: "someone@else.com" }
  ])

  assert.equal(clashes.length, 1)
  assert.equal(clashes[0].account, "dave@acme.com")
  assert.deepEqual(clashes[0].profiles.map((p) => p.slug), ["work", "personal"])
})

test("the masked hint catches the same clash, since it is all an older companion sends", () => {
  const clashes = profiles.duplicateAccounts([
    { runtime: "claude_code", slug: "work", label: "Work", account_hint: "d•••@acme.com" },
    { runtime: "claude_code", slug: "personal", label: "Personal", account_hint: "d•••@acme.com" }
  ])

  assert.equal(clashes.length, 1)
})

test("the same address on two different runtimes is not a clash", () => {
  // One person, two vendors, two subscriptions. Nothing is shared and nothing
  // is wrong — flagging it would train people to ignore the warning.
  assert.deepEqual(profiles.duplicateAccounts([
    { runtime: "claude_code", slug: "work", label: "Work", account_email: "dave@acme.com" },
    { runtime: "cursor", slug: "work", label: "Work", account_email: "dave@acme.com" }
  ]), [])
})

test("logins with no account known are never reported as clashing", () => {
  assert.deepEqual(profiles.duplicateAccounts([
    { runtime: "claude_code", slug: "work", label: "Work" },
    { runtime: "claude_code", slug: "personal", label: "Personal" }
  ]), [])
})

test("a runtime that cannot name its account says so rather than guessing", () => {
  // Ollama has no login at all. Asking it who is signed in must produce
  // nothing — not the ambient Claude account that happens to be on this
  // machine, which would attribute a local model run to a Claude plan.
  const ollama = getRuntime("ollama")
  assert.equal(typeof ollama.readAccount, "undefined")
})
