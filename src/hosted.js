import { spawn } from "node:child_process"
import fs, { accessSync, constants } from "node:fs"
import path from "node:path"

import { HOME } from "./config.js"

import * as api from "./api.js"
import { envForProfile, probeProfile, runtimeVersion } from "./engine.js"
import { runtimeCatalogue, scanProfiles, resolveSlug } from "./profiles.js"
import { getRuntime } from "./runtimes/index.js"
import { forgetAuth, saveAuth } from "./hosted_auth.js"
import { hostedRuntimeId, isHosted, LOGIN_KINDS } from "./hosted_status.js"
import { VERSION } from "./version.js"

export { isHosted, hostedRuntimeId, LOGIN_KINDS } from "./hosted_status.js"

// ---------------------------------------------------------------------------
// Hosted mode: what the companion does differently on a machine Configure My
// AI runs, rather than one its owner sits at.
//
//   * It STOPS when idle. The boot script that started it treats the exit as
//     "stop the machine", which is what makes an idle machine cost nothing;
//     the server starts the machine again when work arrives.
//   * It signs in by RELAY. There is no browser here, so the vendor's
//     no-browser flow is driven under a pseudo-terminal and whatever it prints
//     — a link, a code — is posted to the server for the person to act on,
//     and the code they paste back is written to the flow's stdin.
//   * It UPDATES itself. Once at boot and then daily, it asks the server
//     whether the runtime or the companion is behind, installs what is, and
//     exits with RESTART_EXIT_CODE so the boot script starts it again.
//
// Nothing here runs on a laptop: every entry point checks isHosted() first.
// ---------------------------------------------------------------------------

export const RESTART_EXIT_CODE = 75
export const IDLE_MS = Math.max(60000, Number(process.env.CMA_HOSTED_IDLE_MS || 10 * 60 * 1000))
export const UPDATE_EVERY_MS = 24 * 60 * 60 * 1000
export const IDLE_TICK_MS = 30000
// Updates are never applied in the first minute after boot. A sign-in or a
// run queued while the machine was waking is claimed in those seconds, and
// an install that restarts the companion underneath it would kill it —
// which is what a person pasting a code into a flow that had just been
// restarted saw as "that sign-in is no longer running".
export const BOOT_UPDATE_DELAY_MS = Math.max(0, Number(process.env.CMA_HOSTED_BOOT_UPDATE_DELAY_MS ?? 60000))
// An install that left the companion reporting the same version is not run
// again for this long. Without it a package that installs but does not
// replace the binary on the PATH — or an installer script with no version to
// compare — restarted the companion on every boot, forever.
export const UPDATE_RETRY_AFTER_MS = 6 * 60 * 60 * 1000
export const UPDATE_STATE_PATH = path.join(HOME, "hosted-updates.json")
// The heartbeat can say "a newer companion is out"; that is answered with a
// full check at most this often, so a server that keeps saying it (the
// mirror has not published yet, say) costs one plan request per interval.
export const NUDGE_EVERY_MS = 10 * 60 * 1000
export const LOGIN_TIMEOUT_MS = 15 * 60 * 1000
// Once the person's code is in, the vendor has this long to finish. A flow
// that is still sitting there afterwards did not take the code (or took it
// and is asking something nobody can see); the person is told, with the
// flow's last lines, rather than left on "checking".
export const CODE_TIMEOUT_MS = Math.max(15000, Number(process.env.CMA_HOSTED_CODE_TIMEOUT_MS || 2 * 60 * 1000))
// How long the vendor's flow gets to print its link. A flow that has shown
// nothing by then is not going to — the CLI is missing, refused to start,
// or is asking a question nobody can see — and the person is told so
// rather than left watching "starting".
export const LINK_TIMEOUT_MS = Math.max(15000, Number(process.env.CMA_HOSTED_LINK_TIMEOUT_MS || 90 * 1000))
const OUTPUT_LIMIT = 64 * 1024

// ---------------------------------------------------------------------------
// The sign-in relay.
//
// One plan per runtime: the vendor's no-browser flow, whether a code comes
// BACK from the person (Claude Code) or only goes out to them, whether the
// flow needs a terminal to draw in (Ink and Bubble Tea UIs refuse a pipe),
// and — for Claude Code — the token the flow prints, since that flow keeps
// nothing itself.
// ---------------------------------------------------------------------------
//
// `logoutArgs` is how a FAILED sign-in is undone: the vendor's own logout,
// so a half-finished flow never leaves a credential the next run trips on.
// Claude Code's token lives in the companion's own file and is forgotten
// there instead.
export const LOGIN_PLANS = {
  claude_code: {
    args: ["setup-token"],
    pasteCode: true,
    pty: true,
    tokenPattern: /sk-ant-oat01-[A-Za-z0-9_-]{20,}/,
    tokenEnv: "CLAUDE_CODE_OAUTH_TOKEN"
  },
  codex: { args: ["login", "--device-auth"], pasteCode: false, pty: false, logoutArgs: ["logout"] },
  cursor: { args: ["login"], pasteCode: false, pty: false, logoutArgs: ["logout"] },
  grok: { args: ["login", "--device-auth"], pasteCode: false, pty: true, logoutArgs: ["logout"] },
  antigravity: { args: [], pasteCode: false, pty: true }
}

const sessions = new Map()

// Terminal control sequences out, carriage returns to line breaks: a TUI
// redraws its frame many times, and only the words survive that.
export function stripAnsi(text) {
  return String(text || "")
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[()][A-Z0-9]/g, "")
    .replace(/\r\n?/g, "\n")
}

const URL_PATTERN = /https:\/\/[^\s"'<>`)\]]+/g
const LOOKS_LIKE_SIGN_IN = /oauth|auth|login|sign|device|activate|verify|code=|claude\.ai|anthropic\.com|openai\.com|chatgpt\.com|cursor\.(com|sh)|x\.ai|grok\.com|accounts\.google|google\.com\/device/i
const NOT_A_SIGN_IN = /docs\.|documentation|github\.com|npmjs|status\.|\/help\b/i

// The sign-in link in what the vendor printed, or null. A URL wrapped by a
// narrow terminal is joined back together: a line that ends mid-URL is
// continued by the next one when that line is nothing but URL characters.
export function findLoginUrl(raw) {
  const text = stripAnsi(raw)
  const lines = text.split("\n")
  const candidates = []

  for (let i = 0; i < lines.length; i += 1) {
    URL_PATTERN.lastIndex = 0
    let match
    while ((match = URL_PATTERN.exec(lines[i])) !== null) {
      let url = match[0]
      const endsLine = match.index + url.length >= lines[i].length
      let next = i + 1
      while (endsLine && next < lines.length && /^[A-Za-z0-9%&=_.~+\/?#:-]{6,}$/.test(lines[next].trim())) {
        url += lines[next].trim()
        next += 1
      }
      candidates.push(url.replace(/[.,;:]+$/, ""))
    }
  }

  if (candidates.length === 0) return null
  return candidates.find((url) => LOOKS_LIKE_SIGN_IN.test(url) && !NOT_A_SIGN_IN.test(url)) ||
         candidates.find((url) => !NOT_A_SIGN_IN.test(url)) ||
         null
}

// A one-time code the person must TYPE on the vendor's page (device flows):
// "enter code: ABCD-EFGH". Searched only after the link appeared, so a code
// the vendor prints for some other reason before it cannot be mistaken.
export function findUserCode(raw) {
  const text = stripAnsi(raw)
  const match = text.match(/\b([A-Z0-9]{4,6}-[A-Z0-9]{4,6})\b/) || text.match(/\b(?:code|enter)[:\s]+([A-Z0-9]{6,9})\b/i)
  return match ? match[1] : null
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`
}

function hasScript() {
  for (const candidate of ["/usr/bin/script", "/bin/script", "/usr/local/bin/script"]) {
    try {
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {
      // try the next
    }
  }
  return null
}

// Spawn the vendor's flow, under a pseudo-terminal when the plan asks for
// one and `script` is on the machine (it is: the bootstrap installs
// bsdutils). Wide, so a long link is not wrapped into pieces.
function spawnLogin(runtime, plan, env) {
  const { bin } = runtime.resolveBin()
  const executable = bin || runtime.cli
  const script = plan.pty ? hasScript() : null

  if (script) {
    const command = `stty cols 400 rows 60 2>/dev/null; exec ${shellQuote(executable)}${plan.args.map((a) => ` ${shellQuote(a)}`).join("")}`
    return spawn(script, ["-qfec", command, "/dev/null"], { env, stdio: ["pipe", "pipe", "pipe"] })
  }
  return spawn(executable, plan.args, { env, stdio: ["pipe", "pipe", "pipe"] })
}

// Begin a sign-in for a runtime and login; resolves as soon as the child is
// running. What the flow prints is relayed to the server as it appears.
export async function startLogin({ runtime: runtimeId, profile, session }, { log = () => {} } = {}) {
  const runtime = getRuntime(runtimeId || hostedRuntimeId())
  if (!runtime) throw new Error(`Unknown runtime "${runtimeId}".`)
  const plan = LOGIN_PLANS[runtime.id]
  if (!plan) throw new Error(`${runtime.name} has no sign-in this machine can relay.`)
  if (!session) throw new Error("A sign-in needs a session id.")

  // One at a time per machine. A second start replaces the first: the
  // person pressed the button again, and the old flow is answering a
  // question nobody is asking any more.
  for (const [id, existing] of sessions) {
    if (!existing.finished) finish(id, { status: "cancelled", detail: "replaced by a newer sign-in", report: false })
  }

  const slug = resolveSlug(profile, runtime)
  const env = { ...process.env, ...envForProfile(runtime, slug), TERM: "xterm-256color", BROWSER: "/bin/false", NO_BROWSER: "true" }
  // A stale token must not make the flow think it is already signed in.
  if (plan.tokenEnv) delete env[plan.tokenEnv]

  const child = spawnLogin(runtime, plan, env)
  const state = {
    session, runtime, slug, plan, child, log,
    output: "", urlSent: false, finished: false, startedAt: Date.now()
  }
  sessions.set(session, state)
  log(`→ ${runtime.name} sign-in started (session ${session.slice(0, 6)})`)

  const onData = (chunk) => {
    state.output = (state.output + String(chunk)).slice(-OUTPUT_LIMIT)
    relayLink(state)
    if (plan.tokenPattern && plan.tokenPattern.test(stripAnsi(state.output))) {
      // The token is on screen: the flow is done, whatever the process does
      // next (Claude Code's prints and exits; a REPL would sit there).
      finish(session, { status: "ready" })
    }
  }
  child.stdout.on("data", onData)
  child.stderr.on("data", onData)
  child.stdin.on("error", () => {})
  child.on("error", (error) => finish(session, { status: "failed", detail: `could not start ${runtime.name}: ${error.message}` }))
  child.on("close", (code) => {
    if (state.finished) return
    finish(session, code === 0 ? { status: "check" } : { status: "failed", detail: lastLines(state.output) })
  })
  state.timer = setTimeout(() => finish(session, { status: "failed", detail: "the sign-in was not completed in time" }), LOGIN_TIMEOUT_MS)
  state.linkTimer = setTimeout(() => {
    if (state.urlSent || state.finished) return
    const seen = lastLines(state.output)
    finish(session, { status: "failed", detail: seen ? `${runtime.name} did not show a sign-in link. It said: ${seen}` : `${runtime.name} did not show a sign-in link` })
  }, LINK_TIMEOUT_MS)

  return { started: true }
}

function relayLink(state) {
  if (state.urlSent) return
  const url = findLoginUrl(state.output)
  if (!url) return

  state.urlSent = true
  const after = stripAnsi(state.output).slice(stripAnsi(state.output).indexOf(url.slice(0, 40)))
  const userCode = state.plan.pasteCode ? null : findUserCode(after)
  state.log(`  · sign-in link ready${userCode ? ` (code ${userCode})` : ""} — sent to the web app`)
  api.hostedLogin({
    event: "url", session: state.session, url,
    code_required: state.plan.pasteCode, user_code: userCode
  }).catch((error) => state.log(`! Couldn't send the sign-in link: ${error.message}`))
}

function lastLines(output) {
  const lines = stripAnsi(output).split("\n").map((l) => l.trim()).filter(Boolean)
  return lines.slice(-3).join(" · ").slice(0, 300) || undefined
}

// The person pasted the vendor's code: hand it to the flow.
// What "Enter" is for a flow: a carriage return on a pseudo-terminal, where
// the vendor's text input reads raw keystrokes and a line feed is just a
// character it ignores (Claude Code's flow sat forever on the pasted code
// because of exactly that); a line feed on a pipe, where a line-reading
// flow expects one.
export function enterKeyFor(plan) {
  return plan && plan.pty ? "\r" : "\n"
}

export function submitLoginCode({ session, code }) {
  const state = sessions.get(session)
  if (!state || state.finished) throw new Error("That sign-in is no longer running. Start it again.")
  if (!state.plan.pasteCode) throw new Error(`${state.runtime.name} does not take a code here — approve the link instead.`)

  const text = String(code).trim()
  const enter = enterKeyFor(state.plan)
  // The code as one paste, then Enter as its own keystroke a beat later:
  // a raw-mode input that receives text and the return key in one chunk
  // can treat the whole thing as a paste and wait for more.
  state.child.stdin.write(text)
  setTimeout(() => { try { state.child.stdin.write(enter) } catch { /* flow ended */ } }, 150)
  state.log("  · code received — finishing the sign-in")

  clearTimeout(state.codeTimer)
  state.codeTimer = setTimeout(() => {
    if (state.finished) return
    const seen = lastLines(state.output)
    finish(session, { status: "failed", detail: seen ? `${state.runtime.name} did not finish the sign-in after the code was entered. It said: ${seen}` : `${state.runtime.name} did not finish the sign-in after the code was entered` })
  }, CODE_TIMEOUT_MS)
  return { ok: true }
}

export function cancelLogin({ session }) {
  const state = sessions.get(session)
  if (state && !state.finished) finish(session, { status: "cancelled", detail: "cancelled from the web app", report: false })
  return { ok: true }
}

// Close out a session: keep what the flow produced, check the login really
// works, tell the server, and re-report the logins so the provider appears.
async function finish(session, { status, detail, report = true }) {
  const state = sessions.get(session)
  if (!state || state.finished) return
  state.finished = true
  clearTimeout(state.timer)
  clearTimeout(state.linkTimer)
  clearTimeout(state.codeTimer)
  try { state.child.kill("SIGTERM") } catch { /* already gone */ }

  if (status === "cancelled") {
    state.log(`  · sign-in cancelled (${detail})`)
    return
  }

  try {
    if (state.plan.tokenPattern) {
      const token = stripAnsi(state.output).match(state.plan.tokenPattern)?.[0]
      if (token) saveAuth(state.runtime.id, state.slug, state.plan.tokenEnv, token)
    }

    let verdict = status
    if (status === "check" || status === "ready") {
      const probe = await probeProfile(state.runtime, state.slug)
      verdict = probe.status === "ready" ? "ready" : "failed"
      if (verdict === "failed") detail = probe.detail || detail || `${state.runtime.name} still reports ${String(probe.status).replace(/_/g, " ")}`
    }

    state.log(verdict === "ready" ? `✓ ${state.runtime.name} is signed in` : `✗ ${state.runtime.name} sign-in failed: ${detail || "unknown"}`)
    if (verdict !== "ready") await signOut(state)
    if (report) {
      await api.hostedLogin({ event: "finished", session, status: verdict, detail }).catch(() => {})
      await api.syncProfiles(await scanProfiles(), await runtimeCatalogue()).catch(() => {})
    }
  } catch (error) {
    state.log(`! Finishing the sign-in failed: ${error.message}`)
    if (report) await api.hostedLogin({ event: "finished", session, status: "failed", detail: error.message }).catch(() => {})
  }
}

// Undo what a failed sign-in left behind, so the next attempt — and the
// next run — starts from "signed out" rather than from a half-written
// credential the vendor refuses. Best effort and quick: a logout that
// hangs is killed, and a runtime with no logout is left alone.
async function signOut(state) {
  const { runtime, slug, plan } = state
  try {
    if (plan.tokenPattern) forgetAuth(runtime.id, slug)
  } catch { /* nothing saved */ }
  if (!plan.logoutArgs) return

  const { bin } = runtime.resolveBin()
  const env = { ...process.env, ...envForProfile(runtime, slug) }
  await new Promise((resolve) => {
    let child
    try {
      child = spawn(bin || runtime.cli, plan.logoutArgs, { env, stdio: "ignore" })
    } catch {
      return resolve()
    }
    const timer = setTimeout(() => { try { child.kill("SIGKILL") } catch { /* gone */ } }, 20000)
    child.on("error", () => { clearTimeout(timer); resolve() })
    child.on("close", () => { clearTimeout(timer); resolve() })
  })
  state.log(`  · signed ${runtime.name} out of the failed attempt`)
}

// Is a sign-in in flight? The idle timer waits for it.
export function loginInProgress() {
  for (const state of sessions.values()) if (!state.finished) return true
  return false
}

// The three relay commands, as a job handler for the runner.
export async function handleLoginJob(job, log) {
  const params = job.params || {}
  switch (job.kind) {
    case "login.start": return startLogin(params, { log })
    case "login.code": return submitLoginCode(params)
    case "login.cancel": return cancelLogin(params)
    default: throw new Error(`Unknown sign-in command "${job.kind}".`)
  }
}

// ---------------------------------------------------------------------------
// Updates.
// ---------------------------------------------------------------------------

function sh(command, { timeoutMs = 10 * 60 * 1000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn("/bin/sh", ["-c", command], { env: process.env, stdio: ["ignore", "pipe", "pipe"] })
    let out = ""
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs)
    child.stdout.on("data", (c) => (out = (out + c).slice(-4000)))
    child.stderr.on("data", (c) => (out = (out + c).slice(-4000)))
    child.on("error", (error) => { clearTimeout(timer); resolve({ code: 1, output: error.message }) })
    child.on("close", (code) => { clearTimeout(timer); resolve({ code: code ?? 1, output: out }) })
  })
}

// What the last successful install put on this machine, and when — kept on
// the volume so it survives the restart the install ends with. Sent with
// every check so the server can decline to hand the same install back, and
// checked here too, so a server that does not know these fields yet cannot
// loop us either.
export function readUpdateState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(UPDATE_STATE_PATH, "utf8"))
    return parsed && typeof parsed === "object" ? parsed : {}
  } catch {
    return {}
  }
}

export function saveUpdateState(state) {
  try {
    fs.mkdirSync(HOME, { recursive: true, mode: 0o700 })
    fs.writeFileSync(UPDATE_STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
  } catch {
    // A state we could not write means one more retry later, not a failure now.
  }
}

// Ask the server whether this machine is behind. Never throws: a server we
// could not reach is a check that happens next time.
export async function checkForUpdates() {
  try {
    const runtime = getRuntime(hostedRuntimeId())
    const version = runtime ? await runtimeVersion(runtime) : null
    const last = readUpdateState()
    return await api.hostedUpdates({
      agentVersion: VERSION, runtime: runtime?.id || null, runtimeVersion: version,
      lastUpdateAt: last.applied_at || null,
      lastAgentTarget: last.agent_target || null,
      lastRuntimeTarget: last.runtime_target || null
    })
  } catch {
    return null
  }
}

// Does the plan name something installable that we have not just installed?
// `last` is what the previous install put here; a step whose target is the
// one we applied within the retry window is skipped, and an installer step
// (no target to compare) counts as the same install for that window.
export function updateWanted(plan, last = readUpdateState(), now = Date.now()) {
  if (!plan) return false
  const appliedAt = last && last.applied_at ? Date.parse(last.applied_at) : NaN
  const recent = Number.isFinite(appliedAt) && now - appliedAt < UPDATE_RETRY_AFTER_MS

  const agent = plan.agent && plan.agent.update && plan.agent.command &&
    !(recent && String(last.agent_target || "") === String(plan.agent.target || ""))
  const runtime = plan.runtime && plan.runtime.update && plan.runtime.command &&
    !(recent && String(last.runtime_target || "") === String(plan.runtime.target || ""))
  return Boolean(agent || runtime)
}

// Run the install commands the server named. True when something was
// installed and the process should restart; false when nothing was, or an
// install failed (the old build keeps running — a broken update is not a
// reason to stop taking work).
export async function applyUpdates(plan, log = () => {}) {
  const steps = []
  if (plan?.agent?.update && plan.agent.command) steps.push(["the companion", plan.agent.command])
  if (plan?.runtime?.update && plan.runtime.command) steps.push([plan.runtime.key || "the runtime", plan.runtime.command])
  if (steps.length === 0) return false

  for (const [what, command] of steps) {
    log(`⬆ Updating ${what}…`)
    const result = await sh(command)
    if (result.code !== 0) {
      log(`! Updating ${what} failed — keeping the current build. ${result.output.slice(-300).trim()}`)
      return false
    }
  }
  saveUpdateState({
    applied_at: new Date().toISOString(),
    agent_target: plan?.agent?.update ? plan.agent.target || null : readUpdateState().agent_target || null,
    runtime_target: plan?.runtime?.update ? plan.runtime.target || null : readUpdateState().runtime_target || null,
    runtime_key: plan?.runtime?.key || null
  })
  log("✓ Updated. Restarting the companion.")
  return true
}

// ---------------------------------------------------------------------------
// The supervisor: idle shutdown and the daily update, over the runner's
// activity counter. `exit(code)` is the runner's way out; it finishes what
// is in flight first.
// ---------------------------------------------------------------------------
export function supervise({ activity, log, exit }) {
  let pendingUpdate = null
  let stopping = false
  const bootedAt = Date.now()

  const idle = () => activity.inflight === 0 && !loginInProgress() && Date.now() - activity.lastJobAt >= IDLE_MS

  const tryUpdate = async () => {
    if (!pendingUpdate || activity.inflight > 0 || loginInProgress() || stopping) return false
    if (Date.now() - bootedAt < BOOT_UPDATE_DELAY_MS) return false
    const plan = pendingUpdate
    pendingUpdate = null
    if (await applyUpdates(plan, log)) {
      stopping = true
      exit(RESTART_EXIT_CODE)
      return true
    }
    return false
  }

  const check = async () => {
    const plan = await checkForUpdates()
    if (plan?.note) log(`  · ${plan.note}`)
    if (updateWanted(plan)) {
      pendingUpdate = plan
      log(`  · An update is available (${[plan.agent?.update && `cma-agent ${plan.agent.target}`, plan.runtime?.update && `${plan.runtime.key} ${plan.runtime.target || "latest"}`].filter(Boolean).join(", ")}) — installing when idle.`)
      await tryUpdate()
    }
  }

  const tick = async () => {
    if (stopping) return
    if (await tryUpdate()) return
    if (!idle()) return

    let answer
    try {
      answer = await api.hostedSleep({ reason: "idle" })
    } catch {
      // Could not tell the server. Stay up rather than vanish on it; the
      // next tick tries again.
      return
    }
    if (answer?.stay) {
      activity.lastJobAt = Date.now()
      return
    }
    stopping = true
    log(`  · Nothing to do for ${Math.round(IDLE_MS / 60000)} minutes — stopping the machine to save credits.`)
    exit(0)
  }

  const idleTimer = setInterval(() => { tick().catch(() => {}) }, IDLE_TICK_MS)
  const updateTimer = setInterval(() => { check().catch(() => {}) }, UPDATE_EVERY_MS)
  let lastCheckAt = Date.now()
  check().catch(() => {})

  return {
    stop() {
      clearInterval(idleTimer)
      clearInterval(updateTimer)
    },
    // The heartbeat said a newer companion is out. Ask for the plan now
    // rather than at tomorrow's check — once per NUDGE_EVERY_MS, and not
    // while an update is already waiting for the machine to go idle.
    nudge() {
      if (!nudgeDue(lastCheckAt, Date.now()) || pendingUpdate || stopping) return false
      lastCheckAt = Date.now()
      log("  · The server says a newer companion is out — checking now.")
      check().catch(() => {})
      return true
    }
  }
}

export function nudgeDue(lastCheckAt, now = Date.now()) {
  return now - lastCheckAt >= NUDGE_EVERY_MS
}
