import { spawn } from "node:child_process"

import { ensureProfileDir } from "./config.js"
import { hostedAuthEnv } from "./hosted_auth.js"
import { collectDocuments } from "./documents.js"
import { DEFAULT_RUNTIME, getRuntime, isHttpRuntime, isInstalled } from "./runtimes/index.js"

// ---------------------------------------------------------------------------
// The part of running a coding CLI that is the same whatever the vendor.
//
// Spawning, the NDJSON reader, the idle contract, the heartbeat, the partial
// text accumulation, the cancel path. Everything vendor-specific — flags,
// event shapes, permissions, login — lives in src/runtimes/<name>.js, and this
// file never names one.
//
// ── Two transports, one contract ──────────────────────────────────────────
//
// Most runtimes are a subprocess: spawn it, read NDJSON off stdout, kill it to
// cancel. One (Ollama) is an HTTP endpoint on the same machine: POST, read
// NDJSON off the response body, abort to cancel. The difference is confined to
// `runStreaming` vs `runStreamingHttp`, which resolve to the SAME result shape
// — events, exit code, stderr, why it ended — so every line after the call
// site is transport-blind. That is deliberate: the idle watchdog, the
// heartbeat, partial text and cancellation are the hard parts, and there is no
// version of this file where they exist twice.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Why there is no "how long may a run take" setting.
//
// Every total-duration ceiling we picked was wrong. 150s killed healthy work;
// 450s just moved the wall. The number cannot be right, because "a coding turn"
// is anywhere from four seconds to forty minutes and nothing about the request
// tells you which.
//
// These CLIs never face this question themselves, because they stream: the
// socket produces tokens continuously, and a read timeout measures the GAP
// between bytes rather than the total. A forty-minute turn is just a long
// series of short gaps. We were invoking a buffered format — not one byte
// until the whole run finishes — so a duration guess was the only instrument
// we had.
//
// So we stream too, and the question changes from "is this taking too long?"
// to "is this still alive?". IDLE_TIMEOUT_MS is the real contract: silence,
// not duration. MAX_RUN_MS exists only to reap a wedged process that is
// somehow still emitting; it is deliberately far beyond any real run.
// ---------------------------------------------------------------------------
// 120s was too tight even with partial messages, and the reason is tool
// execution rather than generation. While a shell tool runs the project's test
// suite, these CLIs emit nothing at all — there is no token to stream — and
// their own command timeouts allow up to ten minutes. So the silence budget
// has to clear the longest single tool call, or we kill healthy runs again,
// just later. Ten minutes of genuine silence really is stuck.
//
// This does not delay noticing a slept machine: the heartbeat below is on a
// timer, so the SERVER stops hearing from us within seconds of the process
// dying, whatever this value is.
const IDLE_TIMEOUT_MS = Number(process.env.CMA_IDLE_TIMEOUT_MS || 600000)
const MAX_RUN_MS = Number(process.env.CMA_MAX_RUN_MS || 4 * 60 * 60 * 1000)

// How long a dead process's pipes get to deliver what is still in them.
//
// `exit` says the process is gone. `close` says the process is gone AND every
// stdio stream it held has closed — and those are not the same event, because
// anything the CLI spawned inherits those pipes and keeps them open after the
// CLI itself is dead. A run we SIGKILL (cancelled from the web app, or past
// the idle ceiling) is precisely when that happens: the CLI dies, whatever it
// had running does not, and a promise waiting only on `close` never settles.
//
// It never settling is not a slow run. The runner holds a concurrency slot per
// job in flight and blocks when they are all taken, so one leaked slot is one
// less job this machine can run and enough of them stop it claiming work at
// all — silently, while the git-command lane beside it goes on answering. That
// is a companion that looks healthy in its own terminal while every coding turn
// sent to it sits in the queue until it expires.
//
// So: finish on `exit`, but give the pipes a moment first, because a clean run
// has real output still in flight and `close` is microseconds behind. A normal
// run never waits this out — `close` arrives and cancels the timer.
const PIPE_DRAIN_MS = 2000

// Let go of a settled run's pipes.
//
// Our end of them is a live handle on the event loop, and after the drain
// window nothing reads it — the promise has already resolved. Keeping it means
// a companion that has finished with a run still holds file descriptors open
// for as long as the orphan on the other end lives, which on a machine that
// cancels a few runs is a slow leak of exactly the resource a long-running
// daemon must not leak.
function releasePipes(child) {
  for (const stream of [child.stdout, child.stderr, child.stdin]) {
    try { stream?.destroy() } catch { /* already gone */ }
  }
}
const PROBE_TIMEOUT_MS = 20000

// A progress post does two jobs, and they want different rates.
//
// As a heartbeat it only has to beat the server's silence budget, so every 10s
// is plenty and one dropped post costs nothing. Crucially it fires on a TIMER,
// not on events: during a long tool call there are no events, and a run that
// only heartbeats when the model speaks would be reaped by the server halfway
// through its own test suite.
//
// As a ticker it is what someone is reading, and "Starting up" left on screen
// while the model is already three files in is a worse lie than no ticker.
// So it also posts the moment the note CHANGES, rate-limited to once a second
// so a burst of tool calls can't flood the endpoint.
const MIN_NOTE_INTERVAL_MS = 1000
const HEARTBEAT_EVERY_MS = 10000

// Feed the prompt and close the pipe, without ever taking the process down.
//
// A failed spawn (the CLI moved, PATH changed under a service) still hands
// back a child whose stdin errors on write. Unhandled, that EPIPE is an
// uncaught exception in the companion — a crashed daemon instead of one failed
// job. The spawn error handler that follows is what reports the real cause.
function feedStdin(child, input) {
  try {
    child.stdin.on("error", () => {})
    if (input !== undefined && input !== null) child.stdin.write(input)
    child.stdin.end()
  } catch {
    // Nothing to do: the 'error' event on the child carries the real reason.
  }
}

function run(bin, args, { env = {}, timeoutMs = IDLE_TIMEOUT_MS, input, cwd } = {}) {
  return new Promise((resolve) => {
    const child = spawn(bin, args, {
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

    // One settle, whichever of the three gets here first. See PIPE_DRAIN_MS:
    // `close` can never arrive, and this promise is somebody's job slot.
    let settled = false
    let drain = null
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(drain)
      releasePipes(child)
      resolve(result)
    }

    child.on("error", (error) =>
      finish({ code: -1, stdout, stderr: error.message, timedOut: false, spawnError: error }))

    child.on("close", (code) => finish({ code, stdout, stderr, timedOut }))

    child.on("exit", (code) => {
      drain = setTimeout(() => finish({ code, stdout, stderr, timedOut }), PIPE_DRAIN_MS)
    })

    feedStdin(child, input)
  })
}

// Spawn a runtime in streaming mode and consume its NDJSON.
//
// Resolves with every event we saw plus how the process ended. The idle clock
// resets on ANY byte from either pipe — a tool running for three minutes is
// silent on stdout but the run is plainly alive, so stderr counts too.
//
// `control`, when given, is handed a `kill()` the caller may invoke to end
// the run deliberately (the server said the job was cancelled). SIGKILL, not
// SIGTERM: mid-tool-call these CLIs can linger on a polite signal, and a
// cancelled run has nothing worth a graceful exit. The result carries
// `killed: true` so the caller can tell "we stopped it" from "it died".
function runStreaming(bin, args, { env = {}, cwd, input, onEvent, onTick, control } = {}) {
  return new Promise((resolve) => {
    const child = spawn(bin, args, {
      env: { ...process.env, ...env },
      cwd: cwd || undefined,
      stdio: ["pipe", "pipe", "pipe"]
    })

    // Closed immediately whether or not we had anything to send: with stdin
    // left open, a build that reads from it waits forever for input that is
    // never coming.
    feedStdin(child, input)

    const events = []
    const startedAt = Date.now()
    let lastActivity = Date.now()
    let buffer = ""
    let stderr = ""
    let idleOut = false
    let overran = false
    let killed = false
    const counters = { badLines: 0 }

    if (control) {
      control.kill = () => {
        killed = true
        child.kill("SIGKILL")
      }
    }

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

    // Independent of events, and that is the point: while a shell tool runs the
    // project's test suite there are no events for minutes, but the run is
    // plainly alive and the server has to keep hearing so.
    const heartbeat = onTick
      ? setInterval(() => { try { onTick() } catch { /* ignore */ } }, HEARTBEAT_EVERY_MS)
      : null

    let settled = false
    let drain = null

    const finish = (code, spawnError) => {
      if (settled) return
      settled = true
      clearInterval(watchdog)
      clearTimeout(drain)
      if (heartbeat) clearInterval(heartbeat)
      releasePipes(child)
      resolve({
        code, events, stderr, badLines: counters.badLines, idleOut, overran, killed, spawnError,
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
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        consumeLine(line, { events, onEvent, counters })
      }
    })

    child.stderr.on("data", (chunk) => {
      lastActivity = Date.now()
      stderr += chunk
    })

    child.on("error", (error) => finish(-1, error))
    child.on("close", (code) => finish(code))
    // The backstop. See PIPE_DRAIN_MS — this is the one that keeps a killed run
    // from taking a concurrency slot to the grave.
    child.on("exit", (code) => { drain = setTimeout(() => finish(code), PIPE_DRAIN_MS) })
  })
}

// One NDJSON line, parsed and dispatched. Shared by both transports so a
// malformed line is counted the same way whether it came off a pipe or a
// socket — `badLines` is what tells "the CLI printed a banner" apart from "the
// CLI printed nothing".
function consumeLine(line, { events, onEvent, counters }) {
  const trimmed = line.trim()
  if (!trimmed) return

  try {
    const event = JSON.parse(trimmed)
    events.push(event)
    if (onEvent) {
      // A throwing callback is the caller's problem, not a reason to abandon
      // a run that is going fine.
      try { onEvent(event) } catch { /* ignore */ }
    }
  } catch {
    counters.badLines += 1
  }
}

// The HTTP twin of runStreaming.
//
// Same promise, same resolved shape, same three ways to end: idle too long,
// ran past the ceiling, or killed on purpose. `code` is 0 or 1 rather than a
// real exit status because there is no process — what matters downstream is
// only whether the runtime finished cleanly, and every adapter reads its own
// events for the actual outcome.
//
// A non-2xx response is not thrown: the body is the runtime's own error text
// ({"error":"model 'x' not found"}), and reporting that beats reporting the
// status code it arrived under. It lands in `stderr`, which is exactly where
// the CLI path puts the same information.
function runStreamingHttp(request, { onEvent, onTick, control } = {}) {
  return new Promise((resolve) => {
    const events = []
    const counters = { badLines: 0 }
    const startedAt = Date.now()
    const controller = new AbortController()

    let lastActivity = Date.now()
    let idleOut = false
    let overran = false
    let killed = false
    let noAnswer = false
    let stderr = ""
    let settled = false

    if (control) {
      control.kill = () => {
        killed = true
        controller.abort()
      }
    }

    const watchdog = setInterval(() => {
      const now = Date.now()
      if (now - lastActivity > IDLE_TIMEOUT_MS) {
        idleOut = true
        controller.abort()
      } else if (now - startedAt > MAX_RUN_MS) {
        overran = true
        controller.abort()
      }
    }, 1000)

    // Independent of events, for the same reason it is on the CLI path: the
    // server is waiting on liveness, and a model that is still loading its
    // weights produces nothing for a minute while being perfectly alive.
    const heartbeat = onTick
      ? setInterval(() => { try { onTick() } catch { /* ignore */ } }, HEARTBEAT_EVERY_MS)
      : null

    const finish = (code, spawnError) => {
      if (settled) return
      settled = true
      clearInterval(watchdog)
      if (heartbeat) clearInterval(heartbeat)
      resolve({
        code, events, stderr, badLines: counters.badLines,
        idleOut, overran, killed, spawnError,
        elapsedMs: Date.now() - startedAt
      })
    }

    // The connect timeout covers ONLY the round trip to response headers — it
    // is cleared the moment fetch settles, below. It must not outlive that: a
    // large model can take a minute to produce its first token, and a
    // first-token deadline would kill exactly the runs this feature exists for.
    // Once headers are in, the idle watchdog owns the clock.
    const connectTimer = request.connectTimeoutMs
      ? setTimeout(() => {
          noAnswer = true
          controller.abort()
        }, request.connectTimeoutMs)
      : null

    ;(async () => {
      let response
      try {
        response = await fetch(request.url, {
          method: request.method || "POST",
          headers: request.headers || { "Content-Type": "application/json" },
          body: request.body === undefined ? undefined : JSON.stringify(request.body),
          signal: controller.signal
        })
      } catch (error) {
        // An abort here is ours: the watchdog, a cancel, or the connect timer.
        // Anything else is the machine saying nobody is listening — and the
        // adapter's classifier turns that into an address and a command.
        if (killed || idleOut || overran) return finish(1)
        if (noAnswer) {
          return finish(-1, new Error(
            `Nothing answered within ${Math.round(request.connectTimeoutMs / 1000)}s. ECONNREFUSED`
          ))
        }
        return finish(-1, error)
      } finally {
        if (connectTimer) clearTimeout(connectTimer)
      }

      lastActivity = Date.now()

      if (!response.ok) {
        stderr = (await response.text().catch(() => "")).slice(0, 2000) ||
                 `The runtime answered ${response.status}.`
        return finish(1)
      }

      if (!response.body) {
        stderr = "The runtime answered with an empty body."
        return finish(1)
      }

      const decoder = new TextDecoder()
      let buffer = ""

      try {
        for await (const chunk of response.body) {
          lastActivity = Date.now()
          buffer += decoder.decode(chunk, { stream: true })

          let newline
          while ((newline = buffer.indexOf("\n")) !== -1) {
            const line = buffer.slice(0, newline)
            buffer = buffer.slice(newline + 1)
            consumeLine(line, { events, onEvent, counters })
          }
        }
        // A stream that ends without a trailing newline still has one event in
        // it, and for a short answer that event is the whole result.
        consumeLine(buffer, { events, onEvent, counters })
      } catch (error) {
        // Aborted mid-answer. Everything already read stays — a cancelled run
        // still shows the user what it had written by the time they stopped it.
        if (!(killed || idleOut || overran)) {
          stderr = String(error?.message || error).slice(0, 500)
          return finish(1)
        }
        return finish(1)
      }

      finish(0)
    })()
  })
}

// What a failure needs to know about the run that produced it.
//
// One fact so far, and it is the one that made "sign in again" a dead end: an
// expired login has to be named, because on a machine with two of them the
// generic command signs the wrong one in. See loginCommand in
// runtimes/shared.js.
function failureContext(job) {
  return { profileSlug: job?.profileSlug || "" }
}

// A runtime's per-profile environment.
//
// The empty slug is the ambient login — the one you get by running the CLI
// with no override set. Most people have exactly that and nothing else, and it
// should work with no setup at all. Cursor is the exception (`ambientProfile:
// false`): its allowance is a file we have to own, so even "default" is a
// directory we manage. See src/runtimes/cursor.js.
//
// On a cloud machine the login may be a token the vendor's headless flow
// printed rather than a file its CLI keeps (Claude Code's `setup-token`);
// hostedAuthEnv hands it back as the environment variable the CLI reads,
// and is {} everywhere else — see src/hosted_auth.js.
export function envForProfile(runtime, slug) {
  const auth = hostedAuthEnv(runtime, slug)
  if (!runtime.configDirEnvVar) return auth
  if (!slug && runtime.ambientProfile !== false) return auth

  return { ...auth, [runtime.configDirEnvVar]: ensureProfileDir(runtime, slug) }
}

// The directory a runtime's own config lands in for this profile, or null when
// the runtime is running ambient. Adapters that write files need it; the rest
// ignore it.
function configDirFor(runtime, slug) {
  if (!slug && runtime.ambientProfile !== false) return null
  return ensureProfileDir(runtime, slug)
}

// Which account a login actually resolves to, for the runtimes that can say.
//
// The label on a profile is what someone typed; this is what the CLI resolved,
// and they are different claims. On macOS especially they can disagree without
// anything looking wrong — see the note on claudeCode.readAccount — so this is
// the difference between "we think Work pays" and "Work pays".
//
// Never fatal. A runtime with no answer, an unreadable file or a build that
// moved the field all mean "we can't tell", which costs a line of display and
// nothing else.
export function profileAccount(runtime, slug) {
  if (typeof runtime?.readAccount !== "function") return null

  try {
    return runtime.readAccount({ configDir: configDirFor(runtime, slug) })
  } catch (_error) {
    return null
  }
}

export async function runtimeVersion(runtime) {
  // An HTTP runtime knows how to ask its own server. There is no binary whose
  // `--version` would be the right answer anyway: the CLI on this machine and
  // the server it talks to can be different builds, and the one doing the work
  // is the server.
  if (runtime.version) return runtime.version()

  const { bin } = runtime.resolveBin()
  if (!bin) return null

  const result = await run(bin, runtime.versionArgs, { timeoutMs: 10000 })
  if (result.code !== 0) return null
  return result.stdout.trim().split("\n")[0] || null
}

// What this runtime can actually run, when only the machine knows.
//
// Every hosted vendor has a catalogue we can hold as a constant. A model the
// user pulled onto their own disk has no catalogue anywhere but that disk, so
// the runtime reports it and the server stores it per device. A runtime that
// doesn't declare `reportsModels` has a curated list and contributes nothing
// here.
export async function runtimeModels(runtime) {
  if (!runtime.reportsModels || typeof runtime.listModels !== "function") return []

  try {
    return await runtime.listModels()
  } catch {
    // A model list we couldn't read is not a reason to fail a scan. The stored
    // catalogue simply stays as it was until the next one succeeds.
    return []
  }
}

// Is this profile signed in and usable? The cheapest possible real request: if
// it answers at all, the login works.
export async function probeProfile(runtime, slug) {
  // Runtimes with no login have their own idea of "usable" — for Ollama it is
  // "the server answers and has a model", which no spawn could establish.
  if (runtime.probe) return runtime.probe(slug)

  const { bin } = runtime.resolveBin()
  if (!bin) return { status: "not_installed" }

  const result = await run(bin, runtime.probeArgs(), {
    env: envForProfile(runtime, slug),
    timeoutMs: PROBE_TIMEOUT_MS
  })

  if (result.code === 0) return { status: "ready" }

  const message = `${result.stderr}\n${result.stdout}`.toLowerCase()
  // Anything auth-shaped is "sign in again"; everything else is genuinely
  // unknown and shouldn't be reported as a login problem the user can't find.
  if (/login|log in|auth|unauthor|credential|sign in|expired|api key/.test(message)) {
    return { status: "logged_out" }
  }
  return { status: "unknown", detail: result.stderr.trim().slice(0, 200) }
}

// Interactive sign-in for a profile. stdio is inherited so the user sees the
// vendor's own login flow — we are handing over, not proxying, and the
// credential it writes is never something we read.
export function loginProfile(runtime, slug, options = {}) {
  return new Promise((resolve) => {
    // Options reach the adapter rather than the argv directly: a sign-in flag
    // is the vendor's own vocabulary (Grok Build spells the no-browser flow
    // `--device-auth`), and an adapter that has no such flow ignores the
    // argument entirely.
    const args = runtime.loginArgs(options)
    if (!args) return resolve(false)

    const child = spawn(runtime.resolveBin().bin || runtime.cli, args, {
      env: { ...process.env, ...envForProfile(runtime, slug) },
      stdio: "inherit"
    })
    child.on("close", (code) => resolve(code === 0))
    child.on("error", () => resolve(false))
  })
}

// Flatten a conversation into one prompt.
//
// These CLIs take a single prompt rather than a message array, so prior turns
// are rendered inline. That is a real difference from calling a Messages API
// directly, and it is why a long conversation costs more here than it would
// with prompt caching on the API path.
function renderConversation(messages) {
  return messages
    .map((message) => {
      const role = message.role === "assistant" ? "Assistant" : "User"
      const content = typeof message.content === "string" ? message.content : JSON.stringify(message.content)
      return `${role}: ${content}`
    })
    .join("\n\n")
    .concat("\n\nAssistant:")
}

// Some failures mean "this build is older than these flags" rather than "the
// run failed". Detected so we can retry a reduced invocation instead of
// telling the user their perfectly good machine is broken.
function looksUnsupported(stderr) {
  return /unknown option|unrecognized option|unknown argument|invalid( value for)? --output-format|requires --verbose|unknown arguments?:/i
    .test(String(stderr || ""))
}

// The flags that buy capability rather than correctness. If a build rejects one
// of these, the right outcome is a turn that runs with less — the model edits
// files and says it cannot ship — not a turn that dies. Losing the whole run to
// a flag we added is the failure mode this codebase has already produced twice.
const CAPABILITY_FLAGS = new Set([
  "--mcp-config", "--allowedTools", "--disallowedTools", "--permission-mode",
  "--allowed-tools", "--exclude-tools", "--approval-mode", "--force", "--workspace",
  // codex: the sandbox/approval composite and the trust-check bypass.
  "--full-auto", "--sandbox", "--skip-git-repo-check",
  // antigravity: the edits-only auto-approval (one token, spelled with `=`).
  "--mode=accept-edits",
  // codewhale: run-without-asking; its --sandbox is already covered above.
  "--auto",
  // grok: the automation hygiene flag only. `--yolo`, `--allow` and `--deny`
  // are deliberately absent — dropping those on a degraded retry would leave a
  // run auto-approving tool calls with no deny list behind it, which is worse
  // than the failed run that a rejected flag otherwise causes.
  "--no-auto-update",
  // claude_code: the effort dial. A build older than the flag runs the turn
  // at its default effort rather than not at all. `--resume` is deliberately
  // NOT here: stripping it would leave a resumed turn's prompt — the new
  // message alone — with no history behind it; a resume that fails is
  // retried by the adapter's fallbackJob instead, with the full history.
  "--effort"
])

function rejectedCapabilityFlag(stderr) {
  const text = String(stderr || "")
  if (!looksUnsupported(text)) return null

  for (const flag of CAPABILITY_FLAGS) {
    if (text.includes(flag)) return flag
  }
  return null
}

// Drop every capability flag and the values that belong to it. The variadic
// ones own every word up to the next flag; the rest own exactly one, and a
// boolean flag (`--force`) owns none — which is why the loop peeks rather than
// assuming.
//
// Exported so the degraded argv can be asserted rather than assumed.
export function withoutCapabilityFlags(args) {
  const out = []
  for (let i = 0; i < args.length; i++) {
    if (!CAPABILITY_FLAGS.has(args[i])) { out.push(args[i]); continue }
    while (i + 1 < args.length && !args[i + 1].startsWith("-")) i++
  }
  return out
}

// Everything about telling the server what a run is doing, in one place.
//
// It has to be one place because the two transports would otherwise each grow
// their own answer to the same four questions: what is it doing, how much has
// it written, how do I stop it, and how often may I say so. Those answers are
// tuned (see MIN_NOTE_INTERVAL_MS and HEARTBEAT_EVERY_MS) and drift between
// two copies is invisible until a local run stops streaming in the web app.
//
// `control` is filled in later by whichever runner is used — with a kill() for
// a child process, or an abort() for a request. Handed to the caller on every
// post so it can stop the run the moment the server answers a heartbeat with
// "this job was cancelled".
function progressTracker(runtime, onProgress, control) {
  let lastNote = null      // the newest thing we know it is doing
  let postedNote = null    // the newest thing we have told the server
  let lastPost = 0
  let partialText = ""     // every answer token seen so far, in order
  let postedPartial = ""   // how much of it the server has been sent
  // Reasoning tokens, buffered until they make a sentence (or a tool call
  // arrives). Posted as a thinking-log line rather than the ticker word
  // "Thinking", which is what used to fill a Grok turn and say nothing.
  let thoughtBuf = ""

  // Every path this run wrote, in order, deduped by the Set. Read back at the
  // end and sent with the result, so a document produced on this machine
  // exists somewhere other than this machine. See documents.js.
  const written = new Set()

  const cancel = () => { try { control.kill?.() } catch { /* already gone */ } }

  // `repeat` distinguishes the two reasons we post. A note the server has
  // already seen is liveness only and must not be appended to the visible
  // trace again — that is what turned the ticker into "Reading foo.rb" six
  // times in a row when the model was doing one thing slowly.
  //
  // `partial` rides along on every post — heartbeats included, since the
  // answer keeps growing while the note stands still. Null when there is no
  // text yet, so a run that never streams posts exactly what it always did.
  const post = (repeat) => {
    if (!onProgress) return
    lastPost = Date.now()
    postedNote = lastNote
    postedPartial = partialText
    onProgress(lastNote || "Working", { repeat, partial: partialText || null, cancel })
  }

  const flushThought = () => {
    const snippet = thoughtBuf.replace(/\s+/g, " ").trim()
    thoughtBuf = ""
    if (!snippet) return
    lastNote = snippet.slice(0, 180)
  }

  return {
    written,

    // Timer-driven: keeps the run alive in the server's eyes even when the
    // model has been silent for minutes inside a single tool call.
    onTick: () => { if (Date.now() - lastPost >= HEARTBEAT_EVERY_MS) post(true) },

    onEvent: (event) => {
      const text = runtime.partialTextFrom ? runtime.partialTextFrom(event) : null
      if (text) partialText += text

      const thought = runtime.partialThoughtFrom ? runtime.partialThoughtFrom(event) : null
      if (thought) thoughtBuf += thought

      // A runtime that has not taught us how to spot a write simply reports
      // no documents — the run is unaffected.
      const wrote = runtime.writtenPathFrom ? runtime.writtenPathFrom(event) : null
      if (wrote) written.add(wrote)

      const note = runtime.describeEvent(event)
      if (note) {
        // A real action: land any buffered reasoning first so the log reads
        // "why, then what it did" — Claude's thought process then its tool
        // step — rather than dropping the reasoning on the floor.
        if (thoughtBuf.trim()) {
          flushThought()
          if (onProgress && lastNote !== postedNote) post(false)
        }
        lastNote = note
      } else if (thoughtBuf.includes("\n") || thoughtBuf.length >= 160) {
        flushThought()
      }
      if (!onProgress) return

      const changed = lastNote !== null && lastNote !== postedNote
      if (changed && Date.now() - lastPost >= MIN_NOTE_INTERVAL_MS) {
        post(false)
      } else if (partialText !== postedPartial && Date.now() - lastPost >= MIN_NOTE_INTERVAL_MS) {
        // Fresh answer text under an unchanged note. Posted as a repeat so
        // the ticker doesn't grow a duplicate line, at the same once-a-second
        // ceiling notes get — that cadence is what makes a local run stream
        // in the web app instead of arriving whole at the end.
        post(true)
      }
    }
  }
}

// A tool_call whether the projector flattened it or nested it. Salvage used
// to count only the top-level `type`, so a run whose calls sat one object
// down looked like it had done nothing — and was reported as a failure.
function isToolCallEvent(event) {
  if (!event || typeof event !== "object") return false
  if (event.type === "tool_call" || event.sessionUpdate === "tool_call") return true
  const update = event.params?.update
  if (update?.sessionUpdate === "tool_call" || update?.type === "tool_call") return true
  const nested = event.data || event.payload || event.update
  return !!(nested && typeof nested === "object" &&
    (nested.type === "tool_call" || nested.sessionUpdate === "tool_call" || nested.toolCall))
}

// A turn that DID the work and never said so.
//
// The case is real and it has now cost a user twice: a Grok run edited a file,
// pushed a branch and opened a pull request, and the web app showed "Error"
// because the adapter never saw a closing message. The work existed on GitHub;
// the session recorded a failure. That is the worst of both — the person
// believes nothing happened, and the turn's documents are thrown away on the
// way out.
//
// So a run that FINISHED (its own `end` event, no in-band error) and visibly
// DID something is salvaged rather than failed. What comes back is not an
// invented answer: it says plainly that the closing message did not arrive, and
// then states only what the run's own events prove. A missing answer stays
// visible — which is what surfaced the parsing bug in the first place — while
// the turn, the spend and the files survive it.
//
// null when there is nothing to salvage: no `end`, an error, or a run with no
// tool call to its name, which is a run that genuinely did nothing.
export function salvagedAnswer(runtime, result, output, written) {
  if (output?.isError || !output?.sawResult) return null

  const events = result?.events || []
  const tools = events.filter((event) => isToolCallEvent(event)).length
  const paths = [...(written || [])].filter(Boolean)
  if (tools === 0 && paths.length === 0) return null

  const lines = [
    `${runtime.name} finished its turn without a closing message, so there is no answer to show — ` +
    "but the run did do work, and it is listed below rather than lost."
  ]

  if (tools > 0) lines.push("", `Tool calls: ${tools}.`)
  if (paths.length > 0) {
    lines.push("", "Files it wrote:", ...paths.slice(0, 20).map((path) => `- ${path}`))
    if (paths.length > 20) lines.push(`- …and ${paths.length - 20} more`)
  }
  if (output.stopReason) lines.push("", `It stopped with "${output.stopReason}".`)
  for (const warning of (output.warnings || []).slice(0, 2)) lines.push("", warning)

  lines.push(
    "",
    "Check the run's own output (a diff, a branch, a pull request) before asking for it again — " +
    "repeating the request would repeat the work, not recover the answer."
  )
  return lines.join("\n")
}

// A run that spent a whole turn and produced no answer. This used to be the
// bare sentence, and the bare sentence is unactionable: the person sees
// "finished without producing an answer" and nobody — them, us, or the next
// reader of the log — can tell a model that stopped at its turn limit from a
// refusal from an adapter that no longer recognises the build's event shape.
// Those need different fixes, and the run already knows which it was.
//
// So the message carries the run's own evidence: why it stopped, and a tally of
// the event types it did emit. A tally of `thought` and `tool_call` with no
// `text` in it is an adapter that read the stream and missed the answer; a
// tally with `end` and a stop reason is the model's own decision; an empty
// tally is a CLI that wrote nothing we could parse.
export function noAnswerError(runtime, result, output) {
  const tally = new Map()
  for (const event of result?.events || []) {
    const type = String(event?.type || event?.sessionUpdate || "untyped")
    tally.set(type, (tally.get(type) || 0) + 1)
  }

  const parts = [`${runtime.name} finished without producing an answer.`]
  if (output?.stopReason) parts.push(`It stopped with "${output.stopReason}".`)

  if (tally.size === 0) {
    parts.push("It emitted no events this adapter could read.")
  } else {
    const seen = [...tally.entries()].map(([type, n]) => (n > 1 ? `${type}×${n}` : type)).join(", ")
    parts.push(`The run reported: ${seen}.`)
  }

  // The adapter's own warnings say the most useful thing of all when they are
  // there — a turn limit reached, a compaction that failed.
  for (const warning of (output?.warnings || []).slice(0, 2)) parts.push(warning)

  return new Error(parts.join(" "))
}

export async function runCompletion(job, { onProgress } = {}) {
  const runtime = getRuntime(job.runtime || DEFAULT_RUNTIME)
  if (!runtime) {
    throw new Error(`This companion can't drive "${job.runtime}". Update cma-agent.`)
  }

  // "Present" is the adapter's question, not this file's: a binary for the
  // CLIs, a server that answers for Ollama — which may not even be on this
  // host.
  if (!isInstalled(runtime)) {
    throw new Error(`${runtime.name} isn't installed on this machine, or isn't on PATH.`)
  }

  if (isHttpRuntime(runtime)) return runHttpCompletion(runtime, job, { onProgress })

  const { bin } = runtime.resolveBin()

  const conversation = renderConversation(job.messages || [])
  // Runtimes with no system-prompt flag fold it into the prompt instead. The
  // ones that have a flag return the conversation untouched.
  const prompt = runtime.renderPrompt ? runtime.renderPrompt(job, conversation) : conversation

  const configDir = configDirFor(runtime, job.profileSlug)
  // Where an adapter may put files of its own, handed as a thunk so the
  // directory is only created for runtimes that actually ask. For Cursor and
  // Codex it is the managed config directory itself; for Gemini and CodeWhale
  // it is our profile directory even on the ambient login, because their MCP
  // wiring is a file an environment variable points at rather than anything
  // the vendor CLI finds on its own. A thunk from HERE rather than an import
  // THERE, deliberately: config.js resolves its home once at import time, and
  // an adapter importing it would drag that resolution into the runtime
  // registry's static import chain — the exact trap accounts.test.js
  // documents staging its home around.
  const filesDir = () => configDir || ensureProfileDir(runtime, job.profileSlug)

  // Adapters that need files on disk write them here, before anything is
  // spawned. Called for the ambient login too — which used to be skipped, and
  // that was right while the only prepared files lived inside a managed
  // config directory (Cursor's permissions, Codex's config.toml; neither has
  // an ambient mode). Gemini's and CodeWhale's MCP files changed that.
  if (runtime.prepare) runtime.prepare(job, { configDir, filesDir })

  const env = { ...envForProfile(runtime, job.profileSlug), ...runtime.envFor(job, { filesDir }) }
  const args = runtime.streamingArgs(job, runtime.promptOnStdin ? undefined : prompt)
  const stdin = runtime.promptOnStdin ? prompt : undefined

  // ── Streaming. This is the path that makes a long run survivable: events
  // arrive continuously, so we can distinguish "still working" from "stopped
  // responding" instead of guessing a duration.
  const control = {}
  const tracker = progressTracker(runtime, onProgress, control)
  const written = tracker.written
  // When this run began, for document discovery: a .docx a script makes has
  // no Write tool call to track, but it does have an mtime inside the run.
  const startedAt = Date.now()

  const result = await runStreaming(bin, args, {
    env,
    cwd: job.workdir,
    input: stdin,
    control,
    onTick: tracker.onTick,
    onEvent: tracker.onEvent
  })

  if (result.spawnError && result.spawnError.code === "ENOENT") {
    throw new Error(`${runtime.name} isn't installed on this machine, or isn't on PATH.`)
  }

  // Nothing parseable and a non-zero exit → almost certainly a build that
  // doesn't take these flags. Degrade rather than fail.
  if (result.events.length === 0 && result.code !== 0 && looksUnsupported(result.stderr)) {
    const rejected = rejectedCapabilityFlag(result.stderr)
    if (rejected) {
      // Say it plainly in the companion's log: the run continues, but without
      // the tools, so "it edited files and then couldn't push" has a stated
      // cause instead of looking like the feature is broken again.
      process.stderr.write(
        `! This ${runtime.name} build rejected ${rejected}. Retrying without the tool allowance — ` +
        `this turn can answer but may not be able to ship its work. Upgrade ${runtime.name} to restore it.\n`
      )
      return runDegraded(runtime, bin, job, { args, env, stdin, prompt })
    }
    if (runtime.supportsBuffered) return runBuffered(runtime, bin, job, { env, stdin, prompt })
  }

  // Deliberate stop, not a failure of the machine. The server has already
  // marked the job cancelled — reporting is a courtesy for its logs, and an
  // older server just acks a result for a finished job and moves on.
  if (result.killed) throw new Error("The run was cancelled from the web app.")

  if (result.idleOut) {
    throw new Error(
      `${runtime.name} produced no output for ${Math.round(IDLE_TIMEOUT_MS / 1000)}s and was stopped. ` +
      "The machine may have slept, or the run is genuinely stuck."
    )
  }
  if (result.overran) throw new Error(`${runtime.name} ran past the safety ceiling and was stopped.`)

  // An adapter may answer a failed run with a different job to run instead
  // — Claude Code's --resume of a transcript this machine no longer holds is
  // retried as an ordinary full-history turn. The adapter decides (and hands
  // back a job that cannot ask again), this file only re-runs it: the whole
  // pipeline, prompt rendering included, since the prompt is what changed.
  // Below the cancel/idle/ceiling checks on purpose: a run the web app
  // stopped is not one to run again.
  if (result.code !== 0 && typeof runtime.fallbackJob === "function") {
    const retry = runtime.fallbackJob(job, result)
    if (retry) {
      process.stderr.write(`! ${runtime.name} could not continue the previous session on this machine — ` +
                           "running this turn with the full conversation instead.\n")
      return runCompletion(retry, { onProgress })
    }
  }

  const output = runtime.collapseEvents(result.events)

  if (result.code !== 0 && !output.sawResult) {
    throw runtime.classifyFailure(
      (result.stderr || "").trim().slice(0, 500) || `${runtime.name} exited with an error.`,
      failureContext(job)
    )
  }

  // A zero exit does not mean success: every one of these CLIs surfaces API
  // errors, refusals and rate limits in-band. Without this check the error
  // text would be stored and rendered as the assistant's answer, which is both
  // wrong and confusing to debug.
  if (output.isError) {
    throw runtime.classifyFailure(
      output.content || output.errorStatus || `${runtime.name} reported an error.`,
      failureContext(job)
    )
  }

  // Collected before the check below, not after it: a run that finished without
  // a closing message may still have produced the deliverable, and throwing
  // first is what used to discard it.
  const files = safeCollect(job, written, startedAt)

  if (!output.content) {
    const salvaged = salvagedAnswer(runtime, result, output, written)
    if (!salvaged) throw noAnswerError(runtime, result, output)

    process.stderr.write(`! ${runtime.name} produced no closing message; reporting what the run did instead.\n`)
    return { ...output, content: salvaged, files }
  }

  // Last, and never fatal. The answer is already written and the run
  // succeeded; a file that cannot be read back is a missing card in the web
  // app, not a failed turn.
  return { ...output, files }
}

// The HTTP path, end to end.
//
// Shorter than the CLI path by everything the CLI path exists to survive:
// there is no argv to have rejected, so no degraded retry; no buffered
// fallback, because an endpoint that streams has always streamed; and no
// documents to collect, because a runtime reached this way has no filesystem
// (see `filesystem: false` on the adapter). What is left is the part that
// matters — stream it, watch for silence, and read the outcome out of the
// runtime's own events rather than out of a status code.
async function runHttpCompletion(runtime, job, { onProgress } = {}) {
  const control = {}
  const tracker = progressTracker(runtime, onProgress, control)
  const request = runtime.buildRequest(job)

  // Where we actually knocked. Threaded into every failure below so a message
  // that names an address names THIS run's address, rather than whatever the
  // environment would resolve to by the time the error is built.
  const at = { url: request.url }

  const result = await runStreamingHttp(request, {
    control,
    onTick: tracker.onTick,
    onEvent: tracker.onEvent
  })

  if (result.killed) throw new Error("The run was cancelled from the web app.")

  if (result.idleOut) {
    throw new Error(
      `${runtime.name} produced no output for ${Math.round(IDLE_TIMEOUT_MS / 1000)}s and was stopped. ` +
      "The machine may have slept, or the model is genuinely stuck."
    )
  }
  if (result.overran) throw new Error(`${runtime.name} ran past the safety ceiling and was stopped.`)

  // Nothing arrived at all. That is the connection, not the model — and the
  // adapter's classifier is what turns it into an instruction.
  if (result.spawnError) {
    throw runtime.classifyFailure(String(result.spawnError.message || result.spawnError).slice(0, 500), at)
  }

  const output = runtime.collapseEvents(result.events)

  // An in-band error (a model that isn't pulled, a machine out of memory)
  // arrives as an event with a 200 around it, so this check is not a fallback
  // for the status code — it is the primary one.
  if (output.isError) {
    throw runtime.classifyFailure(output.errorStatus || output.content || `${runtime.name} reported an error.`, at)
  }

  if (result.code !== 0 && !output.sawResult) {
    throw runtime.classifyFailure(
      (result.stderr || "").trim().slice(0, 500) || `${runtime.name} stopped without finishing.`, at
    )
  }

  if (!output.content) throw noAnswerError(runtime, result, output)

  // Some of what an adapter reports is only knowable after the answer —
  // Ollama reads the window the model actually ran with off /api/ps once the
  // run is over. Optional, and never the reason a finished run fails.
  const settled = typeof runtime.afterRun === "function"
    ? await Promise.resolve().then(() => runtime.afterRun(output, job)).catch(() => output)
    : output

  // No files, always. Said explicitly rather than left to a falsy default, so
  // the shape a caller receives is the same one the CLI path returns.
  return { ...settled, files: [] }
}

function safeCollect(job, written, startedAt) {
  // No early-out on an empty `written` any more: a run whose only deliverable
  // was made by a script (a .docx out of python-docx, say) reports no Write
  // calls at all, and discovery-by-mtime is how that file gets home.
  if (!job.workdir) return []

  try {
    return collectDocuments(job.workdir, written, { since: startedAt })
  } catch (error) {
    process.stderr.write(`! Couldn't collect this run's documents: ${error.message}\n`)
    return []
  }
}

// Same transport, fewer flags. Used when a build rejects a capability flag we
// added: the turn runs with less rather than not at all.
async function runDegraded(runtime, bin, job, { args, env, stdin }) {
  const result = await runStreaming(bin, withoutCapabilityFlags(args), {
    env, cwd: job.workdir, input: stdin
  })

  const output = runtime.collapseEvents(result.events)
  if (result.code !== 0 && !output.sawResult) {
    throw runtime.classifyFailure((result.stderr || "").trim().slice(0, 500), failureContext(job))
  }
  if (output.isError) throw runtime.classifyFailure(output.content || output.errorStatus, failureContext(job))
  if (!output.content) throw noAnswerError(runtime, result, output)
  return output
}

// The original buffered invocation, kept for a Claude Code that predates
// stream-json. It still cannot tell a long run from a dead one — that
// limitation is inherent to buffering, which is exactly why it is the fallback
// and not the default, and why only the runtime that needs it declares it.
async function runBuffered(runtime, bin, job, { env, stdin, prompt }) {
  const args = runtime.bufferedArgs(job, runtime.promptOnStdin ? undefined : prompt)
  const result = await run(bin, args, {
    env, input: stdin, cwd: job.workdir, timeoutMs: MAX_RUN_MS
  })

  if (result.spawnError && result.spawnError.code === "ENOENT") {
    throw new Error(`${runtime.name} isn't installed on this machine, or isn't on PATH.`)
  }
  if (result.timedOut) {
    throw new Error(`${runtime.name} didn't finish in time. The machine may have slept mid-run.`)
  }
  if (result.code !== 0) {
    throw runtime.classifyFailure((result.stderr || result.stdout).trim().slice(0, 500), failureContext(job))
  }

  const output = runtime.parseBuffered(result.stdout)
  if (output.isError) {
    throw runtime.classifyFailure(
      output.content || output.errorStatus || `${runtime.name} reported an error.`,
      failureContext(job)
    )
  }
  return output
}
