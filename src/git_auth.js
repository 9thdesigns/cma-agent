import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { isHosted } from "./hosted_status.js"

// How git authenticates on a machine Configure My AI RUNS.
//
// A laptop pushes and clones with its owner's own git credentials, and this
// app never sends it any — that boundary is the design of local repositories
// (docs/internal/local-repositories.md) and it stays. A cloud machine is
// ours: it has no git credentials and nobody at it to log in. So its git
// asks the app for one, through an askpass helper that calls the session's
// operations endpoint with the session's own token, at the moment a clone,
// fetch or push needs it (Code::GithubOps#git_credential). The credential
// lives in one git process for one command: never written here, never an
// argument, never in a job payload.
//
// `gitEnvFor` answers {} on a laptop whatever the server sent, and the
// server refuses the credential to anything but a hosted machine, so the
// laptop boundary holds from both ends.
//
// Resolved at call time rather than through config.js on purpose: config.js
// fixes the agent home once at import, and this module is pulled in by the
// runtime adapters, which tests import before they stage a home.
function agentHome() {
  return process.env.CMA_AGENT_HOME || path.join(os.homedir(), ".configure-my-ai")
}

export function askpassPath() {
  return path.join(agentHome(), "bin", "cma-git-askpass")
}

// Holds no secret: the endpoint and token arrive in git's environment for
// that one command, and the password is fetched fresh each time git asks.
export const ASKPASS_SCRIPT = `#!/bin/sh
# Written by cma-agent. Asks Configure My AI for this run's git credential.
[ -n "$CMA_GITHUB_ENDPOINT" ] && [ -n "$CMA_GITHUB_TOKEN" ] || exit 1
case "$1" in
  *sername*) echo "x-access-token" ;;
  *) curl -sf -X POST -H "Authorization: Bearer $CMA_GITHUB_TOKEN" -H "Accept: application/json" \\
       "$CMA_GITHUB_ENDPOINT/git.credential" \\
     | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);if(j&&j.password)process.stdout.write(j.password)}catch{}})' ;;
esac
`

export function ensureAskpass() {
  const target = askpassPath()
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 })
  let current = null
  try { current = fs.readFileSync(target, "utf8") } catch { /* first time */ }
  if (current !== ASKPASS_SCRIPT) fs.writeFileSync(target, ASKPASS_SCRIPT, { mode: 0o700 })
  try { fs.chmodSync(target, 0o700) } catch { /* best effort */ }
  return target
}

// The environment a git command needs to authenticate on a hosted machine,
// or {} — on a laptop always {}, whatever the server sent.
export function gitEnvFor(ops) {
  if (!isHosted()) return {}
  const endpoint = String(ops?.endpoint || "").replace(/\/+$/, "")
  const token = String(ops?.token || "")
  if (!endpoint || !token) return {}
  return {
    GIT_ASKPASS: ensureAskpass(),
    GIT_TERMINAL_PROMPT: "0",
    CMA_GITHUB_ENDPOINT: endpoint,
    CMA_GITHUB_TOKEN: token
  }
}
