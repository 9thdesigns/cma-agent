// src/version.js and package.json must agree: the tap formula tags from
// package.json and its `test do` asserts `cma-agent --version` matches.
import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import { VERSION } from "../src/version.js"

test("VERSION matches package.json", () => {
  const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url)))
  assert.equal(VERSION, pkg.version)
})
