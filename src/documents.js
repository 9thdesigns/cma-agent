import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { extname, join, relative, resolve, sep } from "node:path"

// The documents a run produced, brought back with it.
//
// A turn on a paired machine happens entirely on that machine: the CLI writes
// files to disk there, and the only thing that ever reached the web app was a
// line of text saying it had. So a session asked for three invoices, wrote
// three invoices, and the person who asked got "Wrote invoice-9D-2608.html" as
// a sentence — nothing in the Files tab, nothing to click, nothing to
// download. The files existed on a laptop and nowhere else.
//
// This closes that. The runtime adapters already parse every tool call to
// build the "Writing foo.html" ticker, so we know exactly which paths a run
// wrote — no scanning a directory, no guessing from timestamps, no picking up
// files somebody else's process touched.
//
// Deliberately narrow. This is not a sync of the working directory:
//
//   * only paths the run itself wrote, and only ones still on disk;
//   * only inside the working directory the server asked for — a path that
//     escapes it is dropped, not clamped;
//   * only DOCUMENT formats. A run that edits forty source files is doing
//     repository work, and that work goes back as a branch and a pull request,
//     which is a job this is not trying to do. An invoice has nowhere else to
//     go, which is why it is the thing worth carrying.
//   * bounded in every direction, because this rides on the completion POST
//     and a completion that fails to deliver because it grew a payload is
//     worse than one that brings back nothing.

// Extensions worth carrying, in the two shapes the server stores.
//
// Text formats travel as UTF-8 and land in a text column. Binary DOCUMENT
// formats — a Word document, a deck, a PDF, a spreadsheet, an image — travel
// base64 with `encoding: "base64"` on the entry, and the server puts them in
// object storage (Code::SessionObject's blob). An older server that predates
// the key drops an entry whose base64 exceeds its text ceiling and stores
// smaller ones as unreadable text — carrying nothing it can't store, which
// is the same place it was before binary existed.
export const DOCUMENT_EXTENSIONS = new Set([
  ".html", ".htm", ".md", ".markdown", ".txt", ".csv", ".tsv", ".svg"
])

export const BINARY_DOCUMENT_EXTENSIONS = new Set([
  ".pdf", ".docx", ".xlsx", ".pptx",
  ".png", ".jpg", ".jpeg", ".gif", ".webp"
])

export const MAX_FILES = 20
export const MAX_FILE_BYTES = 512 * 1024
// Binary gets more room per file — a deck with images is megabytes — but the
// same total ceiling discipline: this rides on the completion POST, and a
// completion that fails to deliver because it grew a payload is worse than
// one that brings back nothing.
export const MAX_BINARY_FILE_BYTES = 3 * 1024 * 1024
export const MAX_TOTAL_BYTES = 8 * 1024 * 1024

// Anything with a NUL byte in the first few kilobytes is not the text file its
// extension claims to be. Cheaper and more honest than trusting the name.
function looksBinary(buffer) {
  return buffer.subarray(0, 8192).includes(0)
}

// A path we are willing to read, as an absolute path — or null.
//
// `resolve` collapses `..` before the comparison, so a written path of
// `../../../.ssh/config` fails the prefix test rather than being read. The
// trailing separator matters: without it `/work` would accept `/workspace`.
function insideWorkdir(workdir, candidate) {
  const root = resolve(workdir)
  const full = resolve(root, candidate)
  if (full !== root && !full.startsWith(root + sep)) return null
  return full
}

// Office/PDF documents are made by SCRIPTS — python-docx over Bash, a
// LibreOffice convert — so the tool-call tracking that catches every Write
// never sees them. For exactly these four unambiguous deliverable formats,
// the workdir is searched for files modified during the run. Narrower than it
// sounds: extension AND mtime inside the run's window AND inside the workdir,
// bounded in depth and in entries visited, dot-directories and node_modules
// skipped. Images stay tracking-only — a build touching a thousand PNGs must
// not become a thousand "documents".
export const DISCOVER_EXTENSIONS = new Set([".pdf", ".docx", ".xlsx", ".pptx"])
export const MAX_DISCOVER_DEPTH = 4
export const MAX_DISCOVER_ENTRIES = 4000
// Clock slack: the file may be stamped a beat before we recorded "started".
const DISCOVER_SLACK_MS = 2000

function discoverDocuments(workdir, since) {
  if (!Number.isFinite(since)) return []

  const found = []
  let visited = 0
  const walk = (dir, depth) => {
    if (depth > MAX_DISCOVER_DEPTH || visited >= MAX_DISCOVER_ENTRIES) return

    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (visited++ >= MAX_DISCOVER_ENTRIES) return
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue

      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full, depth + 1)
      } else if (entry.isFile() && DISCOVER_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
        try {
          if (statSync(full).mtimeMs >= since - DISCOVER_SLACK_MS) found.push(full)
        } catch { /* vanished mid-walk — not a document any more */ }
      }
    }
  }
  walk(resolve(workdir), 0)
  return found
}

/**
 * @param {string} workdir  the directory the run was given
 * @param {Iterable<string>} paths  every path the run reported writing
 * @param {{since?: number}} [options]  when the run started (ms since epoch),
 *   enabling discovery of script-made office/PDF documents by mtime
 * @returns {Array<{path: string, bytes: number, content: string, encoding?: string}>}
 */
export function collectDocuments(workdir, paths, { since } = {}) {
  if (!workdir || !paths) return []

  const candidates = [...paths, ...discoverDocuments(workdir, since)]
  const seen = new Set()
  const files = []
  let total = 0

  for (const candidate of candidates) {
    if (files.length >= MAX_FILES) break
    if (!candidate) continue

    const full = insideWorkdir(workdir, candidate)
    if (!full || seen.has(full)) continue
    seen.add(full)

    const ext = extname(full).toLowerCase()
    const binary = BINARY_DOCUMENT_EXTENSIONS.has(ext)
    if (!binary && !DOCUMENT_EXTENSIONS.has(ext)) continue

    try {
      // A file the run wrote and then deleted or moved is not an omission —
      // the run decided it was not the deliverable.
      if (!existsSync(full)) continue

      const stat = statSync(full)
      const ceiling = binary ? MAX_BINARY_FILE_BYTES : MAX_FILE_BYTES
      if (!stat.isFile() || stat.size === 0 || stat.size > ceiling) continue
      if (total + stat.size > MAX_TOTAL_BYTES) continue

      const buffer = readFileSync(full)
      // A text extension over binary bytes is not the file its name claims
      // to be; a binary format needs no such test — it is allowed to be
      // exactly what it is.
      if (!binary && looksBinary(buffer)) continue

      total += stat.size
      const entry = {
        // Relative, and with forward slashes on every platform — this becomes
        // a file path in a web app, not a path on this machine.
        path: relative(resolve(workdir), full).split(sep).join("/"),
        bytes: stat.size,
        content: binary ? buffer.toString("base64") : buffer.toString("utf8")
      }
      if (binary) entry.encoding = "base64"
      files.push(entry)
    } catch {
      // Unreadable, vanished mid-read, a permission we do not have. One file
      // failing is not a reason to lose the others, and none of it is a reason
      // to fail the run — the answer is already written.
      continue
    }
  }

  return files
}
