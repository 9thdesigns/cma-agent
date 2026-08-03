import fs from "node:fs"
import os from "node:os"
import path from "node:path"

// Everything the companion keeps lives under one directory, so uninstalling is
// `rm -rf` on a single path. Two kinds of thing live here and they are
// deliberately separate:
//
//   config.json          — our device token and server URL. Ours to manage.
//   claude-profiles/<s>/ — one CLAUDE_CONFIG_DIR per Claude login. Claude
//                          Code's to manage; we only ever set the env var and
//                          let it write whatever it wants inside.
//
// We never read the contents of a profile directory looking for tokens. The
// separation is the security property, and rummaging in there would quietly
// give it up.
export const HOME = process.env.CMA_AGENT_HOME || path.join(os.homedir(), ".configure-my-ai")
export const CONFIG_PATH = path.join(HOME, "config.json")
export const PROFILES_DIR = path.join(HOME, "claude-profiles")

const DEFAULT_SERVER = "https://configuremyai.com"

export function ensureDirs() {
  fs.mkdirSync(HOME, { recursive: true, mode: 0o700 })
  fs.mkdirSync(PROFILES_DIR, { recursive: true, mode: 0o700 })
}

export function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"))
  } catch (_error) {
    return {}
  }
}

export function writeConfig(patch) {
  ensureDirs()
  const next = { ...readConfig(), ...patch }
  // 0600 because this file holds the device token. It is not a Claude
  // credential — it only lets this machine talk to Configure My AI — but it is
  // still a bearer token and shouldn't be world-readable.
  fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
  return next
}

export function serverUrl() {
  return (process.env.CMA_SERVER_URL || readConfig().server || DEFAULT_SERVER).replace(/\/+$/, "")
}

export function deviceToken() {
  return process.env.CMA_DEVICE_TOKEN || readConfig().token || null
}

export function requireToken() {
  const token = deviceToken()
  if (!token) {
    throw new Error("This machine isn't paired yet. Run `cma-agent pair` first.")
  }
  return token
}

export function profileDir(slug) {
  return path.join(PROFILES_DIR, slug)
}

export function slugify(label) {
  return String(label)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
}
