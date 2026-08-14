import os from "node:os"

import * as api from "./api.js"
import { readConfig } from "./config.js"
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

// ---------------------------------------------------------------------------
// How many things at once.
//
// This loop used to be strictly serial: claim a job, run it to completion,
// claim the next. Anyone with three chat sessions open therefore had two of
// them sitting in a queue that expired after three minutes — and the error
// they were shown said the machine was offline, while the terminal in front of
// them was visibly working. Serial execution was the bug; the misleading error
// was only how it surfaced.
//
// The number comes from the Devices page, on the heartbeat, because that is
// where the person deciding is looking — and because a laptop is often not the
// machine they are sitting at. It applies without a restart: the pollers read
// it on every pass.
//
// Three by default, five at most: a coding turn is mostly waiting (on the
// model, on a network call, on a test suite) so three rarely means three busy
// cores, and the sixth is where a laptop stops being pleasant to use.
const DEFAULT_MAX_JOBS = 3
const MAX_JOBS_CEILING = 5

// Commands (list repos, ensure a checkout, push a branch) get their own
// allowance and their own poller. They spawn no model, cost no tokens and
// finish in seconds — but every coding turn OPENS with one, so putting them in
// the same queue as the runs they precede is a deadlock waiting to happen: the
// fourth session's `repo.ensure` waits behind three long completions, times
// out, and that session silently loses its working directory.
const MAX_COMMAND_JOBS = 4

function usable(value) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 1) return null
  return Math.min(Math.trunc(parsed), MAX_JOBS_CEILING)
}

// What this machine will actually run at once, given what the server asked for.
//
// Three inputs, in this order, and the order is the point:
//
//   CMA_MAX_JOBS   an explicit override for debugging. Wins outright.
//   the server     the "Jobs at once" setting on the Devices page — the one
//                  people use, and the only one they can reach from a browser.
//   local config   `cma-agent max-jobs <n>`, a ceiling the machine keeps for
//                  itself. Applied as a MINIMUM with the server's number, not
//                  as an alternative to it: an old laptop that says "two" must
//                  not be talked up to five from a web page, and a machine
//                  that says "five" must not override an account that wants
//                  fewer.
export function maxJobs(serverValue = null) {
  const override = usable(process.env.CMA_MAX_JOBS)
  if (override) return override

  const candidates = [usable(serverValue), usable(readConfig().maxJobs)].filter(Boolean)
  return candidates.length ? Math.min(...candidates) : DEFAULT_MAX_JOBS
}

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

  // Mutable on purpose: the heartbeat below rewrites it when the Devices page
  // changes, and the pollers read it on every pass. That is what makes "run
  // four at once" take effect within one heartbeat instead of at the next
  // restart of a process someone may not be sitting in front of.
  const limits = { jobs: maxJobs(), paused: false }

  const beat = async () => {
    try {
      const data = await api.heartbeat({ agentVersion: VERSION, runtimeVersions: versions })
      applySettings(data?.device, limits, log)
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

  log(`Waiting for work — up to ${limits.jobs} at a time. Leave this running.`)

  // Two independent pollers over the same queue. Both stop when `running`
  // goes false, and either one hitting "you are not paired" stops both — an
  // unpaired machine has nothing useful for the other lane to do either.
  const unpaired = () => {
    log("! This machine is no longer paired. Run `cma-agent pair`.")
    running = false
  }

  try {
    await Promise.all([
      // Read through a function, not captured: the Devices page can change it
      // mid-run, and a poller holding yesterday's number would ignore that
      // until the process restarted.
      poll({ lane: "completions", limit: () => limits.jobs, log, isRunning: () => running, onUnpaired: unpaired }),
      poll({ lane: "commands", limit: () => MAX_COMMAND_JOBS, log, isRunning: () => running, onUnpaired: unpaired })
    ])
  } finally {
    clearInterval(heartbeatTimer)
    clearInterval(rescanTimer)
  }

  return 0
}

// One lane's claim loop.
//
// Claims while there is a free slot and hands each job off WITHOUT awaiting
// it, which is the whole change: the next claim happens while the last run is
// still going. When every slot is taken it waits on the first one to free
// rather than polling — a claimed job we have no capacity for would be a job
// nobody is running, which is worse than one still queued on the server.
async function poll({ lane, limit, log, isRunning, onUnpaired }) {
  const inflight = new Set()
  let backoff = BACKOFF_START_MS

  while (isRunning()) {
    if (inflight.size >= limit()) {
      await Promise.race(inflight)
      continue
    }

    let job = null
    try {
      job = await api.claimJob({ wait: 25, lane })
      backoff = BACKOFF_START_MS
    } catch (error) {
      if (error.status === 401) {
        onUnpaired()
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

    // Every failure inside handleJob is already reported to the server there;
    // catching again is only so one bad run can never reject this loop.
    const task = handleJob(job, prefixed(log, job, limit())).catch(() => {})
    inflight.add(task)
    task.finally(() => inflight.delete(task))
  }

  // Stopping means "finish what's in flight", so the process doesn't exit with
  // a half-run turn the server will later report as a machine that died.
  await Promise.allSettled([...inflight])
}

// Take what the Devices page says, and say so when it changes.
//
// Announced rather than applied silently: somebody watching this terminal
// while their laptop suddenly runs four things at once deserves to know why,
// and "this machine is paused" is the answer to "why has nothing arrived for
// twenty minutes". An older server sends neither field and nothing here fires.
//
// Exported for the tests: precedence between the page, the local ceiling and
// the environment override is exactly the kind of thing that looks obvious and
// is wrong.
export function applySettings(device, limits, log = () => {}) {
  if (!device) return limits

  const next = maxJobs(device.max_jobs)
  if (next !== limits.jobs) {
    log(`  · Now taking up to ${next} ${next === 1 ? "job" : "jobs"} at once (set on the Devices page).`)
    limits.jobs = next
  }

  const paused = device.paused === true
  if (paused !== limits.paused) {
    log(paused
      ? "  · Paused from the Devices page — no new work will be sent until you resume it."
      : "  · Taking work again.")
    limits.paused = paused
  }

  return limits
}

// With one job at a time the terminal reads as a story. With three it reads as
// three stories interleaved, so each line gets the job's first four characters
// in front of it — enough to follow one run down the page.
function prefixed(log, job, limit) {
  if (limit <= 1) return log
  const tag = String(job.id || "").slice(0, 4) || "job"
  return (message) => log(`[${tag}] ${message}`)
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
      usage: output.usage,
      // The documents this run produced, read back off disk so they exist
      // somewhere other than this machine. An older server ignores the key; a
      // run that wrote none sends an empty list.
      files: output.files || []
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
