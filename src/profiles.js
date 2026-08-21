import fs from "node:fs"

import { readConfig, writeConfig, profileDir, slugify, ensureDirs } from "./config.js"
import { probeProfile, profileAccount, runtimeModels as modelsOf, runtimeVersion } from "./engine.js"
import { maskAccount } from "./runtimes/shared.js"
import { DEFAULT_RUNTIME, getRuntime, installedRuntimes, isInstalled, RUNTIMES } from "./runtimes/index.js"

// Re-exported so callers that only care about "what does this machine run"
// don't each import the registry.
export { DEFAULT_RUNTIME, RUNTIMES, getRuntime, installedRuntimes, isInstalled }

// A profile is one login for one runtime on this machine, isolated in that
// runtime's own config directory. The registry below is just our index of them
// — the vendor CLI owns whatever lives inside each directory.
//
// The empty slug is meaningful: it is the ambient login, the one you get by
// running the CLI with no config-directory override set. Most people have
// exactly that and nothing else, and it should work with no setup at all.
//
// Cursor is the exception and says so on its adapter (`ambientProfile: false`):
// the file that bounds what a Cursor run may do has to live in a directory we
// own, so even its default login is a managed one.
export const DEFAULT_PROFILE = { slug: "", label: "Default" }

// Stored profiles are a flat list carrying their runtime, rather than a map
// keyed by it, because that is the shape the server already speaks and because
// migrating an existing config.json is then a matter of filling in a default
// rather than restructuring anything.
export function listProfiles(runtime = null) {
  const all = (readConfig().profiles || []).map((profile) => ({
    ...profile,
    runtime: profile.runtime || DEFAULT_RUNTIME
  }))

  if (!runtime) return all
  return all.filter((profile) => profile.runtime === runtimeIdOf(runtime))
}

function runtimeIdOf(runtime) {
  return typeof runtime === "string" ? runtime : runtime.id
}

export function addProfile(runtimeId, label, { account } = {}) {
  ensureDirs()

  const runtime = getRuntime(runtimeId)
  if (!runtime) throw new Error(`Unknown runtime "${runtimeId}".`)
  if (runtime.multiLogin === false) {
    throw new Error(
      `${runtime.name} keeps one login per machine, so there is nothing to add. ` +
      `Sign in with: ${runtime.loginHint}`
    )
  }

  const slug = slugify(label)
  if (!slug) throw new Error('Give the login a label, e.g. --label "Work"')

  const profiles = listProfiles()
  if (profiles.some((p) => p.slug === slug && p.runtime === runtime.id)) {
    throw new Error(
      `A ${runtime.name} login called "${label}" already exists. Use a different label, ` +
      `or sign it in again with \`cma-agent runtimes:login --runtime ${runtime.id} --profile ${slug}\`.`
    )
  }

  fs.mkdirSync(profileDir(runtime, slug), { recursive: true, mode: 0o700 })

  const profile = {
    runtime: runtime.id,
    slug,
    label,
    // Optional and user-supplied — we never read it out of the vendor CLI's
    // files. It exists only so two logins are distinguishable in a dropdown,
    // which is why it's masked before it ever leaves the machine.
    account_hint: account ? maskAccount(account) : null,
    created_at: new Date().toISOString()
  }

  writeConfig({ profiles: [...profiles, profile] })
  return profile
}

export function removeProfile(runtimeId, slug) {
  const runtime = getRuntime(runtimeId)
  if (!runtime) throw new Error(`Unknown runtime "${runtimeId}".`)

  const profiles = listProfiles()
  const next = profiles.filter((p) => !(p.slug === slug && p.runtime === runtime.id))
  if (next.length === profiles.length) throw new Error(`No ${runtime.name} login called "${slug}".`)

  // Removing the login means removing its credential, so the directory goes
  // too — leaving it behind would keep a usable session on disk for a profile
  // the user believes they deleted.
  fs.rmSync(profileDir(runtime, slug), { recursive: true, force: true })
  writeConfig({ profiles: next })
}

// Probe every known login on every INSTALLED runtime, and build the report the
// server stores.
//
// Scoped to installed runtimes on purpose: probing a CLI that isn't there
// costs a spawn per profile and reports "logged out" for something the user
// never claimed to have. A runtime that isn't installed simply contributes no
// profiles, and `cma-agent status` is where the absence is explained.
//
// The ambient login is always included for runtimes that have one: someone who
// never ran `runtimes:add` still gets a working "Default" without knowing this
// feature exists.
export async function scanProfiles() {
  const report = []

  for (const runtime of installedRuntimes()) {
    for (const profile of [DEFAULT_PROFILE, ...listProfiles(runtime)]) {
      const probe = await probeProfile(runtime, profile.slug)
      const account = accountFor(runtime, profile.slug, profile)
      report.push({
        runtime: runtime.id,
        slug: profile.slug || "default",
        label: profile.label,
        status: probe.status,
        // Why it is not ready, in the runtime's own words. Carried to the
        // server because "Ollama is running but has no models pulled" is a
        // one-command fix, and the web app showing a bare "Unknown" sends
        // people to check a laptop that is working fine.
        detail: probe.detail || null,
        // Which account this login actually resolves to, read back from the
        // runtime's own settings rather than taken from the label. This is
        // what lets the web app say "Claude Code (account: you@acme.com)" on
        // a run instead of leaving you to infer it from a name you chose
        // months ago. Suppressed to the masked form by
        // CMA_HIDE_ACCOUNT_EMAIL — see accountFor.
        account_email: account.email,
        account_hint: account.hint,
        account_source: account.source,
        last_verified_at: new Date().toISOString()
      })
    }
  }

  return report
}

// The versions of every installed runtime, for the heartbeat. A map rather
// than one string, because a machine can hold Claude Code AND Cursor and the
// server wants to know which builds it is actually talking to.
export async function runtimeVersions() {
  const versions = {}

  for (const runtime of installedRuntimes()) {
    const version = await runtimeVersion(runtime)
    if (version) versions[runtime.id] = version
  }

  return versions
}

// The models this machine can actually run, for the runtimes where only this
// machine knows.
//
// Every hosted vendor has a catalogue the server can hold. A model somebody
// pulled onto their own disk does not exist anywhere else, so the picker in
// the web app is empty unless the machine says what it has. Keyed by runtime
// and omitted entirely for the runtimes with a curated list, so this map is
// exactly "what the server could not have known".
export async function runtimeModels() {
  const models = {}

  for (const runtime of installedRuntimes()) {
    const names = await modelsOf(runtime)
    if (names.length > 0) models[runtime.id] = names
  }

  return models
}

// The server addresses the ambient login as "default"; locally it is the empty
// slug, because empty means "set no config-directory override at all".
export function resolveSlug(reportedSlug) {
  if (!reportedSlug || reportedSlug === "default") return ""
  return reportedSlug
}

// ---------------------------------------------------------------------------
// Which account a login resolves to.
//
// Three sources, in order of how much they are worth believing:
//
//   1. what the runtime resolved  — read out of its own settings file. The
//      only one that can catch two profiles collapsing into one account.
//   2. what you told us           — `runtimes:add --account you@work.com`.
//      A note to yourself; it cannot be wrong about the label because it IS
//      the label, and it cannot be right about the account either.
//   3. nothing                    — an honest answer, and the display says so.
//
// CMA_HIDE_ACCOUNT_EMAIL=1 keeps the address on this machine: the masked hint
// still travels, so the web app can still tell two logins apart, and this
// machine's own terminal still prints the address in full. What is reported is
// a choice; what you can see locally is not something we should be deciding.
// ---------------------------------------------------------------------------
export function accountFor(runtime, slug, profile = null) {
  const resolved = profileAccount(runtime, slug)
  const stored = (profile || listProfiles(runtime).find((p) => p.slug === slug))?.account_hint || null

  if (!resolved) return { email: null, hint: stored, source: stored ? "declared" : null }

  // An API-key login has no address to show, and saying so matters: it spends
  // per-token billing rather than a Claude plan.
  if (!resolved.email) return { email: null, hint: null, source: resolved.source || null }

  return {
    email: hideAccountEmail() ? null : resolved.email,
    hint: maskAccount(resolved.email),
    source: resolved.source || null
  }
}

// One line for a terminal or a thinking log — "account: you@acme.com" — or
// null when this machine genuinely cannot tell, because a confident wrong
// answer here is worse than no answer.
export function describeAccount(runtime, slug, profile = null) {
  const account = accountFor(runtime, slug, profile)
  if (account.source === "api_key") return "account: an Anthropic API key"

  const shown = account.email || account.hint
  return shown ? `account: ${shown}` : null
}

// Logins that resolve to the SAME account.
//
// The failure this whole feature exists to catch: two labels, one
// subscription, and nothing on screen saying so. On macOS it happens through
// the Keychain, which a per-profile config directory does not always isolate
// — so it is not exotic, it is the default way this goes wrong.
//
// Grouped per runtime: a Claude Code login and a Cursor login can legitimately
// belong to the same person's address without sharing anything at all.
export function duplicateAccounts(profiles) {
  const groups = new Map()

  for (const profile of profiles) {
    const account = profile.account_email || profile.account_hint
    if (!account) continue

    const key = `${profile.runtime}:${account}`
    groups.set(key, [...(groups.get(key) || []), profile])
  }

  return [...groups.entries()]
    .filter(([, group]) => group.length > 1)
    .map(([key, group]) => ({ account: key.slice(key.indexOf(":") + 1), profiles: group }))
}

function hideAccountEmail() {
  return /^(1|true|yes)$/i.test(String(process.env.CMA_HIDE_ACCOUNT_EMAIL || ""))
}
