import { claudeCode } from "./claude-code.js"
import { cursor } from "./cursor.js"
import { gemini } from "./gemini.js"
import { ollama } from "./ollama.js"

// Every CLI this companion can drive.
//
// The registry is the whole of "which runtimes exist". `runner.js` refuses a
// job whose runtime is not in here, `profiles.js` scans each one for logins,
// and the server is told the set — so adding the next vendor is a file in this
// directory plus one line here, and nothing else in the companion changes.
//
// Order matters only for display: it is the order `cma-agent status` lists
// them in, and Claude Code goes first because it is what most machines have.
// Ollama goes last because it is the odd one out — not a subscription this
// machine spends but a model it owns, reached over HTTP rather than spawned.
export const RUNTIMES = [claudeCode, cursor, gemini, ollama]

// The runtime a job means when it doesn't say. Older servers predate
// multi-runtime support and send no `runtime` at all; treating that as Claude
// Code is what keeps an old server working against a new companion.
export const DEFAULT_RUNTIME = claudeCode.id

export function getRuntime(id) {
  if (!id) return claudeCode
  return RUNTIMES.find((runtime) => runtime.id === String(id)) || null
}

export function runtimeIds() {
  return RUNTIMES.map((runtime) => runtime.id)
}

// Is this runtime a subprocess we spawn, or an endpoint we call? Everything
// that isn't told otherwise is a CLI, so an adapter written before this
// existed keeps its old meaning without saying anything.
export function isHttpRuntime(runtime) {
  return runtime?.transport === "http"
}

// "Is this runtime present on this machine?" — a question only the adapter can
// answer, because for a CLI it means a binary and for Ollama it means a server
// that may not even be on this host. The default is the historical one, so
// only the adapters that need to say something different do.
export function isInstalled(runtime) {
  if (!runtime) return false
  if (typeof runtime.isAvailable === "function") return !!runtime.isAvailable()
  return !!runtime.resolveBin().bin
}

// The ones actually present on this machine. This is what separates "we can't
// drive that" from "you haven't installed it" — two answers a user needs to
// tell apart, and the reason `status` reports both.
export function installedRuntimes() {
  return RUNTIMES.filter(isInstalled)
}
