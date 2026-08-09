import os from "node:os"

import * as api from "./api.js"
import { runCompletion } from "./engine.js"
import { scanProfiles, resolveSlug, runtimeVersions } from "./profiles.js"
import { getRuntime, installedRuntimes, RUNTIMES } from "./runtimes/index.js"
import { resolveRepo, runCommand, COMMANDS } from "./repos.js"
import { VERSION } from "./version.js"

const HEARTBEAT_MS = 30000
// Re-scan occasionally so a login that expired in the background shows as
// "signed out" in the web UI before someone tries to use it.
const RESCAN_MS = 10 * 60 * 1000

// Backoff for a server we can't reach. Capped low: this is a laptop closing
// its lid and reopening, not a service outage to ride out, and a user who
// reopens their machine expects it working within seconds.
const BACKOFF_START_MS = 2000
const BACKOFF_MAX_MS = 30000

export async function start({ log = console.log } = {}) {
  const installed = installedRuntimes()
  if (installed.length === 0) {
    log("! No coding CLI this companion can drive is installed on this machine.")
    for (const runtime of RUNTIMES) log(`    ${runtime.name}: ${runtime.install}`)
    return 1
  }

  const versions = await runtimeVersions()

  // Say it even on success: a service started by launchd will be running the
  // copy we resolved, not whatever the user's terminal finds, and the two
  // disagreeing is worth seeing in the log before it causes confusion.
  for (const runtime of installed) {
    const advice = runtime.advice()
    if (advice) log(`  ${advice}`)
  }

  const summary = installed.map((r) => `${r.name} ${versions[r.id] || "?"}`).join(" · ")
  log(`cma-agent ${VERSION} · ${summary}`)
  log(`Host: ${os.hostname()}`)

  let running = true
  const stop = () => {
    running = false
    log("\nStopping — finishing anything in flight first.")
  }
  process.on("SIGINT", stop)
  process.on("SIGTERM", stop)

  const beat = async () => {
    try {
      await api.heartbeat({ agentVersion: VERSION, runtimeVersions: versions })
    } catch (error) {
      if (error.status === 409) {
        log("! This machine's session lapsed after two weeks of silence. Run `cma-agent verify`.")
      } else if (error.status === 401) {
        log("! This machine is no longer paired. Run `cma-agent pair`.")
        running = false
      }
    }
  }

  const rescan = async () => {
    try {
      await api.syncProfiles(await scanProfiles())
    } catch (_error) {
      // Nothing to do about a failed scan report — the next one will carry it.
    }
  }

  await beat()
  await rescan()
  const heartbeatTimer = setInterval(beat, HEARTBEAT_MS)
  const rescanTimer = setInterval(rescan, RESCAN_MS)

  log("Waiting for work. Leave this running.")

  let backoff = BACKOFF_START_MS

  try {
    while (running) {
      let job = null
      try {
        job = await api.claimJob({ wait: 25 })
        backoff = BACKOFF_START_MS
      } catch (error) {
        if (error.status === 401) {
          log("! This machine is no longer paired. Run `cma-agent pair`.")
          break
        }
        if (error.status === 409) {
          // Session lapsed. Keep heartbeating so `cma-agent verify` from
          // another terminal brings us straight back without a restart.
          await sleep(HEARTBEAT_MS)
          continue
        }
        await sleep(backoff)
        backoff = Math.min(backoff * 2, BACKOFF_MAX_MS)
        continue
      }

      if (!job) continue

      await handleJob(job, log)
    }
  } finally {
    clearInterval(heartbeatTimer)
    clearInterval(rescanTimer)
  }

  return 0
}

async function handleJob(job, log) {
  const started = Date.now()

  // Git and repository questions don't involve Claude at all — they are this
  // machine answering about itself. Handled first so a runtime mismatch on the
  // Claude side can't block someone from seeing their own branches.
  const kind = job.kind || "completion"
  if (kind in COMMANDS) {
    log(`→ ${kind}…`)
    try {
      const data = await runCommand(kind, job.params || {})
      await api.submitResult(job.id, { data })
      log(`✓ ${kind} in ${Math.round((Date.now() - started) / 1000)}s`)
    } catch (error) {
      try {
        await api.submitResult(job.id, { error: error.message })
      } catch (_reportError) {
        log(`! Couldn't report the failure for job ${job.id}`)
      }
      log(`✗ ${error.message}`)
    }
    return
  }

  // The server may know about runtimes this build can't drive, or name one
  // whose CLI isn't installed here. Refusing with a clear reason beats running
  // the job under the wrong CLI, which would spend the wrong subscription.
  //
  // Two different failures, two different messages: "update the companion" and
  // "install the CLI" send someone to opposite places.
  const runtime = job.runtime ? getRuntime(job.runtime) : getRuntime(null)
  if (!runtime || !runtime.resolveBin().bin) {
    const message = runtime
      ? `${runtime.name} isn't installed on this machine. Install it from ${runtime.install}, then run \`cma-agent runtimes:scan\`.`
      : `This companion can't drive "${job.runtime}". Update cma-agent, or point that provider at a different runtime.`

    log(`✗ ${message}`)
    try {
      await api.submitResult(job.id, { error: message })
    } catch (_error) {
      log(`! Couldn't report the mismatch for job ${job.id}`)
    }
    return
  }

  // A coding turn against a local repository runs Claude Code *in* that
  // directory, with its own tools. That is the difference between describing
  // a change and making one — and it is why this path exists rather than
  // flattening the repo into a prompt. The path is still validated against the
  // shared-folder allowlist here; the server asking is not authorization.
  let workdir = null
  if (job.workdir) {
    try {
      workdir = resolveRepo(job.workdir)
    } catch (error) {
      try {
        await api.submitResult(job.id, { error: error.message })
      } catch (_reportError) {
        log(`! Couldn't report the failure for job ${job.id}`)
      }
      log(`✗ ${error.message}`)
      return
    }
  }

  log(
    `→ ${runtime.name}: ${job.model || "default model"} on "${job.profile_slug || "default"}"` +
    `${workdir ? ` in ${workdir}` : ""}…`
  )

  try {
    const output = await runCompletion(
      { ...job, runtime: runtime.id, workdir, profileSlug: resolveSlug(job.profile_slug) },
      {
        // Two jobs at once: keep the server's wait alive, and give the person
        // watching the web app the same running ticker they would see in a
        // terminal. Errors are swallowed — a heartbeat that fails to post is
        // not a reason to kill a run that is going fine.
        // `repeat` means this is a liveness beat for something already
        // reported, not a new action. Still posted — the server is waiting on
        // it — but not printed, so the terminal shows what happened rather
        // than how often we said so.
        // `partial` is the answer so far; it rides every post so the web app
        // can stream a local run. `cancel` SIGKILLs the running CLI — invoked
        // only when the server's ack says the job is cancelled, i.e. the
        // person pressed Stop and the answer is unwanted. An older server
        // never says so, and this build just runs to completion as before.
        onProgress: (note, { repeat, partial, cancel } = {}) => {
          if (!repeat) log(`  · ${note}`)
          api.reportProgress(job.id, note, { repeat, partial })
            .then((data) => {
              if (data?.state === "cancelled" && cancel) {
                log("  · Cancelled from the web app — stopping Claude Code.")
                cancel()
              }
            })
            .catch(() => {})
        }
      }
    )

    await api.submitResult(job.id, {
      content: output.content,
      model: output.model,
      stop_reason: output.stopReason,
      usage: output.usage
    })

    log(`✓ Done in ${Math.round((Date.now() - started) / 1000)}s`)
  } catch (error) {
    // Report the failure rather than dropping it: the person waiting in the
    // browser gets the real reason, instead of a request that hangs until the
    // server's own timeout and then says nothing useful.
    try {
      await api.submitResult(job.id, { error: error.message })
    } catch (_reportError) {
      log(`! Couldn't report the failure for job ${job.id}`)
    }
    log(`✗ ${error.message}`)
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
