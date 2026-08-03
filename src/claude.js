import { spawn } from "node:child_process"
import { profileDir } from "./config.js"

// ---------------------------------------------------------------------------
// The Claude Code CLI surface we depend on.
//
// Gathered in one place on purpose. These are another product's flags, and
// they can move between versions — when something breaks after a Claude Code
// upgrade, this object is the only thing that should need editing. Check the
// installed build with `claude --help` before changing anything here.
// ---------------------------------------------------------------------------
const CLI = {
  bin: process.env.CMA_CLAUDE_BIN || "claude",
  print: "-p",
  outputFormat: ["--output-format", "json"],
  model: (id) => ["--model", id],
  appendSystem: (text) => ["--append-system-prompt", text]
}

// A run is bounded by the caller's patience on the other end; there is no
// value in a local process outliving the request that asked for it.
const RUN_TIMEOUT_MS = Number(process.env.CMA_RUN_TIMEOUT_MS || 150000)
const PROBE_TIMEOUT_MS = 20000

function run(args, { env = {}, timeoutMs = RUN_TIMEOUT_MS, input } = {}) {
  return new Promise((resolve) => {
    const child = spawn(CLI.bin, args, {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"]
    })

    let stdout = ""
    let stderr = ""
    let timedOut = false

    const timer = setTimeout(() => {
      timedOut = true
      child.kill("SIGKILL")
    }, timeoutMs)

    child.stdout.on("data", (chunk) => (stdout += chunk))
    child.stderr.on("data", (chunk) => (stderr += chunk))

    child.on("error", (error) => {
      clearTimeout(timer)
      resolve({ code: -1, stdout, stderr: error.message, timedOut: false, spawnError: error })
    })

    child.on("close", (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr, timedOut })
    })

    if (input !== undefined) {
      child.stdin.write(input)
    }
    child.stdin.end()
  })
}

// Claude Code reads its login from CLAUDE_CONFIG_DIR, so a directory per
// profile is what keeps a work account and a personal account apart.
//
// Caveat worth knowing: on macOS, Claude Code stores credentials in the system
// Keychain, and whether a per-profile config directory fully isolates them
// depends on the Claude Code version. `cma-agent claude:scan` reports the
// account each profile actually resolves to so you can see at a glance whether
// two profiles have collapsed into the same login — rather than finding out
// when the wrong account gets billed.
function envForProfile(slug) {
  if (!slug) return {}
  return { CLAUDE_CONFIG_DIR: profileDir(slug) }
}

export async function claudeVersion() {
  const result = await run(["--version"], { timeoutMs: 10000 })
  if (result.code !== 0) return null
  return result.stdout.trim().split("\n")[0] || null
}

export async function claudeInstalled() {
  return (await claudeVersion()) !== null
}

// Is this profile signed in and usable? Cheapest possible real request: if it
// answers at all, the login works.
export async function probeProfile(slug) {
  const result = await run([CLI.print, "Reply with the single word: ok", ...CLI.outputFormat], {
    env: envForProfile(slug),
    timeoutMs: PROBE_TIMEOUT_MS
  })

  if (result.code === 0) return { status: "ready" }

  const message = `${result.stderr}\n${result.stdout}`.toLowerCase()
  // Anything auth-shaped is "sign in again"; everything else is genuinely
  // unknown and shouldn't be reported as a login problem the user can't find.
  if (/login|log in|auth|unauthor|credential|sign in|expired/.test(message)) {
    return { status: "logged_out" }
  }
  return { status: "unknown", detail: result.stderr.trim().slice(0, 200) }
}

// Flatten a conversation into one prompt.
//
// Headless Claude Code takes a single prompt rather than a message array, so
// prior turns are rendered inline. That is a real difference from calling the
// Messages API directly, and it is why a long conversation costs more here than
// it would with prompt caching on the API path.
function renderPrompt(messages) {
  return messages
    .map((message) => {
      const role = message.role === "assistant" ? "Assistant" : "User"
      const content = typeof message.content === "string" ? message.content : JSON.stringify(message.content)
      return `${role}: ${content}`
    })
    .join("\n\n")
    .concat("\n\nAssistant:")
}

// Parse Claude Code's `--output-format json` envelope.
//
// Verified against Claude Code 2.1.220, whose result object looks like:
//   { is_error, stop_reason, result, usage: {...}, modelUsage: { "<model>": {...} },
//     subtype, total_cost_usd, session_id, ... }
//
// Read defensively anyway — this is another product's output format, and a
// version bump that renames a field should degrade to "we got the text but not
// the token counts" rather than to an empty answer.
function parseOutput(stdout) {
  const empty = { content: "", usage: emptyUsage(), model: null, stopReason: null, isError: false }
  const trimmed = stdout.trim()
  if (!trimmed) return empty

  let parsed
  try {
    parsed = JSON.parse(trimmed)
  } catch (_error) {
    // Not JSON at all — almost certainly plain text from an older build. The
    // answer is still the answer; we just don't get usage from it.
    return { ...empty, content: trimmed }
  }

  const content =
    parsed.result ??
    parsed.text ??
    parsed.content ??
    (Array.isArray(parsed.messages) ? parsed.messages.at(-1)?.content : null) ??
    ""

  const usage = parsed.usage || parsed.message?.usage || {}

  return {
    content: typeof content === "string" ? content : JSON.stringify(content),
    usage: {
      input_tokens: Number(usage.input_tokens || 0),
      output_tokens: Number(usage.output_tokens || 0),
      cache_creation_input_tokens: Number(usage.cache_creation_input_tokens || 0),
      cache_read_input_tokens: Number(usage.cache_read_input_tokens || 0)
    },
    // There's no top-level `model` field — the model that actually ran is the
    // key of `modelUsage`. Falling back to the requested id keeps the Usage
    // page populated if that ever changes.
    model: firstKey(parsed.modelUsage) || parsed.model || parsed.message?.model || null,
    stopReason: parsed.stop_reason || parsed.subtype || null,
    // Claude Code reports in-band failures (API errors, refusals) with
    // `is_error: true` and a **zero exit code**. Trusting the exit code alone
    // would hand the user an error string rendered as the assistant's reply.
    isError: parsed.is_error === true,
    errorStatus: parsed.api_error_status || null
  }
}

function emptyUsage() {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0
  }
}

function firstKey(object) {
  if (!object || typeof object !== "object") return null
  const keys = Object.keys(object)
  return keys.length > 0 ? keys[0] : null
}

export async function runCompletion(job) {
  const args = [CLI.print, ...CLI.outputFormat]
  if (job.model) args.push(...CLI.model(job.model))
  if (job.system) args.push(...CLI.appendSystem(job.system))

  const prompt = renderPrompt(job.messages || [])
  const result = await run([...args, prompt], { env: envForProfile(job.profileSlug) })

  if (result.spawnError && result.spawnError.code === "ENOENT") {
    throw new Error("Claude Code isn't installed on this machine, or isn't on PATH.")
  }
  if (result.timedOut) {
    throw new Error("Claude Code didn't finish in time. The machine may have slept mid-run.")
  }
  if (result.code !== 0) {
    throw classifyFailure((result.stderr || result.stdout).trim().slice(0, 500))
  }

  const output = parseOutput(result.stdout)

  // A zero exit does not mean success: Claude Code surfaces API errors,
  // refusals and rate limits in-band with `is_error: true`. Without this
  // check the error text would be stored and rendered as the assistant's
  // answer, which is both wrong and confusing to debug.
  if (output.isError) {
    throw classifyFailure(output.content || output.errorStatus || "Claude Code reported an error.")
  }

  return output
}

// Rate limits and expired logins are the two failures worth naming precisely:
// one means "wait or switch providers", the other means "run one command", and
// a generic message sends people looking in the wrong place.
function classifyFailure(detail) {
  const lower = detail.toLowerCase()
  if (/rate limit|quota|usage limit/.test(lower)) {
    return new Error(`Your Claude plan is rate limited right now. ${detail}`)
  }
  if (/login|log in|auth|unauthor|credential|sign in/.test(lower)) {
    return new Error(`That Claude login needs signing in again. ${detail}`)
  }
  return new Error(detail || "Claude Code exited with an error.")
}

// Interactive sign-in for a profile. stdio is inherited so the user sees
// Claude Code's own login flow — we are handing over, not proxying, and the
// credential it writes is never something we read.
export function loginProfile(slug) {
  return new Promise((resolve) => {
    const child = spawn(CLI.bin, ["/login"], {
      env: { ...process.env, ...envForProfile(slug) },
      stdio: "inherit"
    })
    child.on("close", (code) => resolve(code === 0))
    child.on("error", () => resolve(false))
  })
}
