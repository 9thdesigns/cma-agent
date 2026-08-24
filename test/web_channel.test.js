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
import { baseArgs as geminiArgs } from "../src/runtimes/gemini.js"
import { cursor, writeConfig } from "../src/runtimes/cursor.js"
import { RUNTIMES } from "../src/runtimes/index.js"
import { withoutCapabilityFlags } from "../src/engine.js"
import { BUILTIN_WEB_TOOLS, builtinWebTools, envForWeb, mcpServersFor } from "../src/runtimes/shared.js"
import { pickServedTools, WEB_TOOLS } from "../src/mcp_web.js"
import { resolveTools } from "../src/mcp.js"

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

test("the web tools are exactly the server's operations: fetch, browse, search, request", () => {
  // The tool name IS the operation path segment (POST /api/code/v1/web/<op>),
  // so a rename on either side is a break this assertion catches.
  assert.deepEqual(WEB_TOOLS.map((t) => t.name).sort(), ["browse", "fetch", "request", "search"])
})

test("request is the only tool that can carry a credential", () => {
  // The transcript this pins: a run was handed an API base URL and a bearer
  // token, and had no tool that could put the two together — fetch takes no
  // headers, browse cannot attach one to a navigation. It reported that it
  // could not make the call at all.
  const byName = Object.fromEntries(WEB_TOOLS.map((t) => [t.name, t]))

  assert.ok(byName.request.inputSchema.properties.headers, "request must accept headers")
  assert.ok(byName.request.inputSchema.properties.method, "request must accept a method")
  assert.ok(byName.request.inputSchema.properties.body, "request must accept a body")
  assert.ok(!byName.fetch.inputSchema.properties.headers,
    "fetch stays a page reader — headers belong to request")
})

test("request tells the model a non-2xx is an answer, not a retry", () => {
  // A 401 or a 422 arrives as a normal result with the body intact, because
  // that body is the diagnostic. A model that reads the status as a tool
  // failure retries the same call instead of reading why it failed.
  assert.match(WEB_TOOLS.find((t) => t.name === "request").description, /non-2xx/i)
})

// ---------------------------------------------------------------------------
// The served tool list: the server's surface wins, the baked one is the floor
// ---------------------------------------------------------------------------

test("a served tool list replaces the baked one — how a new tool reaches an old build", () => {
  // The failure this ends: `request` existed on the server for months while
  // a machine's binary kept showing fetch/browse only, because the binary
  // ships by Homebrew release and the tool list was frozen inside it.
  const served = {
    ok: true,
    tools: [
      { name: "fetch", description: "…", inputSchema: { type: "object" } },
      { name: "request", description: "…", inputSchema: { type: "object" } },
      { name: "brand_new_op", description: "added server-side later", inputSchema: { type: "object" } }
    ]
  }

  const picked = pickServedTools(served, WEB_TOOLS)
  assert.deepEqual(picked.map((t) => t.name), ["fetch", "request", "brand_new_op"])
})

test("a bad or empty served answer keeps the baked list — nothing a machine had can be lost", () => {
  for (const payload of [null, {}, { tools: [] }, { tools: "nope" }, { tools: [{ junk: true }] }]) {
    assert.equal(pickServedTools(payload, WEB_TOOLS), WEB_TOOLS)
  }
})

test("entries missing a name, description or schema are dropped, not served broken", () => {
  const served = { tools: [
    { name: "good", description: "d", inputSchema: {} },
    { name: "no_schema", description: "d" },
    { description: "no name", inputSchema: {} }
  ] }

  assert.deepEqual(pickServedTools(served, WEB_TOOLS).map((t) => t.name), ["good"])
})

test("resolveTools prefers the list hook and falls back to baked on failure", async () => {
  const dynamic = [{ name: "served", description: "d", inputSchema: {} }]
  assert.deepEqual(await resolveTools({ tools: WEB_TOOLS, list: async () => dynamic }), dynamic)
  assert.equal(await resolveTools({ tools: WEB_TOOLS, list: async () => { throw new Error("offline") } }), WEB_TOOLS)
  assert.equal(await resolveTools({ tools: WEB_TOOLS, list: () => [] }), WEB_TOOLS)
  // The github server's plain sync list keeps working untouched.
  assert.deepEqual(await resolveTools({ tools: WEB_TOOLS, list: () => WEB_TOOLS }), WEB_TOOLS)
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

test("Claude Code's own web tools are denied, in every shape of job", () => {
  // The bug this pins: --allowedTools is an AUTO-APPROVE list, not an
  // exclusive one, so WebFetch stayed in the schema the model is handed. A
  // tool the model can see beats a system prompt telling it not to reach for
  // that tool — it called WebFetch, got "requires approval", and a headless
  // run has nobody to approve. Denying it removes it from the tool list, so
  // there is nothing left to reach for.
  for (const job of [
    { model: "claude-opus-5", system: "…" },
    { model: "claude-opus-5", system: "…", web: WEB },
    { model: "claude-opus-5", system: "…", web: WEB, github: GITHUB, workdir: "/repo" }
  ]) {
    const denied = listOf(baseArgs(job), "--disallowedTools")
    assert.ok(denied.includes("WebFetch"), "WebFetch must be denied")
    assert.ok(denied.includes("WebSearch"), "WebSearch must be denied")
  }
})

test("a job with no grants at all is still denied the built-in web tools", () => {
  // Denying used to hang off the allow list, so a job with nothing granted
  // got no deny list either — the one case that most needed it, since it has
  // no cma_web channel to fall back on and WebFetch could never be approved.
  const args = baseArgs({ model: "claude-opus-5", system: "…" })

  assert.equal(valueOf(args, "--allowedTools"), null, "nothing is auto-approved")
  assert.ok(listOf(args, "--disallowedTools").includes("WebFetch"))
})

test("denying the built-ins does not disturb the git denials next to them", () => {
  const denied = listOf(baseArgs({ model: "claude-opus-5", workdir: "/repo" }), "--disallowedTools")

  assert.ok(denied.includes("Bash(git push --force:*)"))
  assert.ok(denied.includes("Bash(git reset --hard:*)"))
  assert.ok(denied.includes("WebFetch"))
})

// ---------------------------------------------------------------------------
// Every runtime, not just Claude Code
// ---------------------------------------------------------------------------

test("every registered runtime has an entry in the built-in web tool map", () => {
  // A runtime missing from the map denies nothing, silently. Pinning the key
  // set means adding the next vendor forces a decision about its web tools
  // rather than defaulting to "left on the surface" without anyone noticing.
  for (const runtime of RUNTIMES) {
    assert.ok(runtime.id in BUILTIN_WEB_TOOLS, `${runtime.id} must be listed, even as []`)
  }
})

test("Gemini's own web tools are excluded, in every job shape", () => {
  // --allowed-tools only auto-APPROVES, exactly like Claude Code's
  // --allowedTools, so it never removed google_web_search or web_fetch. And
  // Gemini only passed it for a repository turn, so a chat turn was doubly
  // uncovered.
  for (const job of [{ model: "gemini-3-pro-preview" }, { model: "x", workdir: "/repo" }]) {
    const excluded = valueOf(geminiArgs(job), "--exclude-tools")
    assert.ok(excluded, "--exclude-tools must be passed")
    assert.deepEqual(excluded.split(","), ["google_web_search", "web_fetch"])
  }
})

test("Gemini's exclusion never costs the turn if a build rejects the flag", () => {
  // The rule this codebase already learned twice: a flag we added must not be
  // able to kill a run. --exclude-tools has to be strippable like the rest.
  assert.ok(withoutCapabilityFlags(geminiArgs({ model: "x", workdir: "/repo" }))
    .every((arg) => arg !== "--exclude-tools" && !arg.includes("google_web_search")))
})

test("Cursor's uncovered web tools are stated rather than guessed at", () => {
  // cursor-agent names tools in a permissions file, and its web tool's name
  // was never verified against a real build. An invented deny entry would be
  // inert and would read as coverage — so the map is empty on purpose and the
  // adapter says so out loud.
  assert.deepEqual(builtinWebTools("cursor"), [])
  assert.ok(cursor.limitations.some((line) => /web/i.test(line)),
    "Cursor must declare the gap so it is visible rather than silently missing")
})

test("Ollama has no web tools to remove because it has no tools at all", () => {
  assert.deepEqual(builtinWebTools("ollama"), [])
})

test("an unknown runtime denies nothing rather than throwing", () => {
  assert.deepEqual(builtinWebTools("something_new"), [])
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
