import os from "node:os"

import * as api from "./api.js"
import { claudeAdvice, claudeVersion, runCompletion } from "./claude.js"
import { scanProfiles, resolveSlug, RUNTIME } from "./profiles.js"
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
  const claudeVer = await claudeVersion()
  if (!claudeVer) {
    log(`! ${claudeAdvice() || "Claude Code isn't usable on this machine."}`)
    return 1
  }

  // Say it even on success: a service started by launchd will be running the
  // copy we resolved, not whatever the user's terminal finds, and the two
  // disagreeing is worth seeing in the log before it causes confusion.
  const advice = claudeAdvice()
  if (advice) log(`  ${advice}`)

  log(`cma-agent ${VERSION} · Claude Code ${claudeVer}`)
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
      await api.heartbeat({ agentVersion: VERSION, claudeCodeVersion: claudeVer })
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

  // The server may know about runtimes this build can't drive. Refusing with a
  // clear reason beats running the job under the wrong CLI, which would spend
  // the wrong subscription.
  if (job.runtime && job.runtime !== RUNTIME) {
    const message = `This machine's companion runs ${RUNTIME}, not ${job.runtime}. Update cma-agent, or point that provider at a different runtime.`
    log(`✗ ${message}`)
    try {
      await api.submitResult(job.id, { error: message })
    } catch (_error) {
      log(`! Couldn't report the mismatch for job ${job.id}`)
    }
    return
  }

  log(`→ Running ${job.model || "default model"} on "${job.profile_slug || "default"}"…`)

  try {
    const output = await runCompletion({ ...job, profileSlug: resolveSlug(job.profile_slug) })

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
