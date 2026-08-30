// What each runtime is allowed to do, and that the three agree.
//
// The Claude Code allowance is asserted in permissions.test.js as an argv.
// Cursor expresses the same decision as a FILE and Gemini as a different set
// of flags, so "did we accidentally grant Cursor a shell" is not a question
// any existing test could answer. These are the tests that make the three
// comparable.
//
// Run with: node --test "agent/test/*.test.js"

import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { RUNTIMES, DEFAULT_RUNTIME, getRuntime, isHttpRuntime, runtimeIds } from "../src/runtimes/index.js"
import { antigravity } from "../src/runtimes/antigravity.js"
import { claudeCode } from "../src/runtimes/claude-code.js"
import { codewhale, mcpPathIn, writeConfig as writeCodewhaleConfig } from "../src/runtimes/codewhale.js"
import { codex, accountFromAuth, configTomlFor } from "../src/runtimes/codex.js"
import { cursor, permissionsFor, writeConfig } from "../src/runtimes/cursor.js"
import {
  gemini, settingsPathIn, systemSettingsFor, writeConfig as writeGeminiConfig
} from "../src/runtimes/gemini.js"
import { GIT_VERBS, FORBIDDEN_GIT } from "../src/runtimes/shared.js"
import { withoutCapabilityFlags } from "../src/engine.js"

const REPO_JOB = {
  model: "composer-2",
  system: "operator instructions",
  workdir: "/repo",
  github: { token: "cmagh_secret", endpoint: "https://example.com/api/code/v1/github" }
}

const CHAT_JOB = { model: "composer-2", system: "operator instructions" }

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cma-runtime-test-"))
}

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

test("every registered runtime implements the surface the engine calls", () => {
  for (const runtime of RUNTIMES) {
    for (const key of ["id", "name", "cli", "install"]) {
      assert.ok(runtime[key], `${runtime.id} is missing ${key}`)
    }

    // What every runtime owes the engine, whichever transport it uses: read a
    // stream of events, turn them into an answer, and explain a failure.
    for (const fn of ["describeEvent", "collapseEvents", "classifyFailure",
                      "resolveBin", "advice", "loginArgs"]) {
      assert.equal(typeof runtime[fn], "function", `${runtime.id} is missing ${fn}()`)
    }

    // The rest splits by transport, because an HTTP runtime has no argv to
    // build, no environment to spawn into, and nothing to probe by running.
    if (isHttpRuntime(runtime)) {
      for (const fn of ["buildRequest", "probe"]) {
        assert.equal(typeof runtime[fn], "function", `${runtime.id} is missing ${fn}()`)
      }
    } else {
      for (const fn of ["streamingArgs", "probeArgs", "envFor"]) {
        assert.equal(typeof runtime[fn], "function", `${runtime.id} is missing ${fn}()`)
      }
    }
    // A buffered fallback is optional, but claiming one without implementing
    // it would only be discovered when a run needed it.
    if (runtime.supportsBuffered) {
      assert.equal(typeof runtime.bufferedArgs, "function", `${runtime.id} claims buffered support`)
      assert.equal(typeof runtime.parseBuffered, "function", `${runtime.id} claims buffered support`)
    }
  }
})

test("runtime ids match what the server stores", () => {
  // These strings are a contract with AiCredential::LOCAL_RUNTIMES. A rename
  // on either side silently produces jobs no machine will claim.
  assert.deepEqual(runtimeIds(),
    ["claude_code", "cursor", "codex", "gemini_cli", "antigravity", "codewhale", "ollama"])
  assert.equal(DEFAULT_RUNTIME, "claude_code")
})

test("an unknown runtime resolves to null, and a missing one to the default", () => {
  // The two cases the runner distinguishes: "update the companion" versus
  // "an old server sent no runtime at all".
  assert.equal(getRuntime("banana_cli"), null)
  assert.equal(getRuntime(""), claudeCode)
  assert.equal(getRuntime(null), claudeCode)
})

// ---------------------------------------------------------------------------
// Cursor: the allowance is a file, so the file is what gets asserted
// ---------------------------------------------------------------------------

test("a Cursor repository turn gets the same git allowance Claude Code gets", () => {
  const { permissions } = permissionsFor(REPO_JOB)

  for (const verb of ["add", "commit", "checkout", "fetch", "stash", "push", "branch"]) {
    assert.ok(permissions.allow.includes(`Shell(git ${verb})`), `git ${verb} should be allowed`)
  }
  assert.equal(
    permissions.allow.filter((entry) => entry.startsWith("Shell(git ")).length,
    GIT_VERBS.length,
    "the two runtimes must allow the same git verbs, not merely overlapping ones"
  )
})

test("the Cursor allowance stops at git — it is not a shell", () => {
  const { permissions } = permissionsFor(REPO_JOB)

  // Named individually rather than by regex, because the failure this guards
  // against is someone adding one of these to unblock a task.
  for (const forbidden of ["Shell", "Shell(*)", "Shell(npm)", "Shell(curl)", "Shell(rm)", "Shell(sudo)"]) {
    assert.ok(!permissions.allow.includes(forbidden), `${forbidden} must not be allowed`)
  }
  // And nothing may allow a bare shell by wildcard either.
  for (const entry of permissions.allow) {
    assert.ok(!/^Shell\([*]/.test(entry), `${entry} is a wildcard shell grant`)
  }
})

test("Cursor denies the git commands that destroy work", () => {
  const { permissions } = permissionsFor(REPO_JOB)

  for (const command of FORBIDDEN_GIT) {
    assert.ok(permissions.deny.includes(`Shell(${command})`), `${command} must be denied`)
  }
})

test("a plain Cursor chat gets no file tools and no shell at all", () => {
  const { permissions } = permissionsFor(CHAT_JOB)

  assert.deepEqual(permissions.allow, [])
  // The deny list still stands. An empty allow list is the grant; the denies
  // are the backstop, and dropping them for a chat would mean a future change
  // to the allow list quietly re-enables them.
  assert.ok(permissions.deny.length > 0)
})

test("--force is only ever passed with a workspace, never on a bare chat", () => {
  // --force means "don't stop to ask". It is safe only because permissions.json
  // is in place, and permissions.json only bounds a job that has a workdir.
  assert.ok(cursor.streamingArgs(REPO_JOB, "hi").includes("--force"))
  assert.ok(!cursor.streamingArgs(CHAT_JOB, "hi").includes("--force"))
  // And --yolo must never appear anywhere: it is the flag that hands over the
  // machine.
  assert.ok(!cursor.streamingArgs(REPO_JOB, "hi").includes("--yolo"))
})

test("Cursor's config is written to our directory and carries no secret", () => {
  const dir = tempDir()
  try {
    writeConfig(REPO_JOB, dir)

    const permissions = fs.readFileSync(path.join(dir, "permissions.json"), "utf8")
    const mcp = fs.readFileSync(path.join(dir, "mcp.json"), "utf8")

    // The whole point of the file living here: not ~/.cursor, not the repo.
    assert.ok(!dir.includes(".cursor"))
    assert.ok(!permissions.includes("cmagh_secret"))
    assert.ok(!mcp.includes("cmagh_secret"), "the GitHub token must travel by environment, never on disk")

    const parsed = JSON.parse(mcp)
    assert.equal(parsed.mcpServers.cma_github.args[1], "mcp-github")
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("a job with no GitHub grant leaves no stale mcp.json behind", () => {
  const dir = tempDir()
  try {
    writeConfig(REPO_JOB, dir)
    assert.ok(fs.existsSync(path.join(dir, "mcp.json")))

    // The same profile directory, reused by the next job. A leftover config
    // would keep the tools offered — and failing — after the grant is gone.
    writeConfig({ workdir: "/repo" }, dir)
    assert.ok(!fs.existsSync(path.join(dir, "mcp.json")))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("the GitHub token reaches Cursor by environment and nothing else", () => {
  const env = cursor.envFor(REPO_JOB)

  assert.equal(env.CMA_GITHUB_TOKEN, "cmagh_secret")
  assert.ok(!cursor.streamingArgs(REPO_JOB, "hi").some((arg) => String(arg).includes("cmagh_secret")))
})

test("Cursor folds the system prompt into the prompt rather than writing to the repo", () => {
  const rendered = cursor.renderPrompt(REPO_JOB, "User: hello")

  assert.ok(rendered.includes("operator instructions"))
  assert.ok(rendered.includes("User: hello"))
  // No flag carries it, because there is no such flag — that is the whole
  // reason it is in the prompt.
  assert.ok(!cursor.streamingArgs(REPO_JOB, rendered).includes("--append-system-prompt"))
})

test("Cursor has no ambient profile, so its allowance always has a home", () => {
  // If Cursor could run ambient, there would be no directory we own to put
  // permissions.json in, and --force would be unbounded.
  assert.equal(cursor.ambientProfile, false)
  assert.equal(cursor.configDirEnvVar, "CURSOR_CONFIG_DIR")
})

// ---------------------------------------------------------------------------
// Gemini: fails closed
// ---------------------------------------------------------------------------

test("Gemini auto-approves edits and nothing else", () => {
  const args = gemini.streamingArgs(REPO_JOB, "hi")
  const mode = args[args.indexOf("--approval-mode") + 1]

  assert.equal(mode, "auto_edit")
  // yolo is "automatically accept all actions". It must never be reachable.
  assert.ok(!args.includes("--yolo"))
  assert.ok(!args.includes("yolo"))
})

test("Gemini is never granted a shell — the allowance fails closed", () => {
  const args = gemini.streamingArgs(REPO_JOB, "hi")
  const allowed = String(args[args.indexOf("--allowed-tools") + 1]).split(",")

  assert.ok(allowed.includes("read_file"))
  assert.ok(allowed.includes("write_file"))
  assert.ok(!allowed.includes("run_shell_command"),
    "granting shell here would need a policy file we have not verified; the machine pushes instead")
})

test("a plain Gemini chat gets no approval mode and no tool grant", () => {
  const args = gemini.streamingArgs(CHAT_JOB, "hi")

  assert.ok(!args.includes("--approval-mode"))
  assert.ok(!args.includes("--allowed-tools"))
})

test("Gemini says what it cannot do", () => {
  // `status` prints these. A limitation nobody can see is one people discover
  // when a session ends by asking them to push its own work by hand.
  assert.ok(gemini.limitations.some((line) => /git/i.test(line)))
  assert.equal(gemini.multiLogin, false)
})

// ---------------------------------------------------------------------------
// Stream folding — one shape out, whichever runtime produced it
// ---------------------------------------------------------------------------

test("Cursor's stream folds to the shared result shape", () => {
  const events = [
    { type: "system", subtype: "init", session_id: "s1", model: "composer-2" },
    { type: "assistant", message: { content: [{ type: "text", text: "Hello " }] } },
    { type: "assistant", message: { content: [{ type: "text", text: "world" }] } },
    { type: "result", subtype: "success", result: "Hello world", is_error: false,
      usage: { input_tokens: 10, output_tokens: 4 } }
  ]

  const out = cursor.collapseEvents(events)
  assert.equal(out.content, "Hello world")
  assert.equal(out.model, "composer-2")
  assert.equal(out.usage.input_tokens, 10)
  assert.equal(out.usage.output_tokens, 4)
  assert.equal(out.isError, false)
  assert.ok(out.sawResult)
})

test("Gemini's result event carries no text, so the answer comes from the messages", () => {
  const events = [
    { type: "init", session_id: "s1", model: "gemini-2.5-pro" },
    { type: "message", role: "user", content: "hi" },
    { type: "message", role: "assistant", content: "Hello world" },
    { type: "result", status: "success",
      stats: { promptTokenCount: 10, candidatesTokenCount: 4 } }
  ]

  const out = gemini.collapseEvents(events)
  assert.equal(out.content, "Hello world", "a user message must not leak into the answer")
  assert.equal(out.model, "gemini-2.5-pro")
  assert.equal(out.usage.input_tokens, 10)
  assert.equal(out.usage.output_tokens, 4)
  assert.ok(!out.isError)
})

test("an in-band failure is a failure, whatever the exit code said", () => {
  // Every one of these CLIs reports API errors and rate limits with a ZERO
  // exit code. Trusting the exit code would render the error text as the
  // assistant's reply.
  assert.equal(cursor.collapseEvents([{ type: "result", is_error: true, result: "rate limited" }]).isError, true)
  assert.equal(gemini.collapseEvents([{ type: "result", status: "error", error: { message: "nope" } }]).isError, true)
})

test("a Gemini warning does not throw away a good answer", () => {
  const out = gemini.collapseEvents([
    { type: "message", role: "assistant", content: "Done." },
    { type: "error", severity: "warning", message: "a tool call was blocked" },
    { type: "result", status: "success", stats: {} }
  ])

  assert.equal(out.content, "Done.")
  assert.equal(out.isError, false)
})

test("a stream that dies before the result still yields what was said", () => {
  for (const runtime of [cursor, gemini]) {
    const events = runtime === cursor
      ? [{ type: "assistant", message: { content: [{ type: "text", text: "partial" }] } }]
      : [{ type: "message", role: "assistant", content: "partial" }]

    const out = runtime.collapseEvents(events)
    assert.equal(out.content, "partial")
    assert.ok(!out.sawResult, `${runtime.id} must report that no result event arrived`)
  }
})

// ---------------------------------------------------------------------------
// The ticker
// ---------------------------------------------------------------------------

test("Cursor's separate tool_call events produce the same ticker lines", () => {
  // The one structural difference from Claude Code: tool calls are their own
  // top-level events rather than blocks inside an assistant message.
  const line = (event) => cursor.describeEvent(event)

  assert.equal(line({ type: "system", subtype: "init" }), "Starting up")
  assert.equal(
    line({ type: "tool_call", subtype: "started", tool_call: { editToolCall: { args: { path: "app/models/user.rb" } } } }),
    "Editing models/user.rb"
  )
  assert.equal(
    line({ type: "tool_call", subtype: "started", tool_call: { shellToolCall: { args: { command: "cd /r && git status" } } } }),
    "Running git status"
  )
  // A completed call is not a new action — reporting it would double every
  // line in the trace.
  assert.equal(line({ type: "tool_call", subtype: "completed", tool_call: { editToolCall: {} } }), null)
})

test("Gemini's tool_use events produce the same ticker lines", () => {
  assert.equal(gemini.describeEvent({ type: "init" }), "Starting up")
  assert.equal(
    gemini.describeEvent({ type: "tool_use", tool_name: "read_file", parameters: { file_path: "app/models/user.rb" } }),
    "Reading models/user.rb"
  )
  assert.equal(
    gemini.describeEvent({ type: "tool_use", tool_name: "replace", parameters: { file_path: "a/b.rb" } }),
    "Editing a/b.rb"
  )
})

// ---------------------------------------------------------------------------
// Degrading instead of dying, for every runtime
// ---------------------------------------------------------------------------

test("stripping capability flags leaves each runtime a runnable argv", () => {
  for (const [runtime, job] of [[cursor, REPO_JOB], [gemini, REPO_JOB]]) {
    const stripped = withoutCapabilityFlags(runtime.streamingArgs(job, "the prompt"))

    for (const flag of ["--force", "--workspace", "--approval-mode", "--allowed-tools"]) {
      assert.ok(!stripped.includes(flag), `${flag} should be gone for ${runtime.id}`)
    }
    // What has to survive: the output format, the model, and the prompt.
    assert.ok(stripped.includes("--output-format"))
    assert.ok(stripped.includes("stream-json"))
    assert.equal(stripped[stripped.indexOf("--model") + 1], job.model)
    assert.ok(stripped.includes("the prompt"), `${runtime.id} lost its prompt`)
  }
})

test("the prompt survives stripping even though Cursor passes it positionally", () => {
  // Cursor's prompt is a bare positional right after -p. `withoutCapabilityFlags`
  // drops a flag AND every non-flag word after it, so a capability flag placed
  // before the prompt would eat it. This is the test that keeps the ordering
  // in streamingArgs honest.
  const stripped = withoutCapabilityFlags(cursor.streamingArgs(REPO_JOB, "open the PR"))
  assert.equal(stripped[stripped.indexOf("-p") + 1], "open the PR")
})

// ---------------------------------------------------------------------------
// Codex: sandbox posture is the whole permission story
// ---------------------------------------------------------------------------

test("a Codex repository turn is full-auto; a chat is read-only", () => {
  const repo = codex.streamingArgs(REPO_JOB)
  assert.ok(repo.includes("--full-auto"))
  assert.equal(repo[repo.indexOf("--cd") + 1], "/repo")
  assert.ok(repo.includes("--skip-git-repo-check"))

  const chat = codex.streamingArgs(CHAT_JOB)
  assert.ok(!chat.includes("--full-auto"))
  assert.equal(chat[chat.indexOf("--sandbox") + 1], "read-only")
  assert.ok(!chat.includes("--cd"))

  // The flag that bypasses both approval AND sandbox must never be reachable.
  for (const args of [repo, chat]) {
    assert.ok(!args.includes("--yolo"))
    assert.ok(!args.includes("--dangerously-bypass-approvals-and-sandbox"))
  }
})

test("the Codex prompt rides stdin, and `-` stays last so nothing can swallow it", () => {
  const args = codex.streamingArgs(REPO_JOB)
  assert.equal(codex.promptOnStdin, true)
  assert.equal(args.at(-1), "-")
})

test("a Codex repository turn opens the sandbox's network for git, a chat does not", () => {
  const repo = codex.streamingArgs(REPO_JOB)
  assert.equal(repo[repo.indexOf("-c") + 1], "sandbox_workspace_write.network_access=true")
  assert.ok(!codex.streamingArgs(CHAT_JOB).includes("-c"))
})

test("Codex's config.toml names the MCP servers and carries no secret", () => {
  const toml = configTomlFor({ ...REPO_JOB, web: { token: "cmaweb_secret", endpoint: "https://x/web" } })

  assert.ok(toml.includes("[mcp_servers.cma_github]"))
  assert.ok(toml.includes("[mcp_servers.cma_web]"))
  assert.ok(toml.includes("mcp-github"))
  assert.ok(!toml.includes("cmagh_secret"), "the GitHub token must travel by environment, never on disk")
  assert.ok(!toml.includes("cmaweb_secret"))

  // No grant, no server tables — a stale entry would offer tools that can
  // only fail.
  assert.ok(!configTomlFor(CHAT_JOB).includes("[mcp_servers"))
})

test("Codex has no ambient profile, so its MCP config always has a home we own", () => {
  assert.equal(codex.ambientProfile, false)
  assert.equal(codex.configDirEnvVar, "CODEX_HOME")
})

test("a Codex login resolves to the account that pays", () => {
  const payload = Buffer.from(JSON.stringify({ email: "dev@acme.com" })).toString("base64url")
  const oauth = accountFromAuth({ tokens: { id_token: `x.${payload}.y` } })
  assert.deepEqual(oauth, { email: "dev@acme.com", source: "oauth" })

  // An API key spends per-token billing rather than a ChatGPT plan — the
  // mix-up this feature exists to prevent, so it is named as itself.
  assert.deepEqual(accountFromAuth({ OPENAI_API_KEY: "sk-x" }), { email: null, source: "api_key" })
  assert.equal(accountFromAuth({}), null)
  assert.equal(accountFromAuth({ tokens: { id_token: "garbage" } }), null)
})

test("Codex's stream folds to the shared result shape", () => {
  const events = [
    { type: "thread.started", thread_id: "t1" },
    { type: "turn.started" },
    { type: "item.completed", item: { type: "reasoning", text: "thinking" } },
    { type: "item.completed", item: { type: "agent_message", text: "Hello world" } },
    { type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 3, output_tokens: 4 } }
  ]

  const out = codex.collapseEvents(events)
  assert.equal(out.content, "Hello world")
  assert.equal(out.usage.input_tokens, 10)
  assert.equal(out.usage.output_tokens, 4)
  assert.equal(out.usage.cache_read_input_tokens, 3, "codex spells cache reads cached_input_tokens")
  assert.ok(out.sawResult)
  assert.ok(!out.isError)
})

test("a failed Codex turn is a failure, whatever the exit code said", () => {
  const out = codex.collapseEvents([
    { type: "turn.failed", error: { message: "usage limit reached" } }
  ])
  assert.equal(out.isError, true)
  assert.match(out.errorStatus, /usage limit/)
})

test("Codex's items produce the same ticker lines", () => {
  const line = (item) => codex.describeEvent({ type: "item.started", item })

  assert.equal(line({ type: "command_execution", command: "cd /r && git status" }), "Running git status")
  assert.equal(line({ type: "file_change", changes: [{ path: "app/models/user.rb" }] }), "Editing models/user.rb")
  assert.equal(line({ type: "web_search" }), "Searching the web")
  // The answer is not a step.
  assert.equal(line({ type: "agent_message", text: "done" }), null)
})

test("a Codex file_change reports the path it wrote", () => {
  const event = { type: "item.completed", item: { type: "file_change", changes: [{ path: "docs/plan.md" }] } }
  assert.equal(codex.writtenPathFrom(event), "docs/plan.md")
  assert.equal(codex.writtenPathFrom({ type: "item.completed", item: { type: "agent_message" } }), null)
})

// ---------------------------------------------------------------------------
// Antigravity: accept-edits and nothing else
// ---------------------------------------------------------------------------

test("Antigravity auto-approves edits and nothing else", () => {
  const repo = antigravity.streamingArgs(REPO_JOB, "hi")
  assert.ok(repo.includes("--mode=accept-edits"))
  assert.ok(repo.includes("--non-interactive"))

  // The flag that approves everything — shell included — must never appear.
  assert.ok(!repo.includes("--dangerously-skip-permissions"))

  const chat = antigravity.streamingArgs(CHAT_JOB, "hi")
  assert.ok(!chat.includes("--mode=accept-edits"))
})

test("Antigravity folds the system prompt into the prompt", () => {
  const rendered = antigravity.renderPrompt(REPO_JOB, "User: hello")
  assert.ok(rendered.includes("operator instructions"))
  assert.ok(rendered.includes("User: hello"))
})

test("Antigravity's stream folds to the shared result shape", () => {
  const events = [
    { type: "init", model: "gemini-3.5-flash" },
    { type: "step_update", step_type: "text", text: "Hello " },
    { type: "step_update", step_type: "text", text: "world" },
    { type: "result", status: "success", usage: { inputTokens: 10, outputTokens: 4, cacheRead: 2 } }
  ]

  const out = antigravity.collapseEvents(events)
  assert.equal(out.content, "Hello world")
  assert.equal(out.model, "gemini-3.5-flash")
  assert.equal(out.usage.input_tokens, 10)
  assert.equal(out.usage.output_tokens, 4)
  assert.equal(out.usage.cache_read_input_tokens, 2)
  assert.ok(out.sawResult)
  assert.ok(!out.isError)
})

test("an Antigravity error result is a failure, whatever the exit code said", () => {
  const out = antigravity.collapseEvents([
    { type: "result", status: "error", error: { message: "quota exceeded" } }
  ])
  assert.equal(out.isError, true)
  assert.match(out.errorStatus, /quota/)
})

test("Antigravity's tool steps produce the same ticker lines", () => {
  assert.equal(antigravity.describeEvent({ type: "init" }), "Starting up")
  assert.equal(
    antigravity.describeEvent({
      type: "step_update", step_type: "tool_call",
      tool: { name: "write_to_file", args: { path: "app/models/user.rb" } }
    }),
    "Writing models/user.rb"
  )
  assert.equal(
    antigravity.describeEvent({ type: "step_update", step_type: "thinking" }),
    "Thinking"
  )
})

test("Antigravity says what it cannot do", () => {
  assert.ok(antigravity.limitations.some((line) => /git/i.test(line)))
  assert.equal(antigravity.multiLogin, false)
})

// ---------------------------------------------------------------------------
// CodeWhale: the sandbox bounds --auto
// ---------------------------------------------------------------------------

test("a CodeWhale repository turn is workspace-write; a chat is read-only", () => {
  const repo = codewhale.streamingArgs(REPO_JOB, "hi")
  assert.ok(repo.includes("--auto"))
  assert.equal(repo[repo.indexOf("--sandbox") + 1], "workspace-write")
  assert.equal(repo[repo.indexOf("--workspace") + 1], "/repo")

  const chat = codewhale.streamingArgs(CHAT_JOB, "hi")
  assert.ok(!chat.includes("--auto"))
  assert.equal(chat[chat.indexOf("--sandbox") + 1], "read-only")

  // The level that lifts the sandbox entirely must never be reachable.
  for (const args of [repo, chat]) {
    assert.ok(!args.includes("danger-full-access"))
  }
})

test("a repository must not be able to reconfigure the CodeWhale harness that runs over it", () => {
  const args = codewhale.streamingArgs(REPO_JOB, "hi")
  assert.ok(args.includes("--no-project-config"))
  assert.ok(args.includes("--skip-onboarding"))
})

test("the CodeWhale prompt is a positional after --, so nothing can swallow it", () => {
  const args = codewhale.streamingArgs(REPO_JOB, "open the PR")
  assert.equal(args.at(-2), "--")
  assert.equal(args.at(-1), "open the PR")
})

test("CodeWhale carries the system prompt on its own flag", () => {
  const args = codewhale.streamingArgs(REPO_JOB, "hi")
  assert.equal(args[args.indexOf("--append-system-prompt") + 1], "operator instructions")
})

test("CodeWhale's stream folds to the shared result shape", () => {
  const events = [
    { type: "metadata", model: "deepseek-v4-flash" },
    { type: "content", text: "Hello " },
    { type: "content", text: "world" },
    { type: "turn_usage", turn: 1, input_tokens: 10, output_tokens: 4, prompt_cache_hit_tokens: 2 },
    { type: "done", status: "done" }
  ]

  const out = codewhale.collapseEvents(events)
  assert.equal(out.content, "Hello world")
  assert.equal(out.model, "deepseek-v4-flash")
  assert.equal(out.usage.input_tokens, 10)
  assert.equal(out.usage.output_tokens, 4)
  assert.equal(out.usage.cache_read_input_tokens, 2, "DeepSeek spells cache reads prompt_cache_hit_tokens")
  assert.ok(out.sawResult)
  assert.ok(!out.isError)
})

test("a CodeWhale error event is a failure, whatever the exit code said", () => {
  const out = codewhale.collapseEvents([{ type: "error", message: "insufficient credit" }])
  assert.equal(out.isError, true)
  assert.match(out.errorStatus, /insufficient credit/)
})

test("CodeWhale's tool events produce the same ticker lines", () => {
  assert.equal(
    codewhale.describeEvent({ type: "tool_use", tool_name: "edit", args: { path: "app/models/user.rb" } }),
    "Editing models/user.rb"
  )
  assert.equal(
    codewhale.describeEvent({ type: "tool_use", tool_name: "bash", args: { command: "cd /r && git status" } }),
    "Running git status"
  )
  assert.equal(codewhale.describeEvent({ type: "sandbox_denied" }), "Blocked by the sandbox")
})

test("a CodeWhale write reports the path it wrote", () => {
  assert.equal(
    codewhale.writtenPathFrom({ type: "tool_use", tool_name: "write", args: { path: "docs/plan.md" } }),
    "docs/plan.md"
  )
  assert.equal(codewhale.writtenPathFrom({ type: "tool_use", tool_name: "read", args: { path: "x" } }), null)
})

// ---------------------------------------------------------------------------
// Gemini: MCP through the system-settings shim
// ---------------------------------------------------------------------------

const WEB_REPO_JOB = {
  ...REPO_JOB,
  web: { token: "cmaweb_secret", endpoint: "https://example.com/api/code/v1/web" }
}

// Runs `body` with GEMINI_CLI_SYSTEM_SETTINGS_PATH pointed at `file`, so the
// merge reads a staged "machine policy" instead of this machine's real one.
function withSystemSettings(file, body) {
  const previous = process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH
  process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH = file
  try {
    return body()
  } finally {
    if (previous === undefined) delete process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH
    else process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH = previous
  }
}

test("Gemini's shim adds our servers beside the machine's own system settings", () => {
  const dir = tempDir()
  try {
    const policy = path.join(dir, "corp-settings.json")
    fs.writeFileSync(policy, JSON.stringify({
      security: { auth: { enforcedType: "oauth" } },
      mcpServers: { corp_tools: { command: "corp", args: [] } }
    }))

    const settings = withSystemSettings(policy, () => systemSettingsFor(WEB_REPO_JOB))

    // Extending, not replacing: pointing the variable at our file must not
    // silently disable a policy that was already in force.
    assert.equal(settings.security.auth.enforcedType, "oauth")
    assert.ok(settings.mcpServers.corp_tools, "the machine's own servers survive the merge")
    assert.ok(settings.mcpServers.cma_github)
    assert.ok(settings.mcpServers.cma_web)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("Gemini's shim carries variable names, never token values", () => {
  const dir = tempDir()
  try {
    const rendered = withSystemSettings(path.join(dir, "absent.json"), () =>
      JSON.stringify(systemSettingsFor(WEB_REPO_JOB)))

    assert.ok(!rendered.includes("cmagh_secret"), "the GitHub token must travel by environment, never on disk")
    assert.ok(!rendered.includes("cmaweb_secret"))

    const settings = JSON.parse(rendered)
    // Gemini redacts the inherited environment for MCP children, so each entry
    // must ask for its variables by name — as $ references the CLI expands.
    assert.equal(settings.mcpServers.cma_github.env.CMA_GITHUB_TOKEN, "$CMA_GITHUB_TOKEN")
    assert.equal(settings.mcpServers.cma_web.env.CMA_WEB_TOKEN, "$CMA_WEB_TOKEN")
    // And a headless run has nobody to confirm a tool call, so our servers are
    // trusted — that is what makes them usable at all.
    assert.equal(settings.mcpServers.cma_github.trust, true)
    assert.equal(settings.mcpServers.cma_web.trust, true)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("Gemini points at the shim only when there is something to mount", () => {
  const filesDir = () => "/somewhere/we/own"

  const granted = gemini.envFor(WEB_REPO_JOB, { filesDir })
  assert.equal(granted.GEMINI_CLI_SYSTEM_SETTINGS_PATH, settingsPathIn("/somewhere/we/own"))
  assert.equal(granted.CMA_GITHUB_TOKEN, "cmagh_secret", "the token rides the environment")
  assert.ok(!gemini.streamingArgs(WEB_REPO_JOB, "hi").some((a) => String(a).includes("cmagh_secret")))

  // No grant: no variable, so a real enterprise policy file stays in force.
  const bare = gemini.envFor({ workdir: "/repo" }, { filesDir })
  assert.ok(!("GEMINI_CLI_SYSTEM_SETTINGS_PATH" in bare))
})

test("a Gemini job with no grant leaves no stale shim behind", () => {
  const dir = tempDir()
  try {
    const file = settingsPathIn(dir)
    withSystemSettings(path.join(dir, "absent.json"), () => {
      writeGeminiConfig(WEB_REPO_JOB, file)
      assert.ok(fs.existsSync(file))

      writeGeminiConfig({ workdir: "/repo" }, file)
      assert.ok(!fs.existsSync(file), "a leftover shim would keep offering tools whose grant is gone")
    })
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// CodeWhale: MCP through CODEWHALE_MCP_CONFIG
// ---------------------------------------------------------------------------

test("CodeWhale's MCP file names commands and carries no secret; the variable points at it", () => {
  const dir = tempDir()
  try {
    const file = mcpPathIn(dir)
    writeCodewhaleConfig(WEB_REPO_JOB, file)

    const raw = fs.readFileSync(file, "utf8")
    assert.ok(!raw.includes("cmagh_secret"), "the GitHub token must travel by environment, never on disk")
    assert.equal(JSON.parse(raw).mcpServers.cma_github.args[1], "mcp-github")

    const env = codewhale.envFor(WEB_REPO_JOB, { filesDir: () => dir })
    assert.equal(env.CODEWHALE_MCP_CONFIG, file)
    assert.equal(env.CMA_GITHUB_TOKEN, "cmagh_secret")
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("a CodeWhale job with no grant gets no MCP variable and no stale file", () => {
  const dir = tempDir()
  try {
    const file = mcpPathIn(dir)
    writeCodewhaleConfig(WEB_REPO_JOB, file)
    writeCodewhaleConfig({ workdir: "/repo" }, file)
    assert.ok(!fs.existsSync(file))

    const env = codewhale.envFor({ workdir: "/repo" }, { filesDir: () => dir })
    assert.ok(!("CODEWHALE_MCP_CONFIG" in env),
      "pointing CodeWhale at a missing file would be an error where no-MCP is the honest state")
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("stripping capability flags leaves the new runtimes a runnable argv too", () => {
  // The codex stdin marker and the CodeWhale positional must both survive the
  // degraded retry, and no stripped flag may eat the token after it — the
  // `exec` subcommand sits downstream of `--workspace` in CodeWhale's argv,
  // which is why that flag goes first.
  const codexStripped = withoutCapabilityFlags(codex.streamingArgs(REPO_JOB))
  assert.ok(codexStripped.includes("exec"))
  assert.equal(codexStripped.at(-1), "-")

  const whaleStripped = withoutCapabilityFlags(codewhale.streamingArgs(REPO_JOB, "the prompt"))
  assert.ok(whaleStripped.includes("exec"))
  assert.equal(whaleStripped.at(-1), "the prompt")
  assert.equal(whaleStripped[whaleStripped.indexOf("--model") + 1], "composer-2")

  const agyStripped = withoutCapabilityFlags(antigravity.streamingArgs(REPO_JOB, "the prompt"))
  assert.equal(agyStripped[agyStripped.indexOf("--prompt") + 1], "the prompt")
  assert.ok(!agyStripped.includes("--mode=accept-edits"))
})
