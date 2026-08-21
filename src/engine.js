import { spawn } from "node:child_process"

import { ensureProfileDir } from "./config.js"
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

    child.on("error", (error) => {
      clearTimeout(timer)
      resolve({ code: -1, stdout, stderr: error.message, timedOut: false, spawnError: error })
    })

    child.on("close", (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr, timedOut })
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

    const finish = (code, spawnError) => {
      clearInterval(watchdog)
      if (heartbeat) clearInterval(heartbeat)
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

// A runtime's per-profile environment.
//
// The empty slug is the ambient login — the one you get by running the CLI
// with no override set. Most people have exactly that and nothing else, and it
// should work with no setup at all. Cursor is the exception (`ambientProfile:
// false`): its allowance is a file we have to own, so even "default" is a
// directory we manage. See src/runtimes/cursor.js.
export function envForProfile(runtime, slug) {
  if (!runtime.configDirEnvVar) return {}
  if (!slug && runtime.ambientProfile !== false) return {}

  return { [runtime.configDirEnvVar]: ensureProfileDir(runtime, slug) }
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
export function loginProfile(runtime, slug) {
  return new Promise((resolve) => {
    const args = runtime.loginArgs()
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
  "--allowed-tools", "--approval-mode", "--force", "--workspace"
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

  return {
    written,

    // Timer-driven: keeps the run alive in the server's eyes even when the
    // model has been silent for minutes inside a single tool call.
    onTick: () => { if (Date.now() - lastPost >= HEARTBEAT_EVERY_MS) post(true) },

    onEvent: (event) => {
      const text = runtime.partialTextFrom ? runtime.partialTextFrom(event) : null
      if (text) partialText += text

      // A runtime that has not taught us how to spot a write simply reports
      // no documents — the run is unaffected.
      const wrote = runtime.writtenPathFrom ? runtime.writtenPathFrom(event) : null
      if (wrote) written.add(wrote)

      const note = runtime.describeEvent(event)
      if (note) lastNote = note
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
  // Adapters that need files on disk (Cursor's permissions and MCP wiring)
  // write them here, before anything is spawned.
  if (runtime.prepare && configDir) runtime.prepare(job, { configDir })

  const env = { ...envForProfile(runtime, job.profileSlug), ...runtime.envFor(job) }
  const args = runtime.streamingArgs(job, runtime.promptOnStdin ? undefined : prompt)
  const stdin = runtime.promptOnStdin ? prompt : undefined

  // ── Streaming. This is the path that makes a long run survivable: events
  // arrive continuously, so we can distinguish "still working" from "stopped
  // responding" instead of guessing a duration.
  const control = {}
  const tracker = progressTracker(runtime, onProgress, control)
  const written = tracker.written

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

  const output = runtime.collapseEvents(result.events)

  if (result.code !== 0 && !output.sawResult) {
    throw runtime.classifyFailure(
      (result.stderr || "").trim().slice(0, 500) || `${runtime.name} exited with an error.`
    )
  }

  // A zero exit does not mean success: every one of these CLIs surfaces API
  // errors, refusals and rate limits in-band. Without this check the error
  // text would be stored and rendered as the assistant's answer, which is both
  // wrong and confusing to debug.
  if (output.isError) {
    throw runtime.classifyFailure(output.content || output.errorStatus || `${runtime.name} reported an error.`)
  }

  if (!output.content) throw new Error(`${runtime.name} finished without producing an answer.`)

  // Last, and never fatal. The answer is already written and the run
  // succeeded; a file that cannot be read back is a missing card in the web
  // app, not a failed turn.
  return { ...output, files: safeCollect(job, written) }
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

  if (!output.content) throw new Error(`${runtime.name} finished without producing an answer.`)

  // No files, always. Said explicitly rather than left to a falsy default, so
  // the shape a caller receives is the same one the CLI path returns.
  return { ...output, files: [] }
}

function safeCollect(job, written) {
  if (!job.workdir || written.size === 0) return []

  try {
    return collectDocuments(job.workdir, written)
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
    throw runtime.classifyFailure((result.stderr || "").trim().slice(0, 500))
  }
  if (output.isError) throw runtime.classifyFailure(output.content || output.errorStatus)
  if (!output.content) throw new Error(`${runtime.name} finished without producing an answer.`)
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
    throw runtime.classifyFailure((result.stderr || result.stdout).trim().slice(0, 500))
  }

  const output = runtime.parseBuffered(result.stdout)
  if (output.isError) {
    throw runtime.classifyFailure(output.content || output.errorStatus || `${runtime.name} reported an error.`)
  }
  return output
}
