#!/usr/bin/env node
import os from "node:os"
import readline from "node:readline/promises"
import { stdin, stdout } from "node:process"

import * as api from "../src/api.js"
import { claudeAdvice, claudeVersion, loginProfile, resolveClaude } from "../src/claude.js"
import { readConfig, writeConfig, serverUrl, deviceToken } from "../src/config.js"
import { addProfile, listProfiles, removeProfile, scanProfiles } from "../src/profiles.js"
import { start } from "../src/runner.js"
import { VERSION } from "../src/version.js"

const HELP = `cma-agent ${VERSION}

Runs Configure My AI work on this machine using the Claude Code you already
signed into. Your Claude login never leaves this computer.

Setup
  pair                          Link this machine to your Configure My AI account
  verify                        Restore a session that lapsed after two weeks
  status                        Show pairing, session and Claude login state

Running
  start                         Wait for work and run it (leave this running)

Claude logins
  claude:add --label "Work"     Add a separate Claude login and sign into it
       [--account you@work.com]   Optional masked hint, so you can tell logins apart
  claude:login --profile work   Sign a login in again after it expires
  claude:list                   Show the logins on this machine
  claude:scan                   Re-check every login and report to the web app
  claude:remove --profile work  Delete a login and its credential from this machine

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

async function cmdPair(args) {
  if (args.server) writeConfig({ server: String(args.server).replace(/\/+$/, "") })

  const version = await claudeVersion()
  if (!version) {
    // One message for one cause. This used to say "isn't installed, or isn't
    // on PATH" and then advise installing it — which is the wrong remedy for
    // the more common half of that sentence, and sends someone to reinstall
    // software they already have.
    console.error(claudeAdvice() || "Claude Code isn't usable on this machine.")
    return 1
  }

  const advice = claudeAdvice()
  if (advice) console.error(advice)

  const code = args.code || (await ask(`Pairing code from ${serverUrl()}/devices/setup: `))
  if (!code) {
    console.error("No code entered.")
    return 1
  }

  // Report the logins during pairing so the web walkthrough can tick both
  // steps at once for anyone who was already signed into Claude Code.
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
    console.log("\nNow run: cma-agent start")
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
      claudeCodeVersion: await claudeVersion()
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
  const version = await claudeVersion()
  const { bin, source } = resolveClaude()
  const next = []

  console.log(`cma-agent ${VERSION}`)
  console.log(`Server:      ${serverUrl()}`)

  console.log("\nOn this machine")
  console.log(`  Claude Code:  ${version || "not found"}`)
  if (bin) console.log(`                ${bin}  (${source})`)
  if (!version) next.push("Install Claude Code and sign in: https://claude.com/product/claude-code")

  const advice = claudeAdvice()
  if (advice && version) console.log(`                ${advice.split("\n")[0]}`)

  const local = await scanProfiles()
  printProfiles(local, "  ")
  if (version && !local.some((p) => p.status === "ready")) {
    next.push('Sign a login in: cma-agent claude:add --label "Work"')
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
      console.log(`    ${p.status === "ready" ? "✓" : "✗"} ${p.label}  [${p.slug}]${state}`)
    }
  }

  console.log(`  Providers:    ${credentials.length === 0 ? "none created yet" : credentials.map((c) => c.name).join(", ")}`)

  // The comparison is the point. Each of these is a state the two sides can
  // reach independently, and none of them is visible from one side alone.
  const localReady = local.filter((p) => p.status === "ready")
  const remoteReady = knownProfiles.filter((p) => p.status === "ready")

  if (localReady.length > 0 && remoteReady.length === 0) {
    next.push("This machine has a working login Configure My AI hasn't been told about: cma-agent claude:scan")
  } else if (remoteReady.length > 0 && credentials.length === 0) {
    next.push("A login is reported but no provider exists — run `cma-agent claude:scan` to trigger it again")
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

async function cmdClaudeAdd(args) {
  const label = args.label
  if (!label || label === true) {
    console.error('Give the login a label, e.g. cma-agent claude:add --label "Work"')
    return 1
  }

  let profile
  try {
    profile = addProfile(String(label), { account: args.account === true ? null : args.account })
  } catch (error) {
    console.error(`✗ ${error.message}`)
    return 1
  }

  console.log(`Signing into Claude for "${profile.label}" — your browser will open.`)
  console.log("This is Anthropic's own sign-in. Configure My AI never sees it.\n")

  await loginProfile(profile.slug)

  // Confirm against what we can actually see, rather than assuming the sign-in
  // took. Claude Code keeps credentials in the macOS Keychain, so a per-profile
  // CLAUDE_CONFIG_DIR does not always isolate them the way it does on Linux —
  // "you signed in" and "this profile resolves" are genuinely different claims.
  const scanned = await scanProfiles()
  const mine = scanned.find((p) => p.slug === profile.slug)
  const failure = await reportProfiles(scanned)

  if (mine?.status !== "ready") {
    console.error(`\n✗ "${profile.label}" still isn't signing in (${mine?.status || "not found"}).`)
    console.error(`  Try again with: cma-agent claude:login --profile ${profile.slug}`)
    return 1
  }

  if (failure) {
    console.error(`\n! "${profile.label}" works on this machine, but Configure My AI wasn't told: ${failure}`)
    console.error("  Fix that, then run: cma-agent claude:scan")
    return 1
  }

  console.log(`\n✓ "${profile.label}" is ready and reported. Pick it on an Anthropic provider in the web app.`)
  return 0
}

async function cmdClaudeLogin(args) {
  const slug = args.profile
  if (!slug || slug === true) {
    console.error("Which login? e.g. cma-agent claude:login --profile work")
    return 1
  }

  await loginProfile(slug === "default" ? "" : String(slug))
  await reportProfiles()
  console.log("✓ Signed in.")
  return 0
}

async function cmdClaudeList() {
  printProfiles(await scanProfiles())
  return 0
}

async function cmdClaudeScan() {
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

async function cmdClaudeRemove(args) {
  const slug = args.profile
  if (!slug || slug === true) {
    console.error("Which login? e.g. cma-agent claude:remove --profile work")
    return 1
  }

  try {
    removeProfile(String(slug))
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
// crashes: the web app sits there saying "No Claude logins reported yet" and
// nothing on the machine disagrees with it.
async function reportProfiles(profiles) {
  try {
    await api.syncProfiles(profiles || (await scanProfiles()))
    return null
  } catch (error) {
    if (error.status === 401) return "this machine is no longer paired — run `cma-agent pair`"
    if (error.status === 409) return "this machine's session lapsed — run `cma-agent verify`"
    return error.message || "couldn't reach Configure My AI"
  }
}

function printProfiles(profiles, indent = "") {
  if (!profiles || profiles.length === 0) {
    console.log(indent ? `${indent}Logins here: none found.` : "\nClaude logins: none found.")
    return
  }

  console.log(indent ? `${indent}Logins here:` : "\nClaude logins:")
  for (const profile of profiles) {
    const mark = profile.status === "ready" ? "✓" : profile.status === "logged_out" ? "✗" : "?"
    const hint = profile.account_hint ? ` (${profile.account_hint})` : ""
    const state = profile.status === "ready" ? "" : `  — ${profile.status.replace("_", " ")}`
    console.log(`${indent}  ${mark} ${profile.label}${hint}  [${profile.slug}]${state}`)
  }
}

async function main() {
  const [, , command, ...rest] = process.argv
  const args = parseArgs(rest)
  if (args.server) writeConfig({ server: String(args.server).replace(/\/+$/, "") })

  switch (command) {
    case "pair": return cmdPair(args)
    case "start": return start()
    case "verify": return cmdVerify()
    case "status": return cmdStatus()
    case "claude:add": return cmdClaudeAdd(args)
    case "claude:login": return cmdClaudeLogin(args)
    case "claude:list": return cmdClaudeList()
    case "claude:scan": return cmdClaudeScan()
    case "claude:remove": return cmdClaudeRemove(args)
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
