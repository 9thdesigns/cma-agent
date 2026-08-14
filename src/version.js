// Kept as a plain constant rather than read from package.json at runtime, so
// the value survives any packaging that doesn't ship the manifest alongside
// the code. bin/release-agent checks this against package.json before cutting
// a release — they must agree, because the formula tags from package.json and
// its `test do` block asserts `cma-agent --version` matches.
export const VERSION = "0.8.0"
