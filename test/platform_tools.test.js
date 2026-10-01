import test from "node:test"
import assert from "node:assert/strict"

import { BUILTIN_PLATFORM_TOOLS, BUILTIN_WEB_TOOLS, builtinPlatformTools } from "../src/runtimes/shared.js"
import { FORBIDDEN_TOOLS, baseArgs } from "../src/runtimes/claude-code.js"

// Configure My AI owns scheduling, delegation, memory and the operator's
// questions on every provider. A CLI that also ships those as built-ins has
// them taken off the surface, so a bot turn cannot reach for a cron that dies
// with the session instead of schedule_task.

test("Claude Code's own scheduling, sub-agent, workflow and prompt tools are disallowed on every job", () => {
  for (const job of [{ system: "bot" }, { system: "code", workdir: "/tmp/repo" }]) {
    const args = baseArgs(job)
    const at = args.indexOf("--disallowedTools")
    assert.ok(at >= 0, "the deny flag is passed")
    const denied = args.slice(at + 1)
    for (const tool of ["CronCreate", "CronDelete", "CronList", "ScheduleWakeup", "Agent", "Workflow",
                        "EnterWorktree", "AskUserQuestion", "WebFetch", "WebSearch"]) {
      assert.ok(denied.includes(tool), `${tool} must be denied`)
    }
  }
})

test("the platform list is exactly what FORBIDDEN_TOOLS carries beyond git and web", () => {
  const git = FORBIDDEN_TOOLS.filter((entry) => entry.startsWith("Bash("))
  const rest = FORBIDDEN_TOOLS.filter((entry) => !entry.startsWith("Bash("))
  assert.ok(git.length > 0)
  assert.deepEqual(rest, [...BUILTIN_WEB_TOOLS.claude_code, ...BUILTIN_PLATFORM_TOOLS.claude_code])
})

test("every runtime has an entry, and an unknown runtime denies nothing", () => {
  for (const runtime of Object.keys(BUILTIN_WEB_TOOLS)) {
    assert.ok(Array.isArray(BUILTIN_PLATFORM_TOOLS[runtime]), `${runtime} needs a platform entry`)
  }
  assert.deepEqual(builtinPlatformTools("nope"), [])
  assert.deepEqual(builtinPlatformTools("gemini_cli"), ["save_memory"])
})
