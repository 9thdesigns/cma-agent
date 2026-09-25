import fs from "node:fs"
import path from "node:path"

import { HOME } from "./config.js"
import { isHosted } from "./hosted_status.js"

// A credential a hosted sign-in produced that the vendor's CLI does not keep
// for itself.
//
// Most runtimes write their own auth file when the no-browser sign-in
// completes, and the companion never touches it. Claude Code's headless
// flow (`claude setup-token`) is the exception: it PRINTS a long-lived
// token for use as CLAUDE_CODE_OAUTH_TOKEN and stores nothing. So on a
// cloud machine the companion keeps that token here — on the machine's
// persistent disk, mode 0600, beside its own config — and hands it to the
// CLI as that environment variable on every spawn. It is never sent
// anywhere; the server only ever learns that the sign-in worked.
export const AUTH_PATH = path.join(HOME, "hosted-auth.json")

// { "claude_code:default": { env: "CLAUDE_CODE_OAUTH_TOKEN", value: "…", saved_at } }
export function readAuth() {
  try {
    const parsed = JSON.parse(fs.readFileSync(AUTH_PATH, "utf8"))
    return parsed && typeof parsed === "object" ? parsed : {}
  } catch {
    return {}
  }
}

export function authKey(runtimeId, slug) {
  return `${runtimeId}:${slug || "default"}`
}

export function saveAuth(runtimeId, slug, envVar, value) {
  fs.mkdirSync(HOME, { recursive: true, mode: 0o700 })
  const next = { ...readAuth(), [authKey(runtimeId, slug)]: { env: envVar, value, saved_at: new Date().toISOString() } }
  fs.writeFileSync(AUTH_PATH, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
  return next
}

export function forgetAuth(runtimeId, slug) {
  const next = { ...readAuth() }
  delete next[authKey(runtimeId, slug)]
  fs.writeFileSync(AUTH_PATH, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
}

// The environment a spawn of this runtime under this login needs, or {}.
// Only ever non-empty on a cloud machine: a laptop's logins are the
// vendor's business and this file does not exist there.
export function hostedAuthEnv(runtime, slug) {
  if (!isHosted() || !runtime) return {}

  const entry = readAuth()[authKey(runtime.id, slug)]
  if (!entry || !entry.env || !entry.value) return {}
  return { [entry.env]: String(entry.value) }
}
