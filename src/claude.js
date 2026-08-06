import { spawn } from "node:child_process"
import { accessSync, constants } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { profileDir } from "./config.js"

// ---------------------------------------------------------------------------
// Finding Claude Code.
//
// Spawning the bare name "claude" and letting PATH sort it out fails in two
// situations that are both normal rather than exotic:
//
//   1. claude.ai/install.sh puts the binary in ~/.local/bin, which is not on a
//      default macOS PATH. The installer prints the line to add it, and a user
//      who hasn't run that line yet has Claude Code installed and working while
//      we report it missing.
//
//   2. `cma-agent start` is meant to run unattended. A process launched by
//      launchd or systemd gets a minimal PATH and never reads a login shell's
//      profile, so ~/.local/bin is invisible to it no matter what the user's
//      terminal does. That one cannot be fixed by telling anyone to edit
//      .zshrc — the service and the shell do not share a PATH.
//
// So look it up ourselves, keep the absolute path, and spawn that.
// ---------------------------------------------------------------------------

// Relative to the home directory, most likely first. ~/.local/bin is where the
// official installer lands; the rest cover npm/bun globals and older builds.
const HOME_LOCATIONS = [
  ".local/bin/claude",
  ".claude/local/claude",
  ".bun/bin/claude",
  ".npm-global/bin/claude",
  ".volta/bin/claude"
]

const SYSTEM_LOCATIONS = [
  "/opt/homebrew/bin/claude",
  "/usr/local/bin/claude",
  "/usr/bin/claude"
]

function isExecutable(file) {
  try {
    accessSync(file, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function searchPath() {
  const entries = (process.env.PATH || "").split(path.delimiter).filter(Boolean)
  for (const dir of entries) {
    const candidate = path.join(dir, "claude")
    if (isExecutable(candidate)) return candidate
  }
  return null
}

function searchKnownLocations() {
  const home = homedir()
  const candidates = [
    ...HOME_LOCATIONS.map((rel) => path.join(home, rel)),
    ...SYSTEM_LOCATIONS
  ]
  return candidates.find(isExecutable) || null
}

let resolved

// { bin, source } — source is why we picked it, which is the difference
// between "install Claude Code" and "your PATH is missing a directory".
export function resolveClaude({ refresh = false } = {}) {
  if (resolved && !refresh) return resolved

  const override = process.env.CMA_CLAUDE_BIN
  if (override) {
    resolved = { bin: override, source: "CMA_CLAUDE_BIN" }
    return resolved
  }

  const onPath = searchPath()
  if (onPath) {
    resolved = { bin: onPath, source: "PATH" }
    return resolved
  }

  const known = searchKnownLocations()
  resolved = known ? { bin: known, source: "known-location" } : { bin: null, source: "missing" }
  return resolved
}

// One line of advice matched to what we actually found, or null when there is
// nothing worth saying. Callers print this instead of guessing.
export function claudeAdvice() {
  const { bin, source } = resolveClaude()

  if (source === "missing") {
    return "Claude Code isn't installed. Install it from https://claude.com/product/claude-code and sign in — " +
           "that's the login this machine will spend."
  }

  if (source === "known-location") {
    const dir = path.dirname(bin)
    return `Found Claude Code at ${bin}, but ${dir} isn't on your PATH. Using it anyway. ` +
           `To fix your shell too:\n    echo 'export PATH="${dir}:$PATH"' >> ~/.zshrc && source ~/.zshrc`
  }

  return null
}

// ---------------------------------------------------------------------------
// The Claude Code CLI surface we depend on.
//
// Gathered in one place on purpose. These are another product's flags, and
// they can move between versions — when something breaks after a Claude Code
// upgrade, this object is the only thing that should need editing. Check the
// installed build with `claude --help` before changing anything here.
// ---------------------------------------------------------------------------
const CLI = {
  // Resolved, absolute, and looked up once — see resolveClaude above for why a
  // bare "claude" is not good enough.
  get bin() { return resolveClaude().bin || "claude" },
  print: "-p",
  outputFormat: ["--output-format", "json"],
  // Turn-by-turn NDJSON. `--verbose` is not optional here: without it
  // stream-json does not emit the per-turn events, which are the entire point.
  // Verified against the CLI reference for Claude Code 2.1.220.
  streamFormat: ["--output-format", "stream-json", "--verbose"],
  model: (id) => ["--model", id],
  appendSystem: (text) => ["--append-system-prompt", text],
  // Working inside a real repository means Claude Code must be allowed to
  // edit files without stopping to ask — there is no terminal for anyone to
  // answer in. `acceptEdits` is the narrow choice on purpose: edits yes,
  // arbitrary commands no. The directory it is confined to has already been
  // allowlisted by the user via `cma-agent repos:add`.
  permissionMode: (mode) => ["--permission-mode", mode]
}

// ---------------------------------------------------------------------------
// Why there is no "how long may a run take" setting any more.
//
// Every total-duration ceiling we picked was wrong. 150s killed healthy work;
// 450s just moved the wall. The number cannot be right, because "a coding turn"
// is anywhere from four seconds to forty minutes and nothing about the request
// tells you which.
//
// Claude Code itself never faces this question, because it streams: the socket
// produces tokens continuously, and a read timeout measures the GAP between
// bytes rather than the total. A forty-minute turn is just a long series of
// short gaps. We were invoking `-p --output-format json`, which buffers — not
// one byte until the whole run finishes — so a duration guess was the only
// instrument we had.
//
// So we stream too, and the question changes from "is this taking too long?"
// to "is this still alive?". IDLE_TIMEOUT_MS is the real contract: silence,
// not duration. MAX_RUN_MS exists only to reap a wedged process that is
// somehow still emitting; it is deliberately far beyond any real run.
// ---------------------------------------------------------------------------
const IDLE_TIMEOUT_MS = Number(process.env.CMA_IDLE_TIMEOUT_MS || 120000)
const MAX_RUN_MS = Number(process.env.CMA_MAX_RUN_MS || 4 * 60 * 60 * 1000)
const PROBE_TIMEOUT_MS = 20000

// A progress post does two jobs, and they want different rates.
//
// As a heartbeat it only has to beat the server's silence budget, so every
// 10s is plenty and one dropped post costs nothing. As a ticker it is what
// someone is reading, and "Starting up" left on screen for ten seconds while
// the model is already three files in is a worse lie than no ticker at all.
//
// So: post the moment the note CHANGES (rate-limited to once a second so a
// burst of tool calls can't flood the endpoint), and post regardless every
// 10s to keep the run's liveness fresh.
const MIN_NOTE_INTERVAL_MS = 1000
const HEARTBEAT_EVERY_MS = 10000

function run(args, { env = {}, timeoutMs = IDLE_TIMEOUT_MS, input, cwd } = {}) {
  return new Promise((resolve) => {
    const child = spawn(CLI.bin, args, {
      env: { ...process.env, ...env },
      cwd: cwd || undefined,
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

// Spawn Claude Code in streaming mode and consume its NDJSON.
//
// Resolves with every event we saw plus how the process ended. The idle clock
// resets on ANY byte from either pipe — a tool running for three minutes is
// silent on stdout but the run is plainly alive, so stderr counts too.
function runStreaming(args, { env = {}, cwd, onEvent } = {}) {
  return new Promise((resolve) => {
    const child = spawn(CLI.bin, args, {
      env: { ...process.env, ...env },
      cwd: cwd || undefined,
      stdio: ["pipe", "pipe", "pipe"]
    })

    const events = []
    const startedAt = Date.now()
    let lastActivity = Date.now()
    let buffer = ""
    let stderr = ""
    let idleOut = false
    let overran = false
    let badLines = 0

    const watchdog = setInterval(() => {
      const now = Date.now()
      if (now - lastActivity > IDLE_TIMEOUT_MS) {
        idleOut = true
        child.kill("SIGKILL")
      } else if (now - startedAt > MAX_RUN_MS) {
        overran = true
        child.kill("SIGKILL")
      }
    }, 1000)

    const finish = (code, spawnError) => {
      clearInterval(watchdog)
      resolve({
        code,
        events,
        stderr,
        badLines,
        idleOut,
        overran,
        spawnError,
        elapsedMs: Date.now() - startedAt
      })
    }

    child.stdout.on("data", (chunk) => {
      lastActivity = Date.now()
      buffer += chunk
      // NDJSON: one complete event per line. The trailing fragment stays in
      // the buffer until its newline arrives.
      let newline
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (!line) continue
        try {
          const event = JSON.parse(line)
          events.push(event)
          if (onEvent) {
            // A throwing callback is the caller's problem, not a reason to
            // abandon a run that is going fine.
            try { onEvent(event) } catch { /* ignore */ }
          }
        } catch {
          badLines += 1
        }
      }
    })

    child.stderr.on("data", (chunk) => {
      lastActivity = Date.now()
      stderr += chunk
    })

    child.on("error", (error) => finish(-1, error))
    child.on("close", (code) => finish(code))

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

function baseArgs(job) {
  const args = []
  if (job.model) args.push(...CLI.model(job.model))
  if (job.system) args.push(...CLI.appendSystem(job.system))
  // Only when the job is anchored to a repository. A plain chat completion
  // gets no working directory and no elevated permission mode, so nothing
  // about this widens the ordinary path.
  if (job.workdir) args.push(...CLI.permissionMode("acceptEdits"))
  return args
}

// One short human line per event, for the "Reading foo.rb" ticker the web app
// shows while a run is in flight. Mirrors Code::Agent#humanize_step on the
// server so both paths read the same to a user.
function describeEvent(event) {
  if (!event || typeof event !== "object") return null

  if (event.type === "system" && event.subtype === "init") return "Starting up"

  if (event.type === "assistant") {
    const blocks = event.message?.content
    if (!Array.isArray(blocks)) return null
    for (const block of blocks) {
      if (block?.type !== "tool_use") continue
      const input = block.input || {}
      const target = input.file_path || input.path || input.pattern || input.command || input.url || ""
      const short = String(target).split("/").slice(-2).join("/").slice(0, 60)
      switch (block.name) {
        case "Read":      return short ? `Reading ${short}` : "Reading a file"
        case "Edit":
        case "MultiEdit": return short ? `Editing ${short}` : "Editing a file"
        case "Write":     return short ? `Writing ${short}` : "Writing a file"
        case "Bash":      return short ? `Running ${short}` : "Running a command"
        case "Grep":      return short ? `Searching ${short}` : "Searching"
        case "Glob":      return short ? `Looking for ${short}` : "Looking for files"
        case "WebFetch":  return short ? `Reading ${short}` : "Reading a page"
        default:          return `${block.name}${short ? ` ${short}` : ""}`.slice(0, 80)
      }
    }
    return "Thinking"
  }

  return null
}

// Fold the NDJSON stream into the same shape parseOutput returns, so callers
// cannot tell which transport produced an answer.
function collapseEvents(events) {
  const out = {
    content: "",
    usage: emptyUsage(),
    model: null,
    stopReason: null,
    isError: false,
    errorStatus: null
  }

  let sawResult = false
  const assistantText = []

  for (const event of events) {
    if (event?.type === "assistant" && Array.isArray(event.message?.content)) {
      for (const block of event.message.content) {
        if (block?.type === "text" && block.text) assistantText.push(block.text)
      }
      if (event.message.model) out.model = event.message.model
    }

    if (event?.type === "result") {
      sawResult = true
      if (typeof event.result === "string") out.content = event.result
      out.stopReason = event.stop_reason || event.subtype || null
      out.isError = event.is_error === true
      out.errorStatus = event.api_error_status || null
      const usage = event.usage || {}
      out.usage = {
        input_tokens: Number(usage.input_tokens || 0),
        output_tokens: Number(usage.output_tokens || 0),
        cache_creation_input_tokens: Number(usage.cache_creation_input_tokens || 0),
        cache_read_input_tokens: Number(usage.cache_read_input_tokens || 0)
      }
      out.model = firstKey(event.modelUsage) || out.model
    }
  }

  // No terminal `result` event — the process died mid-stream. Whatever the
  // assistant had already said is still worth returning; it beats an empty
  // reply, and the caller decides whether a partial answer is acceptable.
  if (!out.content) out.content = assistantText.join("")
  return { ...out, sawResult }
}

// Some failures mean "this build is older than these flags" rather than "the
// run failed". Detected so we can retry the buffered path instead of telling
// the user their perfectly good machine is broken.
function looksUnsupported(stderr) {
  return /unknown option|unrecognized option|unknown argument|invalid( value for)? --output-format|requires --verbose/i
    .test(String(stderr || ""))
}

export async function runCompletion(job, { onProgress } = {}) {
  const prompt = renderPrompt(job.messages || [])
  const env = envForProfile(job.profileSlug)

  // ── Streaming first. This is the path that makes a long run survivable:
  // events arrive continuously, so we can distinguish "still working" from
  // "stopped responding" instead of guessing a duration.
  let lastNote = null   // the newest thing we know it is doing
  let postedNote = null // the newest thing we have told the server
  let lastPost = 0
  const result = await runStreaming(
    [CLI.print, ...CLI.streamFormat, ...baseArgs(job), prompt],
    {
      env,
      cwd: job.workdir,
      onEvent: (event) => {
        const note = describeEvent(event)
        if (note) lastNote = note
        if (!onProgress) return

        const now = Date.now()
        const since = now - lastPost
        const changed = lastNote !== null && lastNote !== postedNote
        if (!(changed && since >= MIN_NOTE_INTERVAL_MS) && since < HEARTBEAT_EVERY_MS) return

        lastPost = now
        postedNote = lastNote
        onProgress(lastNote || "Working")
      }
    }
  )

  if (result.spawnError && result.spawnError.code === "ENOENT") {
    throw new Error("Claude Code isn't installed on this machine, or isn't on PATH.")
  }

  // Nothing parseable and a non-zero exit → almost certainly a build that
  // doesn't take these flags. Fall back rather than fail.
  if (result.events.length === 0 && result.code !== 0 && looksUnsupported(result.stderr)) {
    return runBuffered(job, prompt, env)
  }

  if (result.idleOut) {
    throw new Error(
      `Claude Code produced no output for ${Math.round(IDLE_TIMEOUT_MS / 1000)}s and was stopped. ` +
      "The machine may have slept, or the run is genuinely stuck."
    )
  }
  if (result.overran) {
    throw new Error("Claude Code ran past the safety ceiling and was stopped.")
  }

  const output = collapseEvents(result.events)

  if (result.code !== 0 && !output.sawResult) {
    throw classifyFailure((result.stderr || "").trim().slice(0, 500) || "Claude Code exited with an error.")
  }

  // A zero exit does not mean success: Claude Code surfaces API errors,
  // refusals and rate limits in-band with `is_error: true`. Without this
  // check the error text would be stored and rendered as the assistant's
  // answer, which is both wrong and confusing to debug.
  if (output.isError) {
    throw classifyFailure(output.content || output.errorStatus || "Claude Code reported an error.")
  }

  if (!output.content) {
    throw new Error("Claude Code finished without producing an answer.")
  }

  return output
}

// The original buffered invocation, kept for companions talking to a Claude
// Code that predates stream-json. It still cannot tell a long run from a dead
// one — that limitation is inherent to buffering, which is exactly why it is
// the fallback and not the default.
async function runBuffered(job, prompt, env) {
  const result = await run([CLI.print, ...CLI.outputFormat, ...baseArgs(job), prompt], {
    env,
    cwd: job.workdir,
    timeoutMs: MAX_RUN_MS
  })

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
