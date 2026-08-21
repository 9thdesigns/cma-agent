// The web channel a headless run gets INSTEAD of Claude Code's own
// WebFetch/WebSearch — those sit behind a permission prompt that nobody is
// there to answer, which produced whole turns of "please approve WebFetch".
//
// These tests pin the three halves that have to agree for a fetch to work:
// the cma_web server's tool names match the server's /api/code/v1/web ops,
// the Claude Code argv pre-approves the server and mounts it, and the token
// travels by environment rather than on disk.
//
// Run with: node --test agent/test

import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { baseArgs } from "../src/runtimes/claude-code.js"
import { writeConfig } from "../src/runtimes/cursor.js"
import { envForWeb, mcpServersFor } from "../src/runtimes/shared.js"
import { WEB_TOOLS } from "../src/mcp_web.js"

const valueOf = (args, flag) => {
  const i = args.indexOf(flag)
  return i === -1 ? null : args[i + 1]
}

const listOf = (args, flag) => {
  const i = args.indexOf(flag)
  if (i === -1) return null
  const out = []
  for (let j = i + 1; j < args.length && !args[j].startsWith("-"); j++) out.push(args[j])
  return out
}

const WEB = { token: "cmagh_websecret", endpoint: "https://example.com/api/code/v1/web" }
const GITHUB = { token: "cmagh_secret", endpoint: "https://example.com/api/code/v1/github" }

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cma-web-test-"))
}

// ---------------------------------------------------------------------------
// The tool surface matches the server's operations
// ---------------------------------------------------------------------------

test("the web tools are exactly the server's operations: fetch, browse, search", () => {
  // The tool name IS the operation path segment (POST /api/code/v1/web/<op>),
  // so a rename on either side is a break this assertion catches.
  assert.deepEqual(WEB_TOOLS.map((t) => t.name).sort(), ["browse", "fetch", "search"])
})

test("every web tool says it needs no permission — the whole point", () => {
  for (const tool of WEB_TOOLS) {
    assert.ok(/no permission|no grant/i.test(tool.description),
      `${tool.name} must tell the model no grant is needed, or it will ask for one`)
  }
})

// ---------------------------------------------------------------------------
// Claude Code mounts and pre-approves it
// ---------------------------------------------------------------------------

test("a job with a web grant pre-approves mcp__cma_web and mounts the server", () => {
  const args = baseArgs({ model: "claude-opus-5", system: "…", web: WEB })

  const allowed = listOf(args, "--allowedTools")
  assert.ok(allowed.includes("mcp__cma_web"), "the server must be pre-approved by name")

  const config = JSON.parse(valueOf(args, "--mcp-config"))
  assert.equal(config.mcpServers.cma_web.args[1], "mcp-web")
  // The token travels by environment, never in the argv where `ps` shows it.
  assert.ok(!args.join(" ").includes("cmagh_websecret"))
})

test("web and GitHub grants mount side by side without disturbing each other", () => {
  const args = baseArgs({ model: "claude-opus-5", system: "…", web: WEB, github: GITHUB, workdir: "/repo" })

  const allowed = listOf(args, "--allowedTools")
  assert.ok(allowed.includes("mcp__cma_web"))
  assert.ok(allowed.includes("mcp__cma_github"))

  const config = JSON.parse(valueOf(args, "--mcp-config"))
  assert.deepEqual(Object.keys(config.mcpServers).sort(), ["cma_github", "cma_web"])
})

test("a chat job with neither grant mounts nothing", () => {
  const args = baseArgs({ model: "claude-opus-5", system: "…" })
  assert.equal(valueOf(args, "--mcp-config"), null)
  assert.deepEqual(mcpServersFor({}), {})
})

// ---------------------------------------------------------------------------
// The environment carries the secret
// ---------------------------------------------------------------------------

test("envForWeb hands over endpoint and token, and nothing without a grant", () => {
  assert.deepEqual(envForWeb({ web: WEB }), {
    CMA_WEB_ENDPOINT: "https://example.com/api/code/v1/web",
    CMA_WEB_TOKEN: "cmagh_websecret"
  })
  assert.deepEqual(envForWeb({}), {})
  assert.deepEqual(envForWeb({ web: { endpoint: "https://x" } }), {}, "an endpoint with no token is no grant")
})

// ---------------------------------------------------------------------------
// Cursor writes the same decision as a file
// ---------------------------------------------------------------------------

test("Cursor mounts the web server from its mcp.json, token still off disk", () => {
  const dir = tempDir()
  try {
    writeConfig({ workdir: "/repo", web: WEB }, dir)

    const mcp = fs.readFileSync(path.join(dir, "mcp.json"), "utf8")
    assert.ok(!mcp.includes("cmagh_websecret"), "the web token must travel by environment, never on disk")
    assert.equal(JSON.parse(mcp).mcpServers.cma_web.args[1], "mcp-web")
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("a web-only grant still gets an mcp.json; dropping every grant removes it", () => {
  const dir = tempDir()
  try {
    writeConfig({ workdir: "/repo", web: WEB }, dir)
    assert.ok(fs.existsSync(path.join(dir, "mcp.json")))

    writeConfig({ workdir: "/repo" }, dir)
    assert.ok(!fs.existsSync(path.join(dir, "mcp.json")), "a leftover config keeps dead tools on offer")
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
