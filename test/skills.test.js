// Agent Skills written into a managed checkout: idempotent, cleaned up when
// a skill goes away, and always excluded from `git add -A` so a session's
// pull request never carries them.
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"

import { writeSkills } from "../src/repos.js"

const SKILL = (slug, text) => ({ slug, skill_md: `---\nname: "${slug}"\ndescription: "d"\n---\n\n${text}` })

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cma-skills-"))
}

test("skills land under all three discovery roots with a manifest", async () => {
  const dir = tmpdir()
  try {
    await writeSkills(dir, [SKILL("prove-it-works", "Verify before reporting.")])

    for (const root of [".agents/skills", ".claude/skills", ".gemini/skills"]) {
      const file = path.join(dir, root, "prove-it-works", "SKILL.md")
      assert.ok(fs.existsSync(file), `${root} must hold the skill`)
      assert.match(fs.readFileSync(file, "utf8"), /Verify before reporting/)
    }
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, ".agents/.cma-skills.json"), "utf8"))
    assert.deepEqual(manifest.slugs, ["prove-it-works"])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("a skill uninstalled on the server is removed on the next write", async () => {
  const dir = tmpdir()
  try {
    await writeSkills(dir, [SKILL("keep-me", "a"), SKILL("drop-me", "b")])
    await writeSkills(dir, [SKILL("keep-me", "a")])

    assert.ok(fs.existsSync(path.join(dir, ".agents/skills/keep-me/SKILL.md")))
    assert.ok(!fs.existsSync(path.join(dir, ".agents/skills/drop-me")), "stale skill must go")
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, ".agents/.cma-skills.json"), "utf8"))
    assert.deepEqual(manifest.slugs, ["keep-me"])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("hostile slugs and empty bundles are refused without side effects", async () => {
  const dir = tmpdir()
  try {
    await writeSkills(dir, [SKILL("../../evil", "x"), { slug: "no-body" }, "junk"])
    assert.ok(!fs.existsSync(path.join(dir, ".agents")), "nothing valid, nothing written")

    await writeSkills(dir, [])
    assert.ok(!fs.existsSync(path.join(dir, ".agents")), "an empty bundle writes nothing")
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("a slug the repository tracks is never clobbered or deleted", async () => {
  const dir = tmpdir()
  try {
    execFileSync("git", ["init", "--quiet", dir])
    const theirs = path.join(dir, ".claude/skills/prove-it-works")
    fs.mkdirSync(theirs, { recursive: true })
    fs.writeFileSync(path.join(theirs, "SKILL.md"), "the project's own skill")
    execFileSync("git", ["-C", dir, "add", "-A"])
    execFileSync("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t",
                         "commit", "--quiet", "-m", "own skill"])

    await writeSkills(dir, [SKILL("prove-it-works", "ours"), SKILL("safe-slug", "ok")])

    assert.equal(fs.readFileSync(path.join(theirs, "SKILL.md"), "utf8"),
                 "the project's own skill", "tracked files are the project's, not ours")
    assert.ok(fs.existsSync(path.join(dir, ".agents/skills/safe-slug/SKILL.md")),
              "non-colliding skills still land")
    const status = execFileSync("git", ["-C", dir, "status", "--porcelain"], { encoding: "utf8" })
    assert.equal(status.trim(), "", "nothing of ours is stageable")
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("every written path is excluded from git, per exact slug", async () => {
  const dir = tmpdir()
  try {
    execFileSync("git", ["init", "--quiet", dir])
    await writeSkills(dir, [SKILL("prove-it-works", "x")])

    const exclude = fs.readFileSync(path.join(dir, ".git/info/exclude"), "utf8")
    assert.match(exclude, /^\/\.agents\/skills\/prove-it-works\/$/m)
    assert.match(exclude, /^\/\.claude\/skills\/prove-it-works\/$/m)
    assert.match(exclude, /^\/\.agents\/\.cma-skills\.json$/m)

    const status = execFileSync("git", ["-C", dir, "status", "--porcelain"], { encoding: "utf8" })
    assert.equal(status.trim(), "", "git add -A must have nothing of ours to sweep")

    // Idempotent: a second write appends no duplicate lines.
    await writeSkills(dir, [SKILL("prove-it-works", "x")])
    const again = fs.readFileSync(path.join(dir, ".git/info/exclude"), "utf8")
    assert.equal(again, exclude)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
