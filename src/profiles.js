import fs from "node:fs"

import { readConfig, writeConfig, profileDir, slugify, ensureDirs } from "./config.js"
import { probeProfile } from "./claude.js"

// The runtime this companion release can drive. Reported with every profile so
// the server can tell a Claude Code login from a Codex one on the same machine
// — and so a credential pinned to one runtime never gets handed the other's.
export const RUNTIME = "claude_code"

// A profile is one Claude Code login on this machine, isolated in its own
// CLAUDE_CONFIG_DIR. The registry below is just our index of them — Claude Code
// owns whatever lives inside each directory.
//
// The empty slug is meaningful: it is the ambient login, the one you get by
// running `claude` with no CLAUDE_CONFIG_DIR set. Most people have exactly that
// and nothing else, and it should work with no setup at all.
export const DEFAULT_PROFILE = { slug: "", label: "Default" }

export function listProfiles() {
  return readConfig().profiles || []
}

export function addProfile(label, { account } = {}) {
  ensureDirs()

  const slug = slugify(label)
  if (!slug) throw new Error("Give the login a label, e.g. --label \"Work\"")

  const profiles = listProfiles()
  if (profiles.some((p) => p.slug === slug)) {
    throw new Error(`A login called "${label}" already exists. Use a different label, or sign it in again with \`cma-agent claude:login --profile ${slug}\`.`)
  }

  fs.mkdirSync(profileDir(slug), { recursive: true, mode: 0o700 })

  const profile = {
    slug,
    label,
    // Optional and user-supplied — we never read it out of Claude Code's
    // files. It exists only so two logins are distinguishable in a dropdown,
    // which is why it's masked before it ever leaves the machine.
    account_hint: account ? maskAccount(account) : null,
    created_at: new Date().toISOString()
  }

  writeConfig({ profiles: [...profiles, profile] })
  return profile
}

export function removeProfile(slug) {
  const profiles = listProfiles()
  const next = profiles.filter((p) => p.slug !== slug)
  if (next.length === profiles.length) throw new Error(`No login called "${slug}".`)

  // Removing the login means removing its credential, so the directory goes
  // too — leaving it behind would keep a usable Claude session on disk for a
  // profile the user believes they deleted.
  fs.rmSync(profileDir(slug), { recursive: true, force: true })
  writeConfig({ profiles: next })
}

// Probe every known login and build the report the server stores.
//
// The ambient login is always included: someone who never ran `claude:add`
// still gets a working "Default" without knowing this feature exists.
export async function scanProfiles() {
  const known = listProfiles()
  const candidates = [DEFAULT_PROFILE, ...known]
  const report = []

  for (const profile of candidates) {
    const probe = await probeProfile(profile.slug)
    report.push({
      runtime: RUNTIME,
      slug: profile.slug || "default",
      label: profile.label,
      status: probe.status,
      account_hint: profile.account_hint || null,
      last_verified_at: new Date().toISOString()
    })
  }

  return report
}

// The server addresses the ambient login as "default"; locally it is the empty
// slug, because empty means "set no CLAUDE_CONFIG_DIR at all".
export function resolveSlug(reportedSlug) {
  if (!reportedSlug || reportedSlug === "default") return ""
  return reportedSlug
}

function maskAccount(value) {
  const [user, domain] = String(value).split("@")
  if (!domain) return `${String(value).slice(0, 1)}•••`
  return `${user.slice(0, 1)}•••@${domain}`
}
