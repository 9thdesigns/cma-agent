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
import {
  grok, accountFromAuth as grokAccountFromAuth, configTomlFor as grokConfigTomlFor
} from "../src/runtimes/grok.js"
import { ollama } from "../src/runtimes/ollama.js"
import { GIT_VERBS, FORBIDDEN_GIT, lastTurnOccupancy, occupancyOf } from "../src/runtimes/shared.js"
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
    ["claude_code", "cursor", "codex", "gemini_cli", "antigravity", "grok", "codewhale", "ollama"])
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
// Cursor: the boundary is a deny list in a file plus the CLI's own sandbox.
// There is no allow list to assert — `--force` is "force allow commands unless
// explicitly denied", so under it an allow list changes nothing.
// ---------------------------------------------------------------------------

test("a Cursor repository turn allows nothing by list — --force already allows", () => {
  const { permissions } = permissionsFor(REPO_JOB)

  // An allow list under --force is decoration. An earlier version wrote one
  // (file tools + git verbs) into a permissions.json the CLI reads allow-only
  // and called that the boundary; it never was one. The honest file has
  // nothing to allow, and the denies are the whole of what it says.
  assert.deepEqual(permissions.allow, [])
  assert.ok(permissions.deny.length >= FORBIDDEN_GIT.length)
})

test("nothing in Cursor's file can widen the run — no allow entry, no wildcard", () => {
  const { permissions } = permissionsFor(REPO_JOB)

  // Named individually rather than by regex, because the failure this guards
  // against is someone adding one of these to unblock a task.
  for (const forbidden of ["Shell", "Shell(*)", "Shell(npm)", "Shell(curl)", "Shell(rm)", "Shell(sudo)"]) {
    assert.ok(!permissions.allow.includes(forbidden), `${forbidden} must not be allowed`)
  }
  for (const entry of permissions.allow) {
    assert.ok(!/^Shell\([*]/.test(entry), `${entry} is a wildcard shell grant`)
  }
})

test("Cursor denies the git commands that destroy work, in both spellings", () => {
  const { permissions } = permissionsFor(REPO_JOB)

  for (const command of FORBIDDEN_GIT) {
    // The exact full-command form is the one proven to block under --force on
    // a real build; the glob form is what Cursor documents for "with any
    // arguments" and is unproven — inert at worst, wider at best.
    assert.ok(permissions.deny.includes(`Shell(${command})`), `${command} must be denied`)
    assert.ok(permissions.deny.includes(`Shell(${command} *)`), `${command} * must be denied`)
  }
})

test("a plain Cursor chat gets the same file: nothing allowed, the denies still standing", () => {
  const { permissions } = permissionsFor(CHAT_JOB)

  assert.deepEqual(permissions.allow, [])
  // A chat runs without --force, so the denies are moot there — but they are
  // written anyway, so a future change cannot leave one kind of turn without
  // them.
  assert.deepEqual(permissions.deny, permissionsFor(REPO_JOB).permissions.deny)
})

test("--force and the sandbox travel together, with a workspace, never on a bare chat", () => {
  // --force means "allow unless denied". What bounds it is the deny list in
  // cli-config.json plus Cursor's OS sandbox, so the sandbox is pinned on
  // explicitly wherever --force goes.
  const repo = cursor.streamingArgs(REPO_JOB)
  const chat = cursor.streamingArgs(CHAT_JOB)
  assert.ok(repo.includes("--force"))
  assert.equal(repo[repo.indexOf("--sandbox") + 1], "enabled")
  assert.ok(!chat.includes("--force"))
  assert.ok(!chat.includes("--sandbox"))
  // And --yolo must never appear anywhere: it is --force's alias, and a
  // second spelling is a second thing to audit.
  assert.ok(!repo.includes("--yolo"))
})

test("Cursor's config is written to our directory and carries no secret", () => {
  const dir = tempDir()
  try {
    // A leftover from the earlier design in the same profile directory.
    fs.writeFileSync(path.join(dir, "permissions.json"), "{}\n")
    writeConfig(REPO_JOB, dir)

    const config = fs.readFileSync(path.join(dir, "cli-config.json"), "utf8")
    const mcp = fs.readFileSync(path.join(dir, "mcp.json"), "utf8")

    // The whole point of the file living here: not ~/.cursor, not the repo.
    assert.ok(!dir.includes(".cursor"))
    assert.ok(!config.includes("cmagh_secret"))
    assert.ok(!mcp.includes("cmagh_secret"), "the GitHub token must travel by environment, never on disk")
    // The CLI reads permissions.json allow-only, so it bounded nothing; left
    // behind it would only mislead whoever reads the profile directory.
    assert.ok(!fs.existsSync(path.join(dir, "permissions.json")))

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
  // cli-config.json in, and --force would be unbounded.
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
    { type: "system", subtype: "init", session_id: "s1", model: "composer-2.5" },
    { type: "assistant", message: { content: [{ type: "text", text: "Hello " }] } },
    { type: "assistant", message: { content: [{ type: "text", text: "world" }] } },
    { type: "result", subtype: "success", result: "Hello world", is_error: false, session_id: "s1",
      usage: { inputTokens: 10, outputTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 0 } }
  ]

  const out = cursor.collapseEvents(events)
  assert.equal(out.content, "Hello world")
  assert.equal(out.model, "composer-2.5")
  assert.equal(out.usage.model_label, "composer-2.5")
  assert.equal(out.usage.runtime_session_id, "s1")
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

test("Claude Code's context reading is the last turn's prompt, not the run's total", () => {
  // The bug this exists to prevent, in one object: `result.usage` is every
  // turn of the run added together, so reporting it as occupancy told a user
  // their 200k window held 2,479,706 tokens. Each assistant message carries
  // the usage of the prompt that produced IT, and the last of those is where
  // the window actually stands.
  const events = [
    { type: "assistant", message: { model: "claude-opus-5", content: [{ type: "text", text: "Reading…" }],
                                    usage: { input_tokens: 1_000, cache_read_input_tokens: 40_000,
                                             cache_creation_input_tokens: 2_000, output_tokens: 300 } } },
    // A subagent's own conversation, in its own window. Counting it would
    // report somebody else's occupancy as this session's.
    { type: "assistant", parent_tool_use_id: "toolu_1",
      message: { content: [{ type: "text", text: "sub" }],
                 usage: { input_tokens: 900_000, cache_read_input_tokens: 0,
                          cache_creation_input_tokens: 0, output_tokens: 10 } } },
    { type: "assistant", message: { content: [{ type: "text", text: "Done." }],
                                    usage: { input_tokens: 500, cache_read_input_tokens: 61_000,
                                             cache_creation_input_tokens: 1_500, output_tokens: 700 } } },
    { type: "result", subtype: "success", result: "Done.", is_error: false,
      modelUsage: { "claude-opus-5": {} },
      usage: { input_tokens: 4_000, output_tokens: 1_100,
               cache_read_input_tokens: 2_400_000, cache_creation_input_tokens: 12_000 } }
  ]

  const out = claudeCode.collapseEvents(events)

  // Spend is still the whole run — that half was never wrong.
  assert.equal(out.usage.input_tokens, 4_000)
  assert.equal(out.usage.cache_read_input_tokens, 2_400_000)
  // Occupancy is the LAST top-level turn: 500 + 61,000 + 1,500.
  assert.equal(out.usage.context_tokens, 63_000)
})

test("a Claude Code run whose turns report no usage reports no context reading", () => {
  // Zero means "we don't know", and the server draws no meter for it. That is
  // the whole contract with Code::GenerateResponseJob#context_occupancy: a
  // missing meter is recoverable, a confident wrong one is not.
  const out = claudeCode.collapseEvents([
    { type: "assistant", message: { content: [{ type: "text", text: "Done." }] } },
    { type: "result", subtype: "success", result: "Done.", is_error: false,
      usage: { input_tokens: 900, output_tokens: 40 } }
  ])

  assert.equal(out.usage.context_tokens, 0)
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

test("compaction makes occupancy fall, and the meter follows it down", () => {
  const out = claudeCode.collapseEvents([
    { type: "assistant", message: { content: [], usage: { input_tokens: 190_000 } } },
    { type: "assistant", message: { content: [], usage: { input_tokens: 22_000 } } },
    { type: "result", result: "Done.", usage: {} }
  ])

  assert.equal(out.usage.context_tokens, 22_000, "last turn wins, even when it is smaller")
})

test("a runtime that cannot tell the two apart reports 0, not a guess", () => {
  // The buffered fallback has only the envelope's totals — no per-turn events
  // to read — so it must say "unknown". The server draws no meter for 0.
  const out = claudeCode.parseBuffered(JSON.stringify({
    result: "Done.", usage: { input_tokens: 1500, cache_read_input_tokens: 250_000 }
  }))

  assert.equal(out.usage.context_tokens, 0)
  assert.equal(out.usage.cache_read_input_tokens, 250_000)
})

// ---------------------------------------------------------------------------
// The context reading, across every runtime.
//
// One rule, seven adapters: `usage.context_tokens` is the size of the LAST
// prompt, and it is 0 when the CLI did not say. What differs is whether that
// CLI can say at all, which is a property of the product and not of our code
// — so these tests pin the answer per runtime rather than asserting one
// behaviour for all of them.
// ---------------------------------------------------------------------------

test("every adapter reports a context reading, even when that reading is 'unknown'", () => {
  // The field has to EXIST everywhere: a missing key reaches the server as
  // nil, which is indistinguishable from "the companion is too old" and is
  // the wrong explanation to give someone.
  for (const runtime of [claudeCode, cursor, codex, gemini, antigravity, codewhale, ollama]) {
    const out = runtime.collapseEvents([])
    assert.equal(out.usage.context_tokens, 0, `${runtime.id} reports a number`)
  }
})

test("occupancy is every input-side count, and never the output", () => {
  // Cache reads and writes are prompt tokens — billed differently, but they
  // occupy the window all the same. Output does not: it enters the window
  // only as part of the next prompt.
  assert.equal(occupancyOf({
    input_tokens: 500, cache_read_input_tokens: 61_000,
    cache_creation_input_tokens: 1_500, output_tokens: 9_999
  }), 63_000)
})

test("Cursor derives the last prompt from per-turn usage, should a build ever report it", () => {
  // No Cursor build has been seen to put usage on assistant events. If one
  // does, it is read in Cursor's own spelling and means what it means for
  // Claude Code — including that a subagent's window is not this one's.
  const out = cursor.collapseEvents([
    { type: "assistant", message: { content: [{ type: "text", text: "Reading…" }],
                                    usage: { inputTokens: 1_000, cacheReadTokens: 40_000 } } },
    { type: "assistant", parent_tool_use_id: "toolu_1",
      message: { content: [], usage: { inputTokens: 800_000 } } },
    { type: "assistant", message: { content: [{ type: "text", text: "Done." }],
                                    usage: { inputTokens: 500, cacheReadTokens: 61_000 } } },
    { type: "result", subtype: "success", result: "Done.", is_error: false,
      usage: { inputTokens: 2_000, cacheReadTokens: 900_000, outputTokens: 300, cacheWriteTokens: 0 } }
  ])

  assert.equal(out.usage.cache_read_input_tokens, 900_000, "spend is still the whole run")
  assert.equal(out.usage.context_tokens, 61_500)
})

test("a Cursor build that reports no per-turn usage reports no context reading", () => {
  const out = cursor.collapseEvents([
    { type: "assistant", message: { content: [{ type: "text", text: "Done." }] } },
    { type: "result", result: "Done.",
      usage: { inputTokens: 400_000, outputTokens: 12, cacheReadTokens: 0, cacheWriteTokens: 0 } }
  ])

  assert.equal(out.usage.context_tokens, 0, "the run total must not stand in for a prompt")
})

test("CodeWhale sums its per-turn counts and keeps the last one as the reading", () => {
  // `turn_usage` is documented per model call, so a three-call run spent all
  // three — and sits at the size of the third. Keeping only the last call
  // (what this adapter once did) under-reported the run by a factor of its
  // length. The counts are INCLUSIVE — `input_tokens` is the whole prompt
  // with the hits inside it (CodeWhale's shape lock: prompt 20 = hit 12 +
  // miss 8 → input_tokens 20) — so the spend is the fresh part of each call
  // and the occupancy is the last prompt as reported, never re-added.
  const out = codewhale.collapseEvents([
    { type: "turn_usage", turn: 1, input_tokens: 10_000, output_tokens: 400,
      prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 10_000, duration_ms: 900 },
    { type: "turn_usage", turn: 2, input_tokens: 12_000, output_tokens: 600,
      prompt_cache_hit_tokens: 8_000, prompt_cache_miss_tokens: 4_000, duration_ms: 900 },
    { type: "turn_usage", turn: 3, input_tokens: 30_000, output_tokens: 900,
      prompt_cache_hit_tokens: 26_000, prompt_cache_miss_tokens: 4_000, duration_ms: 900 },
    { type: "done" }
  ])

  assert.equal(out.usage.input_tokens, 18_000, "spend is the fresh part of every call added together")
  assert.equal(out.usage.output_tokens, 1_900)
  assert.equal(out.usage.cache_read_input_tokens, 34_000)
  assert.equal(out.usage.context_tokens, 30_000, "occupancy is the last call's whole prompt, not 30,000 + 26,000")
  assert.equal(out.usage.num_turns, 3)
})

test("Ollama's prompt count is both its spend and its occupancy", () => {
  // One /api/chat call, no tools, so there is exactly one prompt and the two
  // measurements coincide. This is the only runtime where that is true.
  const out = ollama.collapseEvents([
    { model: "qwen3:8b", message: { content: "Hi." } },
    { model: "qwen3:8b", done: true, done_reason: "stop",
      prompt_eval_count: 5_120, eval_count: 240 }
  ])

  assert.equal(out.usage.input_tokens, 5_120)
  assert.equal(out.usage.context_tokens, 5_120)
})

test("Codex reports nothing until a build emits the per-request figure", () => {
  // `turn.completed.usage` is the SESSION's cumulative count — openai/codex
  // #17539, which is why 6.9M cumulative input can sit against a 272K window.
  // Reading it as occupancy is the exact bug this whole area exists to fix.
  const cumulative = codex.collapseEvents([
    { type: "item.completed", item: { item_type: "agent_message", text: "Done." } },
    { type: "turn.completed", usage: { input_tokens: 6_900_000, cached_input_tokens: 40_000,
                                       output_tokens: 12_000 } }
  ])

  // Codex counts the cache INSIDE input_tokens, so the additive spend is the
  // gross count net of the cached share — the sum still equals Codex's own.
  assert.equal(cumulative.usage.input_tokens, 6_860_000, "spend is reported as given, in the additive shape")
  assert.equal(cumulative.usage.cache_read_input_tokens, 40_000)
  assert.equal(cumulative.usage.context_tokens, 0, "and is emphatically not an occupancy")

  // The field that issue asked for, in the shape it asked for it. In Codex's
  // shape the gross input IS the prompt (its cached share is inside it), so
  // the occupancy is that count alone — not input plus cached.
  const withLast = codex.collapseEvents([
    { type: "turn.completed", usage: { input_tokens: 6_900_000, output_tokens: 12_000 },
      last_usage: { input_tokens: 248_301, cached_input_tokens: 4_000 } }
  ])

  assert.equal(withLast.usage.context_tokens, 248_301)
})

test("Codex picks the per-request figure up from a token_count event too", () => {
  const out = codex.collapseEvents([
    { type: "token_count", info: { total_token_usage: { input_tokens: 900_000 },
                                   last_token_usage: { input_tokens: 61_000, cached_input_tokens: 2_000 } } },
    { type: "turn.completed", usage: { input_tokens: 900_000, output_tokens: 400 } }
  ])

  // Inclusive shape again: 61,000 is the whole prompt, 2,000 of it cached.
  assert.equal(out.usage.context_tokens, 61_000)
})

test("Gemini and Antigravity report aggregates, so they report no reading", () => {
  // Gemini's `stats` and Antigravity's result usage both accumulate over the
  // session. Neither publishes a last-request figure today; both are wired to
  // pick one up the day they do.
  const g = gemini.collapseEvents([
    { type: "result", status: "success",
      stats: { models: { "gemini-3.1-pro": {} }, promptTokenCount: 1_200_000, candidatesTokenCount: 9_000 } }
  ])
  assert.equal(g.usage.context_tokens, 0)

  // Antigravity's `result.usage` is cumulative too (for the whole
  // conversation under --conversation), so a result on its own is no
  // reading. Each DONE agent_response step carries that one call's usage,
  // and the last of them is the reading — see runtime_antigravity.test.js.
  const a = antigravity.collapseEvents([
    { event: "result", result: { status: "SUCCESS", response: "ok",
      usage: { input_tokens: 800_000, output_tokens: 4_000, cache_read_tokens: 0, total_tokens: 804_000 } } }
  ])
  assert.equal(a.usage.context_tokens, 0)

  const aWithStep = antigravity.collapseEvents([
    { event: "step_update", step_update: { step_index: 2, state: "DONE", step_type: "agent_response", text_delta: "ok",
      usage: { input_tokens: 2_561, output_tokens: 554, cache_read_tokens: 8_174, total_tokens: 3_115 } } },
    { event: "result", result: { status: "SUCCESS", response: "ok",
      usage: { input_tokens: 800_000, output_tokens: 4_000, cache_read_tokens: 8_174, total_tokens: 804_000 } } }
  ])
  assert.equal(aWithStep.usage.context_tokens, 10_735)

  const gWithLast = gemini.collapseEvents([
    { type: "result", status: "success",
      stats: { promptTokenCount: 1_200_000, lastUsage: { input_tokens: 84_000 } } }
  ])
  assert.equal(gWithLast.usage.context_tokens, 84_000)
})

test("the per-request probe never mistakes the cumulative object for a turn", () => {
  // `usage` on its own is the trap: it is present on every one of these
  // events and it is always the total. It must not be a candidate.
  assert.equal(lastTurnOccupancy({ usage: { input_tokens: 6_900_000 } }), 0)
  assert.equal(lastTurnOccupancy({ last_usage: { input_tokens: 42 } }), 42)
  assert.equal(lastTurnOccupancy(null), 0)
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
    // What has to survive: the output format, the model, and the prompt —
    // which, for a runtime that reads it from stdin, was never on argv to lose.
    assert.ok(stripped.includes("--output-format"))
    assert.ok(stripped.includes("stream-json"))
    assert.equal(stripped[stripped.indexOf("--model") + 1], job.model)
    if (runtime.promptOnStdin) {
      assert.ok(!stripped.includes("the prompt"), `${runtime.id} must keep the prompt off argv`)
    } else {
      assert.ok(stripped.includes("the prompt"), `${runtime.id} lost its prompt`)
    }
  }
})

test("Cursor's prompt rides stdin, so no flag can swallow it and no `ps` can show it", () => {
  // `-p` with no positional reads the prompt from stdin. A positional is
  // capped at 128 KiB on Linux — a code session whose history passed that
  // failed to spawn at all — and sits in `ps` for the whole run. The engine
  // pipes it because the adapter says so; the second parameter is ignored so
  // a caller written for the positional form cannot leak it onto argv either.
  assert.equal(cursor.promptOnStdin, true)
  const args = cursor.streamingArgs(REPO_JOB, "open the PR")
  assert.ok(!args.includes("open the PR"))
  assert.equal(args[0], "-p")
  assert.ok(args[1].startsWith("-"), "nothing positional may follow -p, or the CLI reads it as the prompt")
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
  // Codex's input_tokens (10) INCLUDES its cached_input_tokens (3); the shared
  // shape is additive, so the adapter reports 7 fresh + 3 cached.
  assert.equal(out.usage.input_tokens, 7)
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
// Grok Build: the allowance is flags again, so the argv is what gets asserted
// ---------------------------------------------------------------------------

test("a Grok repository turn gets the same git allowance Claude Code gets", () => {
  const args = grok.streamingArgs(REPO_JOB)
  const allowed = args.filter((arg, i) => args[i - 1] === "--allow")

  for (const verb of ["add", "commit", "checkout", "fetch", "stash", "push", "branch"]) {
    assert.ok(allowed.includes(`Bash(git ${verb}*)`), `git ${verb} should be allowed`)
  }
  for (const rule of ["Read(**)", "Write(**)", "Edit(**)"]) {
    assert.ok(allowed.includes(rule), `${rule} should be allowed on a repository turn`)
  }
})

test("a Grok chat turn gets no files, no shell and a read-only sandbox", () => {
  const args = grok.streamingArgs(CHAT_JOB)
  const allowed = args.filter((arg, i) => args[i - 1] === "--allow")

  assert.deepEqual(allowed, [], "a chat completion has nothing to be allowed to do")
  assert.equal(args[args.indexOf("--sandbox") + 1], "read-only")
})

test("Grok denies the destructive git commands on every job, chat included", () => {
  for (const job of [REPO_JOB, CHAT_JOB]) {
    const args = grok.streamingArgs(job)
    const denied = args.filter((arg, i) => args[i - 1] === "--deny")

    for (const command of FORBIDDEN_GIT) {
      assert.ok(denied.includes(`Bash(${command}*)`), `${command} should be denied`)
    }
  }
})

test("Grok's deny rules are not droppable, so a degraded retry cannot run unbounded", () => {
  // --yolo without a deny list is the `--force` mistake the Cursor adapter
  // documents. The engine strips capability flags on a retry, so the test that
  // matters is that stripping leaves the boundary standing.
  const stripped = withoutCapabilityFlags(grok.streamingArgs(REPO_JOB))

  assert.ok(stripped.includes("--deny"), "the deny list must survive a degraded retry")
  assert.ok(stripped.includes("Bash(git push --force*)"))
  assert.ok(!stripped.includes("--no-auto-update"), "automation hygiene is droppable")
})

test("the Grok prompt stays last so no dropped flag can swallow it", () => {
  const args = grok.streamingArgs(REPO_JOB, "do the thing")

  assert.equal(grok.promptOnStdin, false)
  assert.equal(args.at(-1), "do the thing")
  assert.equal(args.at(-2), "-p")
  // And it is still last after the engine drops what a build rejected.
  assert.equal(withoutCapabilityFlags(args).at(-1), "do the thing")
})

test("Grok's system text is fenced into the prompt, never passed in argv", () => {
  const prompt = grok.renderPrompt(REPO_JOB, "hello")

  assert.match(prompt, /<system>\noperator instructions\n<\/system>/)
  assert.ok(!grok.streamingArgs(REPO_JOB).includes("--rules"),
            "operator instructions must not be visible in `ps`")
})

test("Grok's config.toml names the MCP servers, carries no secret, and turns off its own extras", () => {
  const toml = grokConfigTomlFor({ ...REPO_JOB, web: { token: "cmaweb_secret", endpoint: "https://x/web" } })

  assert.ok(toml.includes("[mcp_servers.cma_github]"))
  assert.ok(toml.includes("[mcp_servers.cma_web]"))
  assert.ok(!toml.includes("cmagh_secret"), "the GitHub token must travel by environment, never on disk")
  assert.ok(!toml.includes("cmaweb_secret"))

  // The two features Configure My AI owns, off at the source rather than only
  // denied at call time.
  assert.ok(toml.includes("disable_web_search = true"))
  assert.match(toml, /\[subagents\]\nenabled = false/)

  // Bare keys before the first table header, or the file is not valid TOML.
  assert.ok(toml.indexOf("disable_web_search") < toml.indexOf("["))

  assert.ok(!grokConfigTomlFor(CHAT_JOB).includes("[mcp_servers"))
})

test("Grok has no ambient profile, so its config always has a home we own", () => {
  assert.equal(grok.ambientProfile, false)
  assert.equal(grok.configDirEnvVar, "GROK_HOME")
})

test("a Grok run cannot fall back to an API key the machine happens to export", () => {
  // The runtime exists to spend a subscription. xAI's credential order ends at
  // XAI_API_KEY from the environment, so a profile whose session had lapsed
  // would silently bill per token on a different account instead of failing.
  const env = grok.envFor(REPO_JOB)

  assert.ok("XAI_API_KEY" in env, "the key must be overridden, not merely absent")
  assert.equal(env.XAI_API_KEY, undefined, "undefined is what makes spawn omit it from the child")
})

test("Grok's no-browser sign-in is the documented device flow", () => {
  assert.deepEqual(grok.loginArgs(), ["login"])
  assert.deepEqual(grok.loginArgs({ deviceAuth: true }), ["login", "--device-auth"])
})

test("every runtime's loginArgs takes the options the CLI now passes", () => {
  // cma-agent hands `{ deviceAuth }` to every sign-in. A runtime with a
  // documented no-browser flow may answer differently; every other one has to
  // ignore it rather than grow a flag its CLI has never heard of.
  const DEVICE_FLOW = ["grok"]

  for (const runtime of RUNTIMES) {
    const withOption = runtime.loginArgs({ deviceAuth: true })
    assert.ok(Array.isArray(withOption), `${runtime.id} must still return an argv`)
    if (DEVICE_FLOW.includes(runtime.id)) continue

    assert.deepEqual(withOption, runtime.loginArgs(),
                     `${runtime.id} changed its login for an option it does not support`)
  }
})

test("a Grok login resolves to the account that pays", () => {
  assert.deepEqual(grokAccountFromAuth({ email: "dev@acme.com" }), { email: "dev@acme.com", source: "oauth" })
  // An API key bills per token rather than spending a SuperGrok plan.
  assert.deepEqual(grokAccountFromAuth({ XAI_API_KEY: "xai-x" }), { email: null, source: "api_key" })
  assert.equal(grokAccountFromAuth({}), null)
})

// Line shapes are the serde structs in xai-org/grok-build
// (headless/reducer/acp.rs): text and thought carry `data`, a `usage` line
// nests its counts, and `end` carries `stopReason` + `sessionId`.
test("Grok's stream folds to the shared result shape", () => {
  const out = grok.collapseEvents([
    { type: "thought", data: "thinking" },
    { type: "text", data: "Hello " },
    { type: "text", data: "world" },
    { type: "usage", messageId: "resp_1", stopReason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, reasoning_tokens: 0 } },
    { type: "end", stopReason: "end_turn", sessionId: "0192b4c6-7d2e-7a3b-8c4d-5e6f70819a2b", requestId: "xyz" }
  ])

  assert.equal(out.content, "Hello world")
  assert.equal(out.usage.input_tokens, 10)
  assert.equal(out.usage.output_tokens, 4)
  assert.equal(out.stopReason, "end_turn")
  assert.ok(out.sawResult)
  assert.ok(!out.isError)
})

test("a Grok end event carries no text on this format, so the streamed chunks are the answer", () => {
  const out = grok.collapseEvents([
    { type: "text", data: "the whole " },
    { type: "text", data: "answer" },
    { type: "end", stopReason: "end_turn", sessionId: "s", requestId: "r" }
  ])
  assert.equal(out.content, "the whole answer")
})

test("a failed Grok turn is a failure, whatever the exit code said", () => {
  const out = grok.collapseEvents([{ type: "error", message: "quota exhausted" }])
  assert.equal(out.isError, true)
  assert.match(out.errorStatus, /quota exhausted/)
})

// A tool call is `toolName` + `rawInput` (ACP leaf names), and `bash` is
// the shell tool xAI's own init example lists.
test("Grok's tool calls produce the same ticker lines", () => {
  const line = (event) => grok.describeEvent(event)

  assert.equal(line({ type: "tool_call", toolCallId: "c1", title: "Read", kind: "read", status: "in_progress",
                      toolName: "read_file", rawInput: { path: "app/models/user.rb" }, content: [], locations: [] }),
               "Reading models/user.rb")
  assert.equal(line({ type: "tool_call", toolName: "bash", kind: "execute", rawInput: { command: "cd /r && git status" } }),
               "Running git status")
  assert.equal(line({ type: "tool_call", toolName: "grep", kind: "search", rawInput: {} }), "Searching the code")
  assert.equal(line({ type: "thought", data: "hmm" }), "Thinking")
  assert.equal(line({ type: "text", data: "the answer" }), null, "the answer is not a step")
})

test("a Grok write reports the path it wrote", () => {
  assert.equal(grok.writtenPathFrom({ type: "tool_call", toolName: "search_replace", kind: "edit",
                                      rawInput: { path: "docs/plan.md" }, locations: [{ path: "docs/plan.md" }] }),
               "docs/plan.md")
  assert.equal(grok.writtenPathFrom({ type: "tool_call", toolName: "read_file", kind: "read", rawInput: { path: "docs/plan.md" } }),
               null)
})

// ---------------------------------------------------------------------------
// Antigravity: the real flag table and event shape — the full set of cases
// against captured streams is agent/test/runtime_antigravity.test.js
// ---------------------------------------------------------------------------

test("Antigravity skips the edit review on repository turns and nothing more", () => {
  const repo = antigravity.streamingArgs(REPO_JOB, "hi")
  assert.ok(repo.includes("--mode=accept-edits"))
  // Not an agy flag: every run and every login probe died on it at argv
  // parsing ("flags provided but not defined").
  assert.ok(!repo.includes("--non-interactive"))
  assert.equal(repo[repo.indexOf("--output-format") + 1], "stream-json")

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
  // `event` discriminates and the payload sits under a key named after it;
  // text arrives only as text_delta on agent_response steps; the same usage
  // rides the DONE step and the result (CHANGELOG 1.1.8, captured on 1.1.13+).
  const usage = { input_tokens: 10, output_tokens: 4, cache_read_tokens: 2, total_tokens: 14 }
  const events = [
    { event: "init", conversation_id: "c1", init: { model: "gemini-3.7-flash-medium" } },
    { event: "step_update", conversation_id: "c1",
      step_update: { step_index: 1, state: "ACTIVE", step_type: "agent_response", text_delta: "Hello " } },
    { event: "step_update", conversation_id: "c1",
      step_update: { step_index: 1, state: "DONE", step_type: "agent_response", text_delta: "world", usage } },
    { event: "result", conversation_id: "c1",
      result: { status: "SUCCESS", response: "Hello world", error: "", num_turns: 1, usage, denied_actions: [] } }
  ]

  const out = antigravity.collapseEvents(events)
  assert.equal(out.content, "Hello world")
  assert.equal(out.model, "gemini-3.7-flash-medium")
  assert.equal(out.usage.input_tokens, 10)
  assert.equal(out.usage.output_tokens, 4)
  assert.equal(out.usage.cache_read_input_tokens, 2, "additive, as agy reports it")
  assert.equal(out.usage.runtime_session_id, "c1")
  assert.ok(out.sawResult)
  assert.ok(!out.isError)
})

test("an Antigravity error result is a failure, whatever the exit code said", () => {
  const out = antigravity.collapseEvents([
    { event: "result", result: { status: "ERROR", response: "", error: "quota exceeded" } }
  ])
  assert.equal(out.isError, true)
  assert.match(out.errorStatus, /quota/)
})

test("Antigravity's tool steps produce the same ticker lines", () => {
  assert.equal(antigravity.describeEvent({ event: "init", init: { model: "gemini-3.7-flash-medium" } }), "Starting up")
  assert.equal(
    antigravity.describeEvent({
      event: "step_update",
      step_update: { state: "ACTIVE", step_type: "tool", tool_name: "write_to_file",
                     tool_info: { name: "write_to_file", parameters: { TargetFile: "app/models/user.rb" } } }
    }),
    "Writing models/user.rb"
  )
  assert.equal(
    antigravity.describeEvent({ event: "step_update", step_update: { step_type: "subagent" } }),
    "Delegating to a sub-agent"
  )
})

test("Antigravity says what it cannot do", () => {
  assert.ok(antigravity.limitations.some((line) => /git/i.test(line)))
  assert.ok(antigravity.limitations.some((line) => /permissions\.allow/.test(line)))
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
  // The terminal receipt nests everything under `meta` and is the LAST event
  // before `done` — a flat `{ type: "metadata", model }` is a shape CodeWhale
  // never emits, and reading it left the model null on every real run.
  const envelope = { schema: "codewhale.exec-stream", schema_version: 1 }
  const events = [
    { ...envelope, type: "content", content: "Hello " },
    { ...envelope, type: "content", content: "world" },
    { ...envelope, type: "turn_usage", turn: 1, input_tokens: 10, output_tokens: 4,
      prompt_cache_hit_tokens: 2, prompt_cache_miss_tokens: 8, duration_ms: 400 },
    { ...envelope, type: "metadata", meta: {
      receipt_kind: "terminal", provider: "deepseek", model: "deepseek-v4-flash", route_source: "config",
      input_tokens: 10, output_tokens: 4, prompt_cache_hit_tokens: 2, prompt_cache_miss_tokens: 8,
      duration_ms: 400, approval_posture: "deny", sandbox_posture: "read-only", prompt_sha256: "0a1b",
      session_id: "fp-3f9c", resume_command: "codewhale --resume 01JXAMPLE", workspace: "/repo",
      message_count: 2, status: "completed"
    } },
    { ...envelope, type: "done" }
  ]

  const out = codewhale.collapseEvents(events)
  assert.equal(out.content, "Hello world")
  assert.equal(out.model, "deepseek-v4-flash")
  assert.equal(out.usage.input_tokens, 8, "the 2 hits sit inside the prompt of 10; the fresh part is 8")
  assert.equal(out.usage.output_tokens, 4)
  assert.equal(out.usage.cache_read_input_tokens, 2, "DeepSeek spells cache reads prompt_cache_hit_tokens")
  assert.equal(out.usage.context_tokens, 10, "occupancy is the prompt as reported")
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
