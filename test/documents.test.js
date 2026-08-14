import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { collectDocuments, MAX_FILES, MAX_FILE_BYTES } from "../src/documents.js"

// Bringing a run's documents back off the machine it ran on.
//
// The interesting half is what this REFUSES. It reads arbitrary paths named by
// a model's tool calls and posts their contents to a server, so "only inside
// the working directory" and "only text formats we asked for" are not tidiness
// — they are the whole of its safety.

function workspace() {
  const root = mkdtempSync(join(tmpdir(), "cma-docs-"))
  return {
    root,
    write(name, content) {
      const full = join(root, name)
      mkdirSync(join(full, ".."), { recursive: true })
      writeFileSync(full, content)
      return full
    },
    cleanup() { rmSync(root, { recursive: true, force: true }) }
  }
}

test("a document the run wrote comes back, with a relative path", () => {
  const ws = workspace()
  try {
    ws.write("invoice-9D-2608.html", "<h1>Invoice</h1>\n")

    const files = collectDocuments(ws.root, [join(ws.root, "invoice-9D-2608.html")])

    assert.equal(files.length, 1)
    assert.equal(files[0].path, "invoice-9D-2608.html")
    assert.equal(files[0].content, "<h1>Invoice</h1>\n")
    assert.equal(files[0].bytes, 17)
  } finally { ws.cleanup() }
})

test("a nested path keeps its shape, with forward slashes", () => {
  const ws = workspace()
  try {
    ws.write("reports/q3/summary.md", "# Q3\n")

    const files = collectDocuments(ws.root, [join(ws.root, "reports", "q3", "summary.md")])

    assert.deepEqual(files.map((f) => f.path), ["reports/q3/summary.md"])
  } finally { ws.cleanup() }
})

test("a relative path is resolved against the working directory", () => {
  const ws = workspace()
  try {
    ws.write("notes.md", "hello\n")

    assert.equal(collectDocuments(ws.root, ["notes.md"]).length, 1)
  } finally { ws.cleanup() }
})

test("nothing outside the working directory is read, however it is spelled", () => {
  const ws = workspace()
  const outside = mkdtempSync(join(tmpdir(), "cma-outside-"))
  try {
    writeFileSync(join(outside, "secret.md"), "not yours\n")

    const escapes = [
      join(outside, "secret.md"),
      join(ws.root, "..", "..", "etc", "hosts"),
      "../../../secret.md",
      `${ws.root}-sibling/secret.md`
    ]

    assert.deepEqual(collectDocuments(ws.root, escapes), [])
  } finally {
    ws.cleanup()
    rmSync(outside, { recursive: true, force: true })
  }
})

test("source files are repository work, not documents", () => {
  const ws = workspace()
  try {
    ;["app/models/user.rb", "src/main.ts", "config/routes.rb", "package.json",
      "styles.css", "Gemfile", "notes"].forEach((name) => ws.write(name, "x\n"))

    const written = ["app/models/user.rb", "src/main.ts", "config/routes.rb",
                     "package.json", "styles.css", "Gemfile", "notes"]

    assert.deepEqual(collectDocuments(ws.root, written), [])
  } finally { ws.cleanup() }
})

test("a file the run wrote and then removed is not an omission", () => {
  const ws = workspace()
  try {
    assert.deepEqual(collectDocuments(ws.root, ["gone.html"]), [])
  } finally { ws.cleanup() }
})

test("the same path written three times comes back once", () => {
  const ws = workspace()
  try {
    ws.write("estimate.html", "<p>final</p>\n")

    const files = collectDocuments(ws.root, [
      "estimate.html", join(ws.root, "estimate.html"), "./estimate.html"
    ])

    assert.equal(files.length, 1)
    assert.equal(files[0].content, "<p>final</p>\n")
  } finally { ws.cleanup() }
})

test("an empty file carries nothing and is skipped", () => {
  const ws = workspace()
  try {
    ws.write("blank.md", "")

    assert.deepEqual(collectDocuments(ws.root, ["blank.md"]), [])
  } finally { ws.cleanup() }
})

test("a file past the per-file ceiling is left on the machine", () => {
  const ws = workspace()
  try {
    ws.write("huge.csv", "x".repeat(MAX_FILE_BYTES + 1))
    ws.write("small.csv", "a,b\n1,2\n")

    assert.deepEqual(collectDocuments(ws.root, ["huge.csv", "small.csv"]).map((f) => f.path),
                     ["small.csv"])
  } finally { ws.cleanup() }
})

test("the file count is capped, and the cap is honoured in order", () => {
  const ws = workspace()
  try {
    const written = []
    for (let i = 0; i < MAX_FILES + 5; i++) {
      ws.write(`doc-${i}.md`, `# ${i}\n`)
      written.push(`doc-${i}.md`)
    }

    const files = collectDocuments(ws.root, written)

    assert.equal(files.length, MAX_FILES)
    assert.equal(files[0].path, "doc-0.md")
  } finally { ws.cleanup() }
})

test("a file whose extension lies about being text is skipped", () => {
  const ws = workspace()
  try {
    // A PNG somebody named .html. The artifact body is a text column; putting
    // this in one would store mojibake.
    ws.write("chart.html", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d, 0x0a, 0x1a]))

    assert.deepEqual(collectDocuments(ws.root, ["chart.html"]), [])
  } finally { ws.cleanup() }
})

test("no working directory and no paths means nothing to do", () => {
  assert.deepEqual(collectDocuments(null, ["a.md"]), [])
  assert.deepEqual(collectDocuments("/tmp", []), [])
  assert.deepEqual(collectDocuments("/tmp", null), [])
})
