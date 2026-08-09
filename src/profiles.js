import fs from "node:fs"

import { readConfig, writeConfig, profileDir, slugify, ensureDirs } from "./config.js"
import { probeProfile, runtimeVersion } from "./engine.js"
import { DEFAULT_RUNTIME, getRuntime, installedRuntimes, RUNTIMES } from "./runtimes/index.js"

// Re-exported so callers that only care about "what does this machine run"
// don't each import the registry.
export { DEFAULT_RUNTIME, RUNTIMES, getRuntime, installedRuntimes }

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
      report.push({
        runtime: runtime.id,
        slug: profile.slug || "default",
        label: profile.label,
        status: probe.status,
        account_hint: profile.account_hint || null,
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

// The server addresses the ambient login as "default"; locally it is the empty
// slug, because empty means "set no config-directory override at all".
export function resolveSlug(reportedSlug) {
  if (!reportedSlug || reportedSlug === "default") return ""
  return reportedSlug
}

function maskAccount(value) {
  const [user, domain] = String(value).split("@")
  if (!domain) return `${String(value).slice(0, 1)}•••`
  return `${user.slice(0, 1)}•••@${domain}`
}
