import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import {
  collectDocuments, MAX_FILES, MAX_FILE_BYTES, MAX_BINARY_FILE_BYTES
} from "../src/documents.js"

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

// ── Binary documents ───────────────────────────────────────────────────
//
// A Word document, a deck, a PDF: bytes, carried base64 with an `encoding`
// marker so the server knows to put them in object storage rather than a
// text column. An older server that ignores the marker drops or garbles the
// entry — never the run.

const PDF_BYTES = Buffer.from("%PDF-1.4\n%âãÏÓ fake body\n", "latin1")

test("a binary document comes back base64, marked as such", () => {
  const ws = workspace()
  try {
    writeFileSync(join(ws.root, "invoice.pdf"), PDF_BYTES)

    const files = collectDocuments(ws.root, ["invoice.pdf"])

    assert.equal(files.length, 1)
    assert.equal(files[0].path, "invoice.pdf")
    assert.equal(files[0].encoding, "base64")
    assert.equal(files[0].bytes, PDF_BYTES.length)
    assert.deepEqual(Buffer.from(files[0].content, "base64"), PDF_BYTES)
  } finally { ws.cleanup() }
})

test("a text document carries no encoding marker, exactly as before", () => {
  const ws = workspace()
  try {
    ws.write("summary.md", "# hi\n")

    const files = collectDocuments(ws.root, ["summary.md"])

    assert.equal(files.length, 1)
    assert.ok(!("encoding" in files[0]))
  } finally { ws.cleanup() }
})

test("binary gets the binary ceiling, not the text one", () => {
  const ws = workspace()
  try {
    // Bigger than a text file may be, smaller than a binary one may be.
    writeFileSync(join(ws.root, "deck.pptx"), Buffer.alloc(MAX_FILE_BYTES + 10, 1))
    writeFileSync(join(ws.root, "toobig.pptx"), Buffer.alloc(MAX_BINARY_FILE_BYTES + 1, 1))

    const files = collectDocuments(ws.root, ["deck.pptx", "toobig.pptx"])

    assert.deepEqual(files.map((f) => f.path), ["deck.pptx"])
  } finally { ws.cleanup() }
})

// ── Discovery ──────────────────────────────────────────────────────────
//
// Office/PDF files are made by scripts, so no Write call ever names them.
// Files of exactly those formats modified during the run are picked up off
// the workdir; anything older than the run is somebody else's file.

test("a script-made document is discovered by its mtime, without being named", () => {
  const ws = workspace()
  try {
    writeFileSync(join(ws.root, "out", "..", "report.docx"), Buffer.from("PK fake docx"))

    const files = collectDocuments(ws.root, [], { since: Date.now() - 60_000 })

    assert.deepEqual(files.map((f) => f.path), ["report.docx"])
    assert.equal(files[0].encoding, "base64")
  } finally { ws.cleanup() }
})

test("a document from before the run is not this run's deliverable", () => {
  const ws = workspace()
  try {
    writeFileSync(join(ws.root, "old.pdf"), PDF_BYTES)

    const files = collectDocuments(ws.root, [], { since: Date.now() + 60_000 })

    assert.deepEqual(files, [])
  } finally { ws.cleanup() }
})

test("discovery never reaches into dot-directories or node_modules", () => {
  const ws = workspace()
  try {
    ws.write(".git/objects/x.txt", "x\n") // creates the dirs
    writeFileSync(join(ws.root, ".git", "objects", "sneaky.pdf"), PDF_BYTES)
    ws.write("node_modules/pkg/x.txt", "x\n")
    writeFileSync(join(ws.root, "node_modules", "pkg", "vendored.pdf"), PDF_BYTES)

    assert.deepEqual(collectDocuments(ws.root, [], { since: Date.now() - 60_000 }), [])
  } finally { ws.cleanup() }
})

test("an explicitly written path is not duplicated by discovery", () => {
  const ws = workspace()
  try {
    writeFileSync(join(ws.root, "invoice.pdf"), PDF_BYTES)

    const files = collectDocuments(ws.root, ["invoice.pdf"], { since: Date.now() - 60_000 })

    assert.equal(files.length, 1)
  } finally { ws.cleanup() }
})
