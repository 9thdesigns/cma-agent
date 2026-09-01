#!/usr/bin/env node
import os from "node:os"
import readline from "node:readline/promises"
import { stdin, stdout } from "node:process"

import * as api from "../src/api.js"
import { loginProfile, runtimeVersion } from "../src/engine.js"
import { readConfig, writeConfig, serverUrl, deviceToken, profileDir } from "../src/config.js"
import { serve as serveGithubMcp } from "../src/mcp.js"
import { serve as serveWebMcp } from "../src/mcp_web.js"
import {
  addProfile, defaultProfileSlug, describeAccount, duplicateAccounts, listProfiles, removeProfile,
  scanProfiles, runtimeModels, runtimeVersions, setDefaultProfile,
  DEFAULT_PROFILE, DEFAULT_RUNTIME
} from "../src/profiles.js"
import { getRuntime, installedRuntimes, isInstalled, RUNTIMES } from "../src/runtimes/index.js"
import { addRoot, listRoots, removeRoot, reposList } from "../src/repos.js"
import { start, maxJobs } from "../src/runner.js"
import { VERSION } from "../src/version.js"

const HELP = `cma-agent ${VERSION}

Runs Configure My AI work on this machine using a coding CLI you already
installed and signed into. Your vendor logins never leave this computer.

Runtimes this build can drive:
${RUNTIMES.map((r) => `  ${r.id.padEnd(12)} ${r.name} (${r.cli})`).join("\n")}

Setup
  pair                          Link this machine to your Configure My AI account
  verify                        Restore a session that lapsed after two weeks
  status                        Show pairing, session and login state

Running
  start                         Wait for work and run it (leave this running)
  max-jobs [n|none]             Cap how many jobs this machine takes at once,
                                  whatever the Devices page asks for. The usual
                                  place to set this is "Jobs at once" on the
                                  Devices page — it needs no restart.

Local repositories
  repos:add ~/code              Share a folder so the web app can see the git
                                  repositories inside it. Nothing is visible
                                  until you do this.
  repos:list                    Show the shared folders and what was found
  repos:remove ~/code           Stop sharing a folder

Logins
  use                           Show which login work with no login named runs on
  use 9th                       Send it to that login instead
  use default                   Put it back to this machine's ambient login
  accounts                      Show which account each login actually signs in
                                  as, and which provider in the web app spends it
  runtimes:list                 Show every runtime and the logins on this machine
  runtimes:add --runtime cursor --label "Work"
       [--account you@work.com]   Add a separate login and sign into it
  runtimes:login --runtime cursor [--profile work]
                                Sign a login in again after it expires
  runtimes:scan                 Re-check every login and report to the web app
  runtimes:remove --runtime cursor --profile work
                                Delete a login and its credential from this machine

  claude:add / claude:login / claude:list / claude:scan / claude:remove
                                The same commands for Claude Code, kept working

Options
  --server <url>                Point at a different Configure My AI host
`

function parseArgs(argv) {
  const args = { _: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token.startsWith("--")) {
      const key = token.slice(2)
      const next = argv[i + 1]
      if (next === undefined || next.startsWith("--")) {
        args[key] = true
      } else {
        args[key] = next
        i += 1
      }
    } else {
      args._.push(token)
    }
  }
  return args
}

async function ask(question) {
  const rl = readline.createInterface({ input: stdin, output: stdout })
  try {
    return (await rl.question(question)).trim()
  } finally {
    rl.close()
  }
}

// Which runtime a command is about.
//
// `--runtime` when given; otherwise the only installed one, because a machine
// with just Claude Code on it should never have to name it. Ambiguity is an
// error rather than a guess: picking for someone with two CLIs installed would
// sign them into the wrong account.
function resolveRuntimeArg(args, { fallback = null } = {}) {
  const requested = args.runtime
  if (requested && requested !== true) {
    const runtime = getRuntime(String(requested))
    if (!runtime) {
      throw new Error(`Unknown runtime "${requested}". Known: ${RUNTIMES.map((r) => r.id).join(", ")}`)
    }
    return runtime
  }

  if (fallback) return getRuntime(fallback)

  const installed = installedRuntimes()
  if (installed.length === 1) return installed[0]
  if (installed.length === 0) {
    throw new Error("No runtime this companion can drive is installed. Run `cma-agent status`.")
  }

  throw new Error(
    `More than one runtime is installed, so say which: --runtime ${installed.map((r) => r.id).join(" | ")}`
  )
}

async function cmdPair(args) {
  if (args.server) writeConfig({ server: String(args.server).replace(/\/+$/, "") })

  const installed = installedRuntimes()
  if (installed.length === 0) {
    // One message for one cause. This used to say "isn't installed, or isn't
    // on PATH" and then advise installing it — which is the wrong remedy for
    // the more common half of that sentence, and sends someone to reinstall
    // software they already have.
    console.error("No coding CLI this companion can drive is installed on this machine:")
    for (const runtime of RUNTIMES) console.error(`  ${runtime.name}: ${runtime.install}`)
    return 1
  }

  for (const runtime of installed) {
    const advice = runtime.advice()
    if (advice) console.error(advice)
  }

  // Pairing over the top of an existing pairing is the normal way back from
  // "I paired this laptop to my other account". Worth saying out loud, because
  // the failure it explains is silent: the token is swapped here, but a
  // `cma-agent start` already running keeps serving the old account until it
  // is restarted, so the machine looks paired in one browser and dead in the
  // other.
  const alreadyPaired = Boolean(deviceToken())
  if (alreadyPaired) {
    console.log("This machine is already paired. Pairing again points it at whichever account")
    console.log("the new code came from; the previous one keeps its row but stops being answered.\n")
  }

  // Two different screens mint codes, and pointing an already-paired machine
  // at the setup page is what opens a duplicate row for it.
  const codeSource = alreadyPaired
    ? "Pairing code (Devices → this machine → Reconnect)"
    : `Pairing code from ${serverUrl()}/devices/setup`
  const code = args.code || (await ask(`${codeSource}: `))
  if (!code) {
    console.error("No code entered.")
    return 1
  }

  // Report the logins during pairing so the web walkthrough can tick both
  // steps at once for anyone who was already signed in.
  const profiles = await scanProfiles()

  try {
    const result = await api.pair({
      code,
      name: args.name || os.hostname(),
      platform: `${os.platform()}-${os.arch()}`,
      agentVersion: VERSION,
      profiles
    })

    writeConfig({ token: result.token, device_id: result.device.id })

    console.log(`\n✓ Paired as "${result.device.name}".`)
    printProfiles(result.device.profiles)
    // A companion that was already running is still holding the old token, so
    // "now run start" is the wrong instruction for the case that brought most
    // people here.
    console.log(alreadyPaired ? "\nRestart the companion so it picks this up: cma-agent start"
                              : "\nNow run: cma-agent start")
    return 0
  } catch (error) {
    console.error(`\n✗ ${error.message}`)
    return 1
  }
}

async function cmdVerify() {
  try {
    const result = await api.verify({
      profiles: await scanProfiles(),
      agentVersion: VERSION,
      runtimeVersions: await runtimeVersions(),
      runtimeModels: await runtimeModels()
    })
    console.log(`✓ ${result.device.name} verified. Session runs to ${new Date(result.device.session_expires_at).toLocaleString()}.`)
    printProfiles(result.device.profiles)
    return 0
  } catch (error) {
    console.error(`✗ ${error.message}`)
    if (error.body?.profiles) printProfiles(error.body.profiles)
    return 1
  }
}

// Both halves of the picture, and one clear next step.
//
// This used to report only what the machine could see locally, which is the
// half that is almost never wrong. Every confusing state — paired but offline,
// signed in but not reported, reported but no provider created — lives in the
// gap between the machine and the server, and showing one side made that gap
// invisible. Now it asks.
async function cmdStatus() {
  const config = readConfig()
  const next = []

  console.log(`cma-agent ${VERSION}`)
  console.log(`Server:      ${serverUrl()}`)

  console.log("\nOn this machine")
  let anyInstalled = false
  const localModels = await runtimeModels()
  for (const runtime of RUNTIMES) {
    // Present is a different question per runtime: a binary for the CLIs, a
    // server that answers for Ollama. Ask the adapter rather than the PATH.
    const present = isInstalled(runtime)
    const { bin, source } = runtime.resolveBin()
    const version = present ? await runtimeVersion(runtime) : null
    if (version) anyInstalled = true

    console.log(`  ${`${runtime.name}:`.padEnd(15)} ${version || "not found"}`)
    if (bin) console.log(`  ${"".padEnd(15)} ${bin}  (${source})`)

    const advice = runtime.advice()
    if (advice && version) console.log(`  ${"".padEnd(15)} ${advice.split("\n")[0]}`)

    // Models this machine holds itself. Printed here because for a
    // bring-your-own runtime this IS the capability — "Ollama 0.5.7" says
    // nothing about whether it can answer anything.
    const models = localModels[runtime.id]
    if (models?.length) {
      console.log(`  ${"".padEnd(15)} models: ${models.slice(0, 6).join(", ")}${models.length > 6 ? `, +${models.length - 6} more` : ""}`)
    }

    // What a runtime cannot do is worth saying here rather than leaving
    // someone to discover it when a session ends by asking them to push its
    // own work by hand.
    if (version && runtime.limitations) {
      for (const limitation of runtime.limitations) console.log(`  ${"".padEnd(15)} · ${limitation}`)
    }
  }

  if (!anyInstalled) {
    next.push(`Install a coding CLI: ${RUNTIMES.map((r) => r.install).join(" or ")}`)
  }

  const local = await scanProfiles()
  printProfiles(local, "  ")
  if (anyInstalled && !local.some((p) => p.status === "ready")) {
    next.push('Sign a login in: cma-agent runtimes:add --runtime <id> --label "Work"')
  }

  console.log("\nConfigure My AI")
  if (!deviceToken()) {
    console.log("  Paired:       no")
    next.push("Pair this machine: cma-agent pair")
    printNext(next)
    return 0
  }

  console.log(`  Paired:       yes (${config.device_id || "unknown id"})`)

  let remote
  try {
    remote = await api.status()
  } catch (error) {
    // Say which failure it was. "Couldn't reach the server" and "the server
    // doesn't recognise this machine" need opposite responses.
    if (error.status === 401) {
      console.log("  Session:      this machine is no longer paired")
      next.push("Pair again: cma-agent pair")
    } else if (error.status === 409) {
      console.log("  Session:      lapsed after two weeks of silence")
      next.push("Restore it: cma-agent verify")
    } else {
      console.log(`  Session:      couldn't ask — ${error.message}`)
      next.push(`Check ${serverUrl()} is reachable from this machine`)
    }
    printNext(next)
    return 1
  }

  const device = remote.device || {}
  const credentials = remote.credentials || []
  const knownProfiles = device.profiles || []

  console.log(`  Known as:     ${device.name || "?"}`)
  console.log(`  Seen:         ${device.online ? "connected now" : `offline${device.last_seen_at ? ` — last seen ${ago(device.last_seen_at)}` : ""}`}`)
  if (device.session_expires_at) {
    console.log(`  Session:      runs to ${new Date(device.session_expires_at).toLocaleString()}`)
  }

  if (knownProfiles.length === 0) {
    console.log("  Logins there: none reported yet")
  } else {
    console.log("  Logins there:")
    for (const p of knownProfiles) {
      const state = p.status === "ready" ? "" : `  — ${String(p.status).replace("_", " ")}`
      const label = getRuntime(p.runtime)?.name || p.runtime || "?"
      console.log(`    ${p.status === "ready" ? "✓" : "✗"} ${label} · ${p.label}  [${p.slug}]${state}`)
    }
  }

  console.log(`  Providers:    ${credentials.length === 0 ? "none created yet" : credentials.map((c) => c.name).join(", ")}`)

  // The models the server believes this machine has, against the ones it
  // actually has. For a bring-your-own runtime this is the picker: a model
  // pulled but never reported is simply not offerable, with nothing anywhere
  // saying why.
  const remoteModels = device.runtime_models || {}
  for (const [runtimeId, mine] of Object.entries(localModels)) {
    const theirs = remoteModels[runtimeId] || []
    const missing = mine.filter((m) => !theirs.includes(m))
    const stale = theirs.filter((m) => !mine.includes(m))
    if (missing.length === 0 && stale.length === 0) continue

    const name = getRuntime(runtimeId)?.name || runtimeId
    if (missing.length > 0) console.log(`  ${name}:      not reported yet — ${missing.join(", ")}`)
    if (stale.length > 0) console.log(`  ${name}:      reported but gone from this machine — ${stale.join(", ")}`)
    next.push(`Send this machine's ${name} model list: cma-agent runtimes:scan`)
  }

  // The comparison is the point. Each of these is a state the two sides can
  // reach independently, and none of them is visible from one side alone.
  const localReady = local.filter((p) => p.status === "ready")
  const remoteReady = knownProfiles.filter((p) => p.status === "ready")

  if (localReady.length > 0 && remoteReady.length === 0) {
    next.push("This machine has a working login Configure My AI hasn't been told about: cma-agent runtimes:scan")
  } else if (remoteReady.length > 0 && credentials.length === 0) {
    next.push("A login is reported but no provider exists — run `cma-agent runtimes:scan` to trigger it again")
  }

  // A runtime the machine can drive but has never reported is the quiet
  // failure this whole command exists for: the picker on the web app simply
  // won't offer it, with nothing anywhere saying why.
  const reportedRuntimes = new Set(knownProfiles.map((p) => p.runtime))
  for (const runtime of installedRuntimes()) {
    if (reportedRuntimes.has(runtime.id)) continue
    if (!local.some((p) => p.runtime === runtime.id && p.status === "ready")) continue
    next.push(`${runtime.name} works here but hasn't reached the web app: cma-agent runtimes:scan`)
  }

  if (!device.online) {
    next.push("Nothing runs until the companion is listening: cma-agent start")
  }

  printNext(next)
  return 0
}

function printNext(steps) {
  if (steps.length === 0) {
    console.log("\n✓ Connected and ready. Work sent to this machine will run here.")
    return
  }
  console.log("\nNext:")
  for (const step of steps) console.log(`  → ${step}`)
}

function ago(iso) {
  const seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000))
  if (seconds < 90) return `${seconds}s ago`
  const minutes = Math.round(seconds / 60)
  if (minutes < 90) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`
}

// ---------------------------------------------------------------------------
// Local repositories. Sharing is explicit and per-folder — see src/repos.js
// for why there is no "just scan my home directory" option.
// ---------------------------------------------------------------------------

async function cmdReposAdd(args) {
  const target = args._[0] || args.path
  if (!target || target === true) {
    console.error("Which folder? e.g. cma-agent repos:add ~/code")
    return 1
  }

  let resolved
  try {
    resolved = addRoot(String(target))
  } catch (error) {
    console.error(`✗ ${error.message}`)
    return 1
  }

  const { repos } = await reposList()
  const mine = repos.filter((r) => r.path.startsWith(resolved))
  console.log(`✓ Sharing ${resolved}`)
  console.log(`  ${mine.length} ${mine.length === 1 ? "repository" : "repositories"} visible to Configure My AI.`)
  for (const repo of mine.slice(0, 20)) {
    console.log(`    ${repo.name}  [${repo.branch}]${repo.dirty ? "  · uncommitted changes" : ""}`)
  }
  if (mine.length > 20) console.log(`    …and ${mine.length - 20} more`)
  return 0
}

async function cmdReposList() {
  const roots = listRoots()
  if (roots.length === 0) {
    console.log("No folders are shared from this machine.")
    console.log("\nNext:\n  → Share one: cma-agent repos:add ~/code")
    return 0
  }

  console.log("Shared folders:")
  for (const root of roots) console.log(`  ${root}`)

  const { repos } = await reposList()
  console.log(`\nRepositories (${repos.length}):`)
  for (const repo of repos) {
    const slug = repo.github ? `  ${repo.github}` : ""
    console.log(`  ${repo.name}  [${repo.branch}]${repo.dirty ? "  · dirty" : ""}${slug}`)
    console.log(`    ${repo.path}`)
  }
  return 0
}

async function cmdReposRemove(args) {
  const target = args._[0] || args.path
  if (!target || target === true) {
    console.error("Which folder? e.g. cma-agent repos:remove ~/code")
    return 1
  }
  console.log(`✓ Stopped sharing ${removeRoot(String(target))}`)
  return 0
}

// ---------------------------------------------------------------------------
// Logins, for any runtime.
//
// `fallbackRuntime` is what makes `claude:add` keep meaning Claude Code on a
// machine that now also has Cursor installed. The old commands are not
// deprecated aliases that guess — they are pinned.
// ---------------------------------------------------------------------------

async function cmdRuntimeAdd(args, fallbackRuntime = null) {
  let runtime
  try {
    runtime = resolveRuntimeArg(args, { fallback: fallbackRuntime })
  } catch (error) {
    console.error(`✗ ${error.message}`)
    return 1
  }

  const label = args.label
  if (!label || label === true) {
    console.error(`Give the login a label, e.g. cma-agent runtimes:add --runtime ${runtime.id} --label "Work"`)
    return 1
  }

  let profile
  try {
    profile = addProfile(runtime.id, String(label), { account: args.account === true ? null : args.account })
  } catch (error) {
    console.error(`✗ ${error.message}`)
    return 1
  }

  console.log(`Signing into ${runtime.name} for "${profile.label}" — your browser will open.`)
  console.log(`This is ${runtime.name}'s own sign-in. Configure My AI never sees it.\n`)

  await loginProfile(runtime, profile.slug)

  // Confirm against what we can actually see, rather than assuming the sign-in
  // took. Claude Code keeps credentials in the macOS Keychain, so a per-profile
  // config directory does not always isolate them the way it does on Linux —
  // "you signed in" and "this profile resolves" are genuinely different claims.
  const scanned = await scanProfiles()
  const mine = scanned.find((p) => p.slug === profile.slug && p.runtime === runtime.id)
  const failure = await reportProfiles(scanned)

  if (mine?.status !== "ready") {
    console.error(`\n✗ "${profile.label}" still isn't signing in (${mine?.status || "not found"}).`)
    console.error(`  Try again with: cma-agent runtimes:login --runtime ${runtime.id} --profile ${profile.slug}`)
    return 1
  }

  if (failure) {
    console.error(`\n! "${profile.label}" works on this machine, but Configure My AI wasn't told: ${failure}`)
    console.error("  Fix that, then run: cma-agent runtimes:scan")
    return 1
  }

  console.log(`\n✓ "${profile.label}" is ready and reported. Pick it on a Local machine provider in the web app.`)
  return 0
}

async function cmdRuntimeLogin(args, fallbackRuntime = null) {
  let runtime
  try {
    runtime = resolveRuntimeArg(args, { fallback: fallbackRuntime })
  } catch (error) {
    console.error(`✗ ${error.message}`)
    return 1
  }

  if (!runtime.loginArgs() || runtime.loginArgs().length === 0) {
    console.error(`${runtime.name} has no sign-in command we can drive. ${runtime.loginHint}.`)
    return 1
  }

  const slug = args.profile === true || !args.profile ? "" : String(args.profile)
  await loginProfile(runtime, slug === "default" ? "" : slug)
  await reportProfiles()
  console.log("✓ Signed in.")
  return 0
}

async function cmdRuntimeList() {
  const localModels = await runtimeModels()

  for (const runtime of RUNTIMES) {
    const mine = listProfiles(runtime)
    console.log(`${runtime.name}  [${runtime.id}]  ${isInstalled(runtime) ? "installed" : "not installed"}`)
    if (mine.length > 0) {
      for (const profile of mine) console.log(`  · ${profile.label}  [${profile.slug}]`)
    }
    const models = localModels[runtime.id]
    if (models?.length) console.log(`  models: ${models.join(", ")}`)
  }

  printProfiles(await scanProfiles())
  return 0
}

async function cmdRuntimeScan() {
  const profiles = await scanProfiles()
  printProfiles(profiles)
  const failure = await reportProfiles(profiles)
  if (failure) {
    console.error(`\n! Not reported: ${failure}`)
    return 1
  }
  console.log("\n✓ Reported to Configure My AI.")
  return 0
}

async function cmdRuntimeRemove(args, fallbackRuntime = null) {
  let runtime
  try {
    runtime = resolveRuntimeArg(args, { fallback: fallbackRuntime })
  } catch (error) {
    console.error(`✗ ${error.message}`)
    return 1
  }

  const slug = args.profile
  if (!slug || slug === true) {
    console.error(`Which login? e.g. cma-agent runtimes:remove --runtime ${runtime.id} --profile work`)
    return 1
  }

  try {
    removeProfile(runtime.id, String(slug))
  } catch (error) {
    console.error(`✗ ${error.message}`)
    return 1
  }

  await reportProfiles()
  console.log(`✓ Removed "${slug}" and its credential from this machine.`)
  return 0
}

// Returns null on success, or the reason it failed.
//
// This used to return a bare false that every caller ignored, so `claude:add`
// printed "✓ ready" whether or not the login had reached the server. A sync
// that silently fails and then congratulates you is worse than one that
// crashes: the web app sits there saying "No logins reported yet" and nothing
// on the machine disagrees with it.
async function reportProfiles(profiles) {
  try {
    // The models ride with the scan: a machine that just pulled one has a
    // provider whose dropdown is wrong until this lands, and the two facts
    // are learned in the same breath anyway.
    await api.syncProfiles(profiles || (await scanProfiles()), await runtimeModels())
    return null
  } catch (error) {
    if (error.status === 401) return "this machine is no longer paired — run `cma-agent pair`"
    if (error.status === 409) return "this machine's session lapsed — run `cma-agent verify`"
    return error.message || "couldn't reach Configure My AI"
  }
}

function printProfiles(profiles, indent = "") {
  if (!profiles || profiles.length === 0) {
    console.log(indent ? `${indent}Logins here: none found.` : "\nLogins: none found.")
    return
  }

  console.log(indent ? `${indent}Logins here:` : "\nLogins:")
  for (const profile of profiles) {
    const mark = profile.status === "ready" ? "✓" : profile.status === "logged_out" ? "✗" : "?"
    // The resolved address when we have it, the masked hint when we don't.
    // Two logins that both say "d•••@acme.com" are indistinguishable at
    // exactly the moment you most need to tell them apart.
    const account = profile.account_email || profile.account_hint
    const hint = account ? ` (${account})` : ""
    const state = profile.status === "ready" ? "" : `  — ${String(profile.status).replace(/_/g, " ")}`
    const runtimeName = getRuntime(profile.runtime)?.name || profile.runtime || "?"
    console.log(`${indent}  ${mark} ${runtimeName} · ${profile.label}${hint}  [${profile.slug}]${state}`)
    // The runtime's own sentence about why it isn't ready. Usually the whole
    // fix ("no models pulled — try `ollama pull llama3.2`").
    if (profile.detail && profile.status !== "ready") console.log(`${indent}      ${profile.detail}`)
  }
}

// ---------------------------------------------------------------------------
// Which account is which.
//
// The one question two logins create — "which subscription is this going to
// spend?" — and until now the only answer anywhere was a label somebody typed.
// This asks each login's own config directory who it signs in as, checks the
// sign-in still works, and names the provider in the web app that spends it,
// so all three facts are on one screen instead of in three places.
// ---------------------------------------------------------------------------
// Which login does work run on when nothing names one?
//
// The web app is where a provider is pointed at a specific login, and that is
// unchanged and still wins — see the docs. What it could not do is decide what
// a provider means when it names NO login, which is every provider created
// before a second login existed. That meaning is this machine's to make, and
// until now it was made silently: the ambient login, whichever account the
// vendor CLI happened to be signed into.
//
//   cma-agent use          what it is now, and what each choice would spend
//   cma-agent use 9th      make it that login
//   cma-agent use default  back to the ambient one
async function cmdUse(args) {
  let runtime
  try {
    runtime = resolveRuntimeArg(args, { fallback: DEFAULT_RUNTIME })
  } catch (error) {
    console.error(`✗ ${error.message}`)
    return 1
  }

  const wanted = args._[0]
  const current = defaultProfileSlug(runtime)

  const describe = (slug) => describeAccount(runtime, slug) || "account unknown"
  const nameOf = (slug) =>
    slug ? (listProfiles(runtime).find((p) => p.slug === slug)?.label || slug) : DEFAULT_PROFILE.label

  if (wanted === undefined) {
    console.log(`${runtime.name}: work that names no login runs on`)
    console.log(`  ${nameOf(current)} [${current || "default"}] — ${describe(current)}\n`)

    const options = [DEFAULT_PROFILE, ...listProfiles(runtime)]
    if (options.length === 1) {
      console.log("This machine has one login, so there is nothing to choose between.")
      console.log(`Add another with: cma-agent runtimes:add --runtime ${runtime.id} --label "Work"`)
      return 0
    }

    console.log("Change it to any of:")
    for (const profile of options) {
      const slug = profile.slug || "default"
      const mark = (profile.slug || "") === current ? "·" : " "
      console.log(`  ${mark} cma-agent use ${slug}`.padEnd(30) + `${profile.label} — ${describe(profile.slug)}`)
    }
    console.log("\nA provider that names a login in the web app is unaffected — this only")
    console.log("decides what the ones that name none mean.")
    return 0
  }

  let slug
  try {
    slug = setDefaultProfile(runtime.id, String(wanted))
  } catch (error) {
    console.error(`✗ ${error.message}`)
    return 1
  }

  console.log(`✓ ${runtime.name}: work that names no login now runs on`)
  console.log(`    ${nameOf(slug)} [${slug || "default"}] — ${describe(slug)}`)

  // Report it straight away rather than waiting for the next scan, so the web
  // app agrees about which account that work spends before anyone runs any.
  if (deviceToken()) {
    try {
      await api.syncProfiles(await scanProfiles(), await runtimeModels())
      console.log("    Told Configure My AI, so the web app shows the same account.")
    } catch (_error) {
      console.log("    (Couldn't reach Configure My AI just now — it catches up on the next check-in.)")
    }
  }

  console.log("\nRestart the companion for it to take effect: cma-agent start")
  return 0
}

async function cmdAccounts() {
  const scanned = await scanProfiles()

  // Best effort and never fatal: the local half of this answer is the half
  // people are usually checking, and a machine that hasn't been paired yet —
  // or is on a train — should still get it.
  let credentials = null
  if (deviceToken()) {
    try {
      credentials = (await api.status()).credentials || []
    } catch (_error) {
      credentials = null
    }
  }

  const installed = installedRuntimes()
  if (installed.length === 0) {
    console.log("No coding CLI this companion can drive is installed on this machine.")
    for (const runtime of RUNTIMES) console.log(`  ${runtime.name}: ${runtime.install}`)
    return 1
  }

  for (const runtime of installed) {
    const version = await runtimeVersion(runtime)
    console.log(`\n${runtime.name}  [${runtime.id}]  ${version || "version unknown"}`)

    for (const profile of [DEFAULT_PROFILE, ...listProfiles(runtime)]) {
      const slug = profile.slug || "default"
      const scan = scanned.find((p) => p.runtime === runtime.id && p.slug === slug)
      const status = scan?.status || "unknown"
      const mark = status === "ready" ? "✓" : status === "logged_out" ? "✗" : "?"

      console.log(`  ${mark} ${profile.label}  [${slug}]${status === "ready" ? "" : `  — ${status.replace(/_/g, " ")}`}`)
      console.log(`      account:   ${scan?.account_email || scan?.account_hint || "couldn't tell — see below"}`)
      console.log(`      folder:    ${profile.slug
        ? profileDir(runtime, profile.slug)
        : `this machine's own ${runtime.name} login (no ${runtime.configDirEnvVar || "config-dir"} override)`}`)

      if (credentials === null) {
        console.log("      provider:  couldn't ask Configure My AI just now")
      } else {
        // The server calls the ambient login "default"; locally it is the
        // empty slug, so a provider on the default login has a blank one.
        const mine = credentials.filter((c) =>
          (c.profile || "default") === slug && (!c.runtime || c.runtime === runtime.id))
        console.log(`      provider:  ${mine.length ? mine.map((c) => `"${c.name}"`).join(", ") : "none yet — it appears on its own once the login is reported"}`)
      }
    }
  }

  console.log("\nConfirming which plan pays")
  console.log("  1. The account above is read from the login's own config directory,")
  console.log("     not from the label — so it is what the CLI will actually sign in as.")
  console.log("  2. `cma-agent start` prints the same account on the line that opens")
  console.log("     every run: → Claude Code (account: you@acme.com): claude-opus-5 …")
  console.log("  3. The web app shows it too, in the first line of a session's thinking log.")
  console.log("  4. Anthropic's own record is the last word: check claude.ai/settings/usage")
  console.log("     while signed in as that account.")

  const unknown = scanned.filter((p) => !p.account_email && !p.account_hint)
  if (unknown.length > 0) {
    console.log("\nA login with no account shown is one whose config directory has no")
    console.log("account in it yet — sign it in, then run this again:")
    for (const p of unknown) {
      console.log(`  cma-agent runtimes:login --runtime ${p.runtime}${p.slug === "default" ? "" : ` --profile ${p.slug}`}`)
    }
  }

  // Two labels, one account, and nothing on screen saying so is the failure
  // this command exists to catch — see the Keychain note on the Claude Code
  // adapter. Named loudly rather than left to be inferred from two identical
  // lines twenty rows apart.
  for (const clash of duplicateAccounts(scanned)) {
    console.log(`\n! These logins resolve to the SAME account (${clash.account}):`)
    console.log(`    ${clash.profiles.map((p) => `${p.label} [${p.slug}]`).join(", ")}`)
    console.log("  They all spend that one subscription. On macOS this is usually the Keychain:")
    console.log("  sign the one you want in last, then run `cma-agent runtimes:scan`.")
  }

  return 0
}

// A ceiling this machine keeps for itself.
//
// The setting people use is "Jobs at once" on the Devices page — it is where
// they already are, it needs no terminal, and it applies within one heartbeat.
// This exists for the case that page cannot express: a machine that must not
// go above a number whatever the account asks for, because it is old, or
// shared, or someone is trying to work on it. The two are combined by taking
// the LOWER of them, so this can only ever restrain the page, never overrule
// it upwards.
function cmdMaxJobs(args) {
  const requested = args._[0]
  const local = Number(readConfig().maxJobs)
  const hasLocal = Number.isFinite(local) && local >= 1

  if (requested === undefined) {
    console.log(
      hasLocal
        ? `This machine will not run more than ${local} jobs at once, whatever the Devices page asks for.`
        : "This machine follows the Devices page — set \"Jobs at once\" there (three by default)."
    )
    console.log("Cap it locally with:  cma-agent max-jobs <n>")
    if (hasLocal) console.log("Remove the cap with:  cma-agent max-jobs none")
    return 0
  }

  if (String(requested).toLowerCase() === "none") {
    writeConfig({ maxJobs: null })
    console.log("Cap removed. This machine now follows the Devices page.")
    return 0
  }

  const value = Number(requested)
  if (!Number.isFinite(value) || value < 1) {
    console.error(`"${requested}" isn't a number of jobs. Try: cma-agent max-jobs 3`)
    return 1
  }

  writeConfig({ maxJobs: Math.trunc(value) })
  console.log(`This machine will now run at most ${maxJobs(null)} jobs at once.`)
  console.log("It takes effect on the next heartbeat — no restart needed.")
  return 0
}

async function main() {
  const [, , command, ...rest] = process.argv
  const args = parseArgs(rest)
  if (args.server) writeConfig({ server: String(args.server).replace(/\/+$/, "") })

  switch (command) {
    case "pair": return cmdPair(args)
    case "start": return start()
    case "max-jobs": return cmdMaxJobs(args)
    // The name this shipped under for one prerelease. Aliased rather than
    // dropped so anything already typing it keeps working.
    case "concurrency": return cmdMaxJobs(args)
    case "verify": return cmdVerify()
    case "status": return cmdStatus()
    case "repos:add": return cmdReposAdd(args)
    case "repos:list": return cmdReposList()
    case "repos:remove": return cmdReposRemove(args)

    case "use": return cmdUse(args)
    case "accounts": return cmdAccounts()
    case "runtimes:accounts": return cmdAccounts()
    case "claude:accounts": return cmdAccounts()

    case "runtimes:add": return cmdRuntimeAdd(args)
    case "runtimes:login": return cmdRuntimeLogin(args)
    case "runtimes:list": return cmdRuntimeList()
    case "runtimes:scan": return cmdRuntimeScan()
    case "runtimes:remove": return cmdRuntimeRemove(args)

    // The Claude Code commands as they were. Pinned to claude_code rather than
    // resolved, so muscle memory and every existing walkthrough keep meaning
    // what they meant on a machine that has since installed Cursor too.
    case "claude:add": return cmdRuntimeAdd(args, DEFAULT_RUNTIME)
    case "claude:login": return cmdRuntimeLogin(args, DEFAULT_RUNTIME)
    case "claude:list": return cmdRuntimeList()
    case "claude:scan": return cmdRuntimeScan()
    case "claude:remove": return cmdRuntimeRemove(args, DEFAULT_RUNTIME)

    // Not for people. The runtime spawns this as an MCP server for a repository
    // turn, talking JSON-RPC over stdio; its credentials arrive in the
    // environment. Undocumented in HELP because typing it by hand does nothing
    // useful — it would sit waiting on stdin.
    case "mcp-github": return serveGithubMcp()
    case "mcp-web": return serveWebMcp()
    case "--version":
    case "version": console.log(VERSION); return 0
    default:
      console.log(HELP)
      return command && command !== "help" ? 1 : 0
  }
}

main()
  .then((code) => process.exit(code || 0))
  .catch((error) => {
    console.error(`✗ ${error.message}`)
    process.exit(1)
  })
