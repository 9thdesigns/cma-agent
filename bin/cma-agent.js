#!/usr/bin/env node
import os from "node:os"
import readline from "node:readline/promises"
import { stdin, stdout } from "node:process"

import * as api from "../src/api.js"
import { claudeVersion, loginProfile } from "../src/claude.js"
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
    console.error("Claude Code isn't installed, or isn't on PATH.")
    console.error("Install it and sign in first — that's the login this machine will spend.")
    return 1
  }

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

async function cmdStatus() {
  const config = readConfig()
  const version = await claudeVersion()

  console.log(`cma-agent ${VERSION}`)
  console.log(`Server:      ${serverUrl()}`)
  console.log(`Paired:      ${deviceToken() ? `yes (${config.device_id || "unknown id"})` : "no — run `cma-agent pair`"}`)
  console.log(`Claude Code: ${version || "not found on PATH"}`)

  const profiles = await scanProfiles()
  printProfiles(profiles)
  return 0
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
  await reportProfiles()

  console.log(`\n✓ "${profile.label}" is ready. Pick it on an Anthropic provider in the web app.`)
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
  const reported = await reportProfiles(profiles)
  console.log(reported ? "\n✓ Reported to Configure My AI." : "\n! Couldn't reach Configure My AI — the next heartbeat will carry this.")
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

async function reportProfiles(profiles) {
  try {
    await api.syncProfiles(profiles || (await scanProfiles()))
    return true
  } catch (_error) {
    return false
  }
}

function printProfiles(profiles) {
  if (!profiles || profiles.length === 0) {
    console.log("\nClaude logins: none found.")
    return
  }

  console.log("\nClaude logins:")
  for (const profile of profiles) {
    const mark = profile.status === "ready" ? "✓" : profile.status === "logged_out" ? "✗" : "?"
    const hint = profile.account_hint ? ` (${profile.account_hint})` : ""
    const state = profile.status === "ready" ? "" : `  — ${profile.status.replace("_", " ")}`
    console.log(`  ${mark} ${profile.label}${hint}  [${profile.slug}]${state}`)
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
