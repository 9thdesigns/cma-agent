import test from "node:test"
import assert from "node:assert/strict"

import {
  antigravity, contextWindowFor, envelopeFrom, modelFor, modelsFrom, printTimeout, probeOutcome,
  resumeIdOf
} from "../src/runtimes/antigravity.js"
import { withoutCapabilityFlags } from "../src/engine.js"

// ---------------------------------------------------------------------------
// Antigravity (`agy`), against the wire as real builds emit it.
//
// No agy build was available to this codebase; every fixture below is a
// capture a third-party harness published from a real run (builds 1.1.13
// through 1.2.2), or the official CHANGELOG's stated contract — see
// docs/internal/provider-wire-contracts.md for which is which.
// The first adapter guessed both the flags and the event shape, and no run
// ever completed; these tests pin the real ones.
// ---------------------------------------------------------------------------

const REPO_JOB = { model: "gemini-3.7-flash-medium", system: "operator instructions", workdir: "/repo" }
const CHAT_JOB = { model: "gemini-3.7-flash-medium", system: "operator instructions" }

// The stream-json contract (CHANGELOG 1.1.8; shapes as hadron / DwarfAI /
// kernelbench / kivio parse them): `event` discriminates, the payload sits
// under a key named after the event, text arrives only as text_delta.
const INIT = {
  event: "init", conversation_id: "c3b6",
  init: { model: "gemini-3.7-flash-medium", cwd: "/repo", tools: ["run_command", "write_to_file", "view_file"],
          permission_mode: "request-review" }
}
const TOOL_ACTIVE = {
  event: "step_update", conversation_id: "c3b6",
  step_update: { step_index: 3, state: "ACTIVE", step_type: "tool", tool_name: "view_file",
                 tool_info: { name: "view_file", parameters: { AbsolutePath: "/repo/a.txt" } } }
}
const TOOL_DONE = {
  event: "step_update", conversation_id: "c3b6",
  step_update: { step_index: 3, state: "DONE", step_type: "tool", tool_name: "view_file",
                 tool_info: { name: "view_file", parameters: { AbsolutePath: "/repo/a.txt" }, output: "a" } }
}
const TEXT_ACTIVE = {
  event: "step_update", conversation_id: "c3b6",
  step_update: { step_index: 4, state: "ACTIVE", step_type: "agent_response", text_delta: "Hello " }
}
const USAGE = { input_tokens: 2561, output_tokens: 554, thinking_tokens: 120, cache_read_tokens: 8174, total_tokens: 3115 }
const TEXT_DONE = {
  event: "step_update", conversation_id: "c3b6",
  step_update: { step_index: 4, state: "DONE", step_type: "agent_response", text_delta: "\n",
                 duration_seconds: 2.1, usage: USAGE }
}
const RESULT = {
  event: "result", conversation_id: "c3b6",
  result: { conversation_id: "c3b6", status: "SUCCESS", response: "Hello\n", error: "", duration_seconds: 9.8,
            num_turns: 1, usage: USAGE, denied_actions: [] }
}
const STREAM = [INIT, TOOL_ACTIVE, TOOL_DONE, TEXT_ACTIVE, TEXT_DONE, RESULT]

function result(overrides) {
  return { event: "result", conversation_id: "c3b6", result: { conversation_id: "c3b6", status: "SUCCESS",
           response: "", error: "", num_turns: 1, usage: USAGE, denied_actions: [], ...overrides } }
}

// ---------------------------------------------------------------------------
// argv: the flag table agy actually has
// ---------------------------------------------------------------------------

test("the headless invocation is agy's own: --prompt, stream-json, a turn clock, no --non-interactive", () => {
  const args = antigravity.streamingArgs(REPO_JOB, "the prompt")

  assert.deepEqual(args.slice(0, 2), ["--prompt", "the prompt"], "the prompt is the value of --prompt")
  assert.equal(args[args.indexOf("--output-format") + 1], "stream-json")
  // The flag the first adapter invented. Unknown flags are fatal to agy
  // ("flags provided but not defined"), so every run and probe died on it.
  assert.ok(!args.includes("--non-interactive"))
  assert.ok(!args.includes("--effort"), "the tier travels in the slug, never as a second flag")
  assert.ok(args.includes("--disable-slash-commands"))
  assert.equal(antigravity.promptOnStdin, false)
})

test("agy's five-minute default turn clock is replaced by the companion's own ceiling", () => {
  const args = antigravity.streamingArgs(CHAT_JOB, "hi")
  const value = args[args.indexOf("--print-timeout") + 1]

  assert.match(value, /^\d+m$/, "a Go duration")
  assert.ok(Number.parseInt(value, 10) >= 5, "never shorter than agy's own 5m0s default")

  assert.equal(printTimeout({}), "240m", "the engine's 4h reaping ceiling")
  assert.equal(printTimeout({ CMA_MAX_RUN_MS: "90000" }), "2m", "rounded up, never down")
  assert.equal(printTimeout({ CMA_MAX_RUN_MS: "1" }), "1m", "`0` means instantly to agy, so one minute is the floor")
  assert.equal(printTimeout({ CMA_MAX_RUN_MS: "0" }), "240m")
  assert.equal(printTimeout({ CMA_MAX_RUN_MS: "soon" }), "240m")
})

test("a repository turn scopes agy to the checkout and skips the edit review; a chat turn does neither", () => {
  const repo = antigravity.streamingArgs(REPO_JOB, "hi")
  assert.equal(repo[repo.indexOf("--add-dir") + 1], "/repo")
  assert.equal(repo.at(-1), "--mode=accept-edits", "last, so the engine's degraded retry can drop it cleanly")
  // The flag that approves everything — shell included — must never appear.
  assert.ok(!repo.includes("--dangerously-skip-permissions"))

  const chat = antigravity.streamingArgs(CHAT_JOB, "hi")
  assert.ok(!chat.includes("--add-dir"))
  assert.ok(!chat.includes("--mode=accept-edits"))
})

test("a degraded retry drops only the edit review and keeps the prompt, the clock and the scope", () => {
  const args = antigravity.streamingArgs(REPO_JOB, "the prompt")
  const stripped = withoutCapabilityFlags(args)

  assert.ok(!stripped.includes("--mode=accept-edits"))
  assert.deepEqual(stripped.slice(0, 2), ["--prompt", "the prompt"])
  assert.ok(stripped.includes("--print-timeout"))
  assert.equal(stripped[stripped.indexOf("--add-dir") + 1], "/repo")
})

test("the login probe and the catalogue are one zero-token call, root flag before the subcommand", () => {
  // `agy models --output-format json` is rejected (upstream #777); the root
  // flag first is the form the 1.1.13 capture came from. And it spends no
  // model turn, unlike the old "Reply with the single word: ok" probe.
  assert.deepEqual(antigravity.probeArgs(), ["--output-format", "json", "models"])
  assert.equal(typeof antigravity.probe, "function")
  assert.equal(typeof antigravity.listModels, "function")
})

// ---------------------------------------------------------------------------
// The model slug and the effort dial
// ---------------------------------------------------------------------------

test("a tiered slug goes on the wire as picked; a bare family gets agy's own default tier", () => {
  assert.equal(modelFor("gemini-3.7-flash-medium"), "gemini-3.7-flash-medium")
  assert.equal(modelFor("gemini-3.8-flash-low"), "gemini-3.8-flash-low")
  // 1.2.2 refuses a bare family without --effort; the tiered slug is taken
  // by every build, so the default tier is spelled into it.
  assert.equal(modelFor("gemini-3.7-flash"), "gemini-3.7-flash-medium")
  assert.equal(modelFor("gemini-3.1-pro"), "gemini-3.1-pro-high")
  assert.equal(modelFor(""), null)
})

test("the effort dial moves between tiers of the family the user picked, never to another family", () => {
  assert.equal(modelFor("gemini-3.7-flash-medium", "low"), "gemini-3.7-flash-low")
  assert.equal(modelFor("gemini-3.7-flash-low", "high"), "gemini-3.7-flash-high")
  assert.equal(modelFor("gemini-3.8-flash-medium", "xhigh"), "gemini-3.8-flash-high")
  assert.equal(modelFor("gemini-3.8-flash-medium", "max"), "gemini-3.8-flash-high")
  assert.equal(modelFor("gemini-3.1-pro-high", "low"), "gemini-3.1-pro-low")
  // Pro has no medium tier: the dial cannot land there, so what the user
  // picked stands rather than a guessed direction.
  assert.equal(modelFor("gemini-3.1-pro-high", "medium"), "gemini-3.1-pro-high")

  for (const effort of ["low", "medium", "high", "xhigh", "max", "", undefined]) {
    assert.ok(modelFor("gemini-3.7-flash-low", effort).startsWith("gemini-3.7-flash-"), `${effort} stays in Flash`)
    assert.ok(modelFor("gemini-3.1-pro-low", effort).startsWith("gemini-3.1-pro-"), `${effort} stays in Pro`)
  }
})

test("ids with no dial pass through untouched, whatever the effort", () => {
  assert.equal(modelFor("claude-opus-4-6-thinking", "low"), "claude-opus-4-6-thinking")
  assert.equal(modelFor("claude-sonnet-4-6", "max"), "claude-sonnet-4-6")
  assert.equal(modelFor("gpt-oss-120b-medium", "high"), "gpt-oss-120b-medium")
  assert.equal(modelFor("gemini-3-flash", "high"), "gemini-3-flash", "the non-thinking id has no tiers")

  const args = antigravity.streamingArgs({ model: "gemini-3.1-pro-high", effort: "low" }, "hi")
  assert.equal(args[args.indexOf("--model") + 1], "gemini-3.1-pro-low")
})

// ---------------------------------------------------------------------------
// The event stream
// ---------------------------------------------------------------------------

test("a real stream folds to the shared result shape", () => {
  const out = antigravity.collapseEvents(STREAM)

  assert.equal(out.content, "Hello\n", "the result's terminal copy of the answer")
  assert.equal(out.model, "gemini-3.7-flash-medium", "from init, not guessed")
  assert.equal(out.usage.model_label, "gemini-3.7-flash-medium")
  assert.equal(out.stopReason, "success")
  assert.ok(out.sawResult)
  assert.ok(!out.isError)
  assert.equal(out.usage.num_turns, 1)
  assert.equal(out.usage.runtime_session_id, "c3b6")
})

test("the answer is the concatenated text deltas when a build leaves response off the result", () => {
  const out = antigravity.collapseEvents([INIT, TEXT_ACTIVE, TEXT_DONE, result({ response: undefined })])
  assert.equal(out.content, "Hello \n")

  const partial = [TEXT_ACTIVE, TEXT_DONE, TOOL_DONE].map((event) => antigravity.partialTextFrom(event))
  assert.deepEqual(partial, ["Hello ", "\n", null])
})

test("cache_read_tokens is additive to input, exactly as agy reports it (kivio, agy 1.1.26)", () => {
  // in=5969 out=554 cache=8132 total=6523: total = input + output, and the
  // cache count sits OUTSIDE input_tokens — larger than it on a warm prompt.
  const usage = { input_tokens: 5969, output_tokens: 554, cache_read_tokens: 8132, total_tokens: 6523 }
  const out = antigravity.collapseEvents([
    INIT,
    { event: "step_update", step_update: { step_index: 2, state: "DONE", step_type: "agent_response", text_delta: "ok", usage } },
    result({ response: "ok", usage })
  ])

  assert.equal(out.usage.input_tokens, 5969, "nothing subtracted")
  assert.equal(out.usage.cache_read_input_tokens, 8132)
  assert.equal(out.usage.output_tokens, 554)
  assert.equal(out.usage.cache_creation_input_tokens, 0, "cache_write_tokens has never been seen on the wire")
  assert.equal(out.usage.reasoning_tokens, undefined, "not reported means absent, never 0")
  assert.equal(out.usage.context_tokens, 5969 + 8132, "the window held the cached prefix too")
})

test("thinking_tokens is inside output_tokens: carried as reasoning_tokens, never added again", () => {
  const out = antigravity.collapseEvents(STREAM)

  assert.equal(out.usage.output_tokens, 554, "kernelbench: input + output == total with thinking present")
  assert.equal(out.usage.reasoning_tokens, 120)
  assert.equal(out.usage.input_tokens + out.usage.output_tokens, USAGE.total_tokens)
})

test("the context reading is the last agent_response step's own prompt, never a total", () => {
  const first = { event: "step_update", step_update: { step_index: 1, state: "DONE", step_type: "agent_response",
    usage: { input_tokens: 900_000, output_tokens: 40, cache_read_tokens: 0, total_tokens: 900_040 } } }
  const last = { event: "step_update", step_update: { step_index: 4, state: "DONE", step_type: "agent_response",
    usage: { input_tokens: 2_561, output_tokens: 554, cache_read_tokens: 8_174, total_tokens: 3_115 } } }
  const out = antigravity.collapseEvents([INIT, first, last, result({ response: "ok",
    usage: { input_tokens: 902_561, output_tokens: 594, cache_read_tokens: 8_174, total_tokens: 903_155 } })])

  assert.equal(out.usage.context_tokens, 10_735)
  assert.equal(out.usage.input_tokens, 902_561, "the run's spend is still every call summed")
})

test("under --conversation the result is cumulative, so the run's spend is its steps summed (DwarfAI, 1.1.26)", () => {
  // Turn two of a resumed conversation: the step reported 4,739 tokens, the
  // result 21,524 — the previous turn's 16,785 included.
  const step = { input_tokens: 3_500, output_tokens: 1_239, cache_read_tokens: 0, total_tokens: 4_739 }
  const cumulative = { input_tokens: 16_000, output_tokens: 5_524, cache_read_tokens: 0, total_tokens: 21_524 }
  const out = antigravity.collapseEvents([
    INIT,
    { event: "step_update", step_update: { step_index: 6, state: "DONE", step_type: "agent_response", text_delta: "ok", usage: step } },
    result({ response: "ok", num_turns: 2, usage: cumulative })
  ])

  assert.equal(out.usage.input_tokens, 3_500)
  assert.equal(out.usage.output_tokens, 1_239)
  assert.equal(out.usage.context_tokens, 3_500)
  assert.equal(out.usage.num_turns, 2)
})

test("a fresh conversation whose steps carry no usage falls back to the result's figure", () => {
  const out = antigravity.collapseEvents([
    INIT,
    { event: "step_update", step_update: { step_index: 2, state: "DONE", step_type: "agent_response", text_delta: "ok" } },
    result({ response: "ok", usage: { input_tokens: 100, output_tokens: 20, cache_read_tokens: 30, total_tokens: 120 } })
  ])

  assert.equal(out.usage.input_tokens, 100)
  assert.equal(out.usage.cache_read_input_tokens, 30)
  assert.equal(out.usage.context_tokens, 0, "no per-call figure means no reading, not a total")
})

test("the window is reported for the Gemini line only", () => {
  assert.equal(contextWindowFor("gemini-3.7-flash-medium"), 1_048_576)
  assert.equal(contextWindowFor("gemini-3.1-pro-high"), 1_048_576)
  assert.equal(contextWindowFor("claude-sonnet-4-6"), null, "no verified figure under Antigravity")
  assert.equal(contextWindowFor("gpt-oss-120b-medium"), null)

  assert.equal(antigravity.collapseEvents(STREAM).usage.context_window, 1_048_576)
  const claude = { ...INIT, init: { ...INIT.init, model: "claude-sonnet-4-6" } }
  assert.equal(antigravity.collapseEvents([claude, RESULT]).usage.context_window, undefined)
  assert.equal(antigravity.collapseEvents([]).usage.context_window, undefined)
})

// ---------------------------------------------------------------------------
// Result semantics: status describes the conversation, not the turn
// ---------------------------------------------------------------------------

test("ERROR beside a complete answer is the answer with a note (shipit, 1.2.2: a retried 503)", () => {
  const out = antigravity.collapseEvents([INIT, result({ status: "ERROR", response: "Done.", error: "503 upstream, retried" })])

  assert.equal(out.content, "Done.")
  assert.equal(out.isError, false)
  assert.match(out.errorStatus, /503/)
})

test("ERROR with nothing said is a failure, whatever the exit code", () => {
  const out = antigravity.collapseEvents([INIT, result({ status: "ERROR", error: "RESOURCE_EXHAUSTED: quota reached" })])

  assert.equal(out.isError, true)
  assert.match(out.errorStatus, /quota/)
  assert.match(antigravity.classifyFailure(out.errorStatus).message, /rate limited|out of included usage/)
})

test("agy's own turn clock expiring is named as such, with the value that was sent", () => {
  // Pre-1.1.28 shape: exit 1, empty response, this exact error string.
  const out = antigravity.collapseEvents([INIT, result({ status: "ERROR", error: "timeout waiting for response" })])
  assert.equal(out.isError, true)
  assert.match(out.errorStatus, /turn clock.*--print-timeout \d+m/)

  const explicit = antigravity.collapseEvents([INIT, result({ status: "TIMEOUT" })])
  assert.equal(explicit.isError, true)
  assert.match(explicit.errorStatus, /turn clock/)
})

test("SUCCESS, nothing said, and a denied write is the permission failure it is, with the rule that fixes it", () => {
  // --mode=accept-edits skips the review; the permission check still applies
  // and a headless run has nobody to approve (yuting0624 A/B on 1.1.9–1.2.0).
  const out = antigravity.collapseEvents([INIT, result({
    denied_actions: [{ display_name: "Write file", action: "write_file" }]
  })])

  assert.equal(out.isError, true)
  assert.match(out.errorStatus, /write_file/)
  assert.match(out.errorStatus, /permissions\.allow/)
  assert.match(out.errorStatus, /write_file\(<the shared folder>\)/)
})

test("an error_message step explains a run that ended without a result", () => {
  const out = antigravity.collapseEvents([
    INIT,
    { event: "step_update", step_update: { step_index: 1, state: "ERROR", step_type: "error_message", text_delta: "Please sign in to use Antigravity" } }
  ])

  assert.equal(out.isError, true)
  assert.equal(out.sawResult, false)
  assert.match(antigravity.classifyFailure(out.errorStatus).message, /signing in again/)
})

test("an empty stream is the shared empty shape, with a numeric context reading", () => {
  const out = antigravity.collapseEvents([])
  assert.equal(out.content, "")
  assert.equal(out.usage.context_tokens, 0)
  assert.equal(out.usage.runtime_session_id, undefined)
  assert.equal(out.sawResult, false)
})

// ---------------------------------------------------------------------------
// The ticker and the written files
// ---------------------------------------------------------------------------

test("tool steps read as ticker lines, with Antigravity's PascalCase parameters", () => {
  assert.equal(antigravity.describeEvent(INIT), "Starting up")
  assert.equal(antigravity.describeEvent(TOOL_ACTIVE), "Reading repo/a.txt")
  assert.equal(antigravity.describeEvent({ event: "step_update", step_update: {
    step_type: "tool", tool_name: "write_to_file", tool_info: { parameters: { TargetFile: "/repo/app/models/user.rb" } } } }),
    "Writing models/user.rb")
  assert.equal(antigravity.describeEvent({ event: "step_update", step_update: {
    step_type: "tool", tool_name: "run_command", tool_info: { parameters: { CommandLine: "npm test" } } } }),
    "Running npm test")
  assert.equal(antigravity.describeEvent({ event: "step_update", step_update: {
    step_type: "tool", tool_name: "grep_search", tool_info: { parameters: { Query: "TODO" } } } }),
    "Searching for TODO")
  assert.equal(antigravity.describeEvent({ event: "step_update", step_update: { step_type: "subagent" } }),
    "Delegating to a sub-agent")
  // Text is the partial channel, not a ticker line; the rest is nothing a
  // person is waiting on.
  assert.equal(antigravity.describeEvent(TEXT_ACTIVE), null)
  assert.equal(antigravity.describeEvent({ event: "step_update", step_update: { step_type: "checkpoint" } }), null)
  assert.equal(antigravity.describeEvent({ type: "init" }), null, "the invented shape reads as nothing")
})

test("only a DONE write step counts as a written file", () => {
  const write = (state) => ({ event: "step_update", step_update: {
    step_index: 5, state, step_type: "tool", tool_name: "write_to_file",
    tool_info: { parameters: { TargetFile: "/repo/docs/plan.md" } } } })

  assert.equal(antigravity.writtenPathFrom(write("DONE")), "/repo/docs/plan.md")
  assert.equal(antigravity.writtenPathFrom(write("ACTIVE")), null, "intent is not a write")
  assert.equal(antigravity.writtenPathFrom(write("ERROR")), null, "a denial is not a write")
  assert.equal(antigravity.writtenPathFrom(TOOL_DONE), null)
})

// ---------------------------------------------------------------------------
// Conversation continuity
// ---------------------------------------------------------------------------

test("a resumable id continues the conversation with only the new turns, bare", () => {
  const job = { ...CHAT_JOB, runtime_session_id: "c3b6-7f2a", messages: [
    { role: "user", content: "first" }, { role: "assistant", content: "reply" }, { role: "user", content: "/next question" }
  ] }

  assert.equal(resumeIdOf(job), "c3b6-7f2a")
  const args = antigravity.streamingArgs(job, antigravity.renderPrompt(job, "User: first\n\nAssistant: reply\n\nUser: /next question\n\nAssistant:"))
  assert.equal(args[args.indexOf("--conversation") + 1], "c3b6-7f2a")
  assert.equal(args[1], "/next question", "agy holds the rest of the transcript")
  assert.ok(!args[1].includes("<system>"), "the system text was part of the first turn")
  // A prompt starting with `/` would otherwise be expanded as a slash command.
  assert.ok(args.includes("--disable-slash-commands"))
})

test("without something to resume with, the turn runs fresh and the id is not sent", () => {
  const rendered = "User: hello\n\nAssistant:"
  const noAssistant = { ...CHAT_JOB, runtime_session_id: "c3b6", messages: [{ role: "user", content: "hello" }] }
  assert.equal(resumeIdOf(noAssistant), null)
  assert.ok(!antigravity.streamingArgs(noAssistant, "x").includes("--conversation"))
  assert.match(antigravity.renderPrompt(noAssistant, rendered), /<system>\noperator instructions\n<\/system>\n\nUser: hello/)

  const nothingNew = { ...CHAT_JOB, runtime_session_id: "c3b6", messages: [
    { role: "user", content: "hello" }, { role: "assistant", content: "reply" }
  ] }
  assert.equal(resumeIdOf(nothingNew), null)

  const unsafe = { ...noAssistant, runtime_session_id: "c3b6 --dangerously-skip-permissions",
    messages: [{ role: "user", content: "a" }, { role: "assistant", content: "b" }, { role: "user", content: "c" }] }
  assert.equal(resumeIdOf(unsafe), null, "an id goes on argv: only a plain token is accepted")
  assert.equal(resumeIdOf(CHAT_JOB), null, "an older server never sends the key")
})

// ---------------------------------------------------------------------------
// The probe and the catalogue
// ---------------------------------------------------------------------------

// `agy --output-format json models` on 1.1.13 (herdr-board capture).
const MODELS_ENVELOPE = JSON.stringify({
  status: "SUCCESS",
  response: "gemini-3.7-flash-high\tGemini 3.7 Flash (High)\ngemini-3.1-pro-high\tGemini 3.1 Pro (High)\n",
  command: { name: "models", data: { models: [
    { id: "gemini-3.7-flash-high", label: "Gemini 3.7 Flash (High)" },
    { id: "gemini-3.7-flash-medium", label: "Gemini 3.7 Flash (Medium)" },
    { id: "gemini-3.1-pro-high", label: "Gemini 3.1 Pro (High)" },
    { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6 (Thinking)" },
    { id: "gpt-oss-120b-medium", label: "GPT-OSS 120B (Medium)" }
  ] } }
})

test("the models envelope is the catalogue, and a signed-in answer is a ready login", () => {
  assert.deepEqual(modelsFrom(MODELS_ENVELOPE), [
    "claude-sonnet-4-6", "gemini-3.1-pro-high", "gemini-3.7-flash-high", "gemini-3.7-flash-medium", "gpt-oss-120b-medium"
  ])
  assert.deepEqual(probeOutcome({ code: 0, stdout: MODELS_ENVELOPE, stderr: "" }), { status: "ready" })
})

test("the envelope is the last parseable line, after any status line an older build printed", () => {
  const stdout = `Loading models...\n${MODELS_ENVELOPE}\n`
  assert.equal(envelopeFrom(stdout).status, "SUCCESS")
  assert.equal(modelsFrom(stdout).length, 5)
})

test("plain `agy models` rows still parse, so a build without the JSON envelope lists something", () => {
  const stdout = "Available models:\ngemini-3.8-flash-low\tGemini 3.8 Flash (Low)\ngemini-3.8-flash-high\tGemini 3.8 Flash (High)\n"
  assert.deepEqual(modelsFrom(stdout), ["gemini-3.8-flash-high", "gemini-3.8-flash-low"])
  assert.deepEqual(modelsFrom(""), [])
})

test("a signed-out agy is logged_out even when it exits 0 (1.1.0 printed a plain sentence)", () => {
  assert.deepEqual(
    probeOutcome({ code: 0, stdout: "Please sign in to use Antigravity CLI. Run `agy` to sign in.\n", stderr: "" }),
    { status: "logged_out" }
  )
  assert.deepEqual(
    probeOutcome({ code: 1, stdout: JSON.stringify({ status: "ERROR", error: "not signed in: run agy to sign in" }), stderr: "" }),
    { status: "logged_out" }
  )
  assert.deepEqual(
    probeOutcome({ code: 1, stdout: "", stderr: "error: authentication expired, please sign in again\n" }),
    { status: "logged_out" }
  )
})

test("a build too old for the probe says so instead of reading as a broken login", () => {
  const out = probeOutcome({ code: 2, stdout: "", stderr: "flags provided but not defined: -output-format\n" })
  assert.equal(out.status, "unknown")
  assert.match(out.detail, /upgrade/i)

  const other = probeOutcome({ code: 3, stdout: "", stderr: "dial tcp: connection refused" })
  assert.equal(other.status, "unknown")
  assert.match(other.detail, /connection refused/)
})

// ---------------------------------------------------------------------------
// Failures in agy's own words, and what the adapter admits it cannot do
// ---------------------------------------------------------------------------

test("agy's quota and sign-in wording classify like every other runtime's", () => {
  assert.match(antigravity.classifyFailure("RESOURCE_EXHAUSTED").message, /rate limited/)
  assert.match(antigravity.classifyFailure("HTTP 429 from backend").message, /rate limited/)
  assert.match(antigravity.classifyFailure("Out of credits for this window").message, /rate limited/)
  assert.match(antigravity.classifyFailure("Please sign in").message, /run `agy` once/)
  assert.match(antigravity.classifyFailure("something else").message, /something else/)
})

test("the write posture is stated, not hidden", () => {
  assert.ok(antigravity.limitations.some((line) => /permissions\.allow/.test(line) && /write_file/.test(line)))
  assert.ok(antigravity.limitations.some((line) => /git/i.test(line)))
  assert.equal(antigravity.reportsModels, false, "the seed is the picker until the server prefers a reported list")
  assert.deepEqual(antigravity.extraHomePaths, [], "the installer writes ~/.local/bin/agy, which HOME_BIN_DIRS sweeps")
})
