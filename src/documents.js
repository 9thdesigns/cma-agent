import { existsSync, readFileSync, statSync } from "node:fs"
import { extname, relative, resolve, sep } from "node:path"

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

// Extensions worth carrying. Text only: the server stores these as artifact
// bodies, which are text columns — a PNG cannot go in one, and pretending
// otherwise would put mojibake in a database.
export const DOCUMENT_EXTENSIONS = new Set([
  ".html", ".htm", ".md", ".markdown", ".txt", ".csv", ".tsv", ".svg"
])

export const MAX_FILES = 20
export const MAX_FILE_BYTES = 512 * 1024
export const MAX_TOTAL_BYTES = 2 * 1024 * 1024

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

/**
 * @param {string} workdir  the directory the run was given
 * @param {Iterable<string>} paths  every path the run reported writing
 * @returns {Array<{path: string, bytes: number, content: string}>}
 */
export function collectDocuments(workdir, paths) {
  if (!workdir || !paths) return []

  const seen = new Set()
  const files = []
  let total = 0

  for (const candidate of paths) {
    if (files.length >= MAX_FILES) break
    if (!candidate) continue

    const full = insideWorkdir(workdir, candidate)
    if (!full || seen.has(full)) continue
    seen.add(full)

    if (!DOCUMENT_EXTENSIONS.has(extname(full).toLowerCase())) continue

    try {
      // A file the run wrote and then deleted or moved is not an omission —
      // the run decided it was not the deliverable.
      if (!existsSync(full)) continue

      const stat = statSync(full)
      if (!stat.isFile() || stat.size === 0 || stat.size > MAX_FILE_BYTES) continue
      if (total + stat.size > MAX_TOTAL_BYTES) continue

      const buffer = readFileSync(full)
      if (looksBinary(buffer)) continue

      total += stat.size
      files.push({
        // Relative, and with forward slashes on every platform — this becomes
        // a file path in a web app, not a path on this machine.
        path: relative(resolve(workdir), full).split(sep).join("/"),
        bytes: stat.size,
        content: buffer.toString("utf8")
      })
    } catch {
      // Unreadable, vanished mid-read, a permission we do not have. One file
      // failing is not a reason to lose the others, and none of it is a reason
      // to fail the run — the answer is already written.
      continue
    }
  }

  return files
}
