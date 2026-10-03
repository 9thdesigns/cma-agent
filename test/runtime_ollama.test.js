// ---------------------------------------------------------------------------
// Ollama's wire, as Ollama actually speaks it.
//
// The counts on the final NDJSON line, the effort dial as `think`, the window
// learned after the run, and what a scan says about each model. Fixtures are
// the shapes from Ollama's own docs (docs/api/usage.mdx, api.md) and the
// current /api/tags, /api/ps and /api/show answers — not the Claude Code
// spelling, which this runtime never speaks.
//
// The one fact everything here rests on: `prompt_eval_count` is the WHOLE
// prompt (it has been since Ollama 0.3), and `prompt_eval_cached_count`, when
// a server ≥ 0.33.3 sends it, is the INCLUSIVE cached subset. The companion's
// usage shape is additive, so the adapter must split, never add.
// ---------------------------------------------------------------------------

import { test } from "node:test"
import assert from "node:assert/strict"
import http from "node:http"

import {
  ollama, buildRequest, usageFrom, thinkFor, numCtxFor,
  rememberModelMeta, forgetModelMeta, knownModelMeta, CLOUD_MODEL_ID
} from "../src/runtimes/ollama.js"
import { occupancyOf } from "../src/runtimes/shared.js"
import { runCompletion } from "../src/engine.js"
import { runtimeCatalogue, MODEL_META_KEY } from "../src/profiles.js"

const JOB = {
  model: "qwen3:8b",
  system: "operator instructions",
  temperature: 0.4,
  max_tokens: 1024,
  messages: [{ role: "user", content: "hello" }]
}

function withEnv(vars, fn) {
  const before = {}
  for (const [key, value] of Object.entries(vars)) {
    before[key] = process.env[key]
    if (value === null) delete process.env[key]
    else process.env[key] = value
  }
  try {
    return fn()
  } finally {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

// The same, for work that keeps reading the environment past its first
// await (a scan's /api/show calls, the /api/ps read after an answer).
async function withEnvAsync(vars, fn) {
  const before = {}
  for (const [key, value] of Object.entries(vars)) {
    before[key] = process.env[key]
    if (value === null) delete process.env[key]
    else process.env[key] = value
  }
  try {
    return await fn()
  } finally {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

function serving(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler)
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, url: `http://127.0.0.1:${server.address().port}` })
    })
  })
}

function ndjson(lines) {
  return lines.map((line) => `${JSON.stringify(line)}\n`).join("")
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = ""
    req.on("data", (chunk) => (raw += chunk))
    req.on("end", () => resolve(raw ? JSON.parse(raw) : null))
  })
}

// The final line of a streamed /api/chat answer on a current server: the
// docs/api/usage.mdx numbers (11 prompt tokens, 8 of them from the KV cache).
const DONE_CURRENT = {
  model: "qwen3:8b", created_at: "2026-09-13T10:00:00.000Z",
  message: { role: "assistant", content: "" }, done_reason: "stop", done: true,
  total_duration: 4883583458, load_duration: 1334875,
  prompt_eval_count: 11, prompt_eval_cached_count: 8, prompt_eval_duration: 42546000,
  eval_count: 57, eval_duration: 535599000
}

// The same line from a server that predates the cached count (api.md's own
// example): no `prompt_eval_cached_count` key at all.
const DONE_OLD = {
  model: "llama3.2", created_at: "2023-08-04T19:22:45.499127Z",
  message: { role: "assistant", content: "" }, done: true,
  total_duration: 4883583458, load_duration: 1334875,
  prompt_eval_count: 26, prompt_eval_duration: 342546000,
  eval_count: 282, eval_duration: 4535599000
}

// /api/tags on a current server: `capabilities`, `details.context_length`,
// and a signed-in account's cloud stub with `remote_host`.
const TAGS_CURRENT = {
  models: [
    {
      name: "qwen3:8b", model: "qwen3:8b", modified_at: "2026-09-01T09:00:00Z", size: 5225000000,
      digest: "500a1f067a9f5c2c6a4b8e2c1d3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f",
      details: { parent_model: "", format: "gguf", family: "qwen3", families: ["qwen3"],
                 parameter_size: "8.2B", quantization_level: "Q4_K_M",
                 context_length: 40960, embedding_length: 4096 },
      capabilities: ["completion", "tools", "thinking"]
    },
    {
      name: "llama3.2:3b", model: "llama3.2:3b", modified_at: "2026-08-20T09:00:00Z", size: 2019393189,
      digest: "a80c4f17acd55265feec403c7aef86be0c25983ab279d83f3bcd3abbcb5b8b72",
      details: { parent_model: "", format: "gguf", family: "llama", families: ["llama"],
                 parameter_size: "3.2B", quantization_level: "Q4_K_M",
                 context_length: 131072, embedding_length: 3072 },
      capabilities: ["completion", "tools"]
    },
    {
      name: "gpt-oss:120b-cloud", model: "gpt-oss:120b-cloud", modified_at: "2026-09-10T09:00:00Z", size: 0,
      digest: "0d8b1c9e7f6a5b4c3d2e1f0a9b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e3f2a1b0c",
      details: { parent_model: "", format: "", family: "", families: null,
                 parameter_size: "", quantization_level: "" },
      capabilities: ["completion", "tools", "thinking"],
      remote_model: "gpt-oss:120b", remote_host: "https://ollama.com"
    }
  ]
}

// /api/ps: what is loaded, and the window each model was given.
const PS_LOADED = {
  models: [
    { name: "qwen3:8b", model: "qwen3:8b", size: 6700000000, digest: TAGS_CURRENT.models[0].digest,
      details: TAGS_CURRENT.models[0].details, expires_at: "2026-09-13T10:30:00.000Z",
      size_vram: 6700000000, context_length: 4096 }
  ]
}

// ---------------------------------------------------------------------------
// The counts
// ---------------------------------------------------------------------------

test("the cached share is split out of the prompt count, never added to it", () => {
  const usage = usageFrom(DONE_CURRENT)

  // 11 prompt tokens, 8 of them served from the KV cache: 3 were actually
  // evaluated. That is the usage.mdx example, and the additive shape of it.
  assert.equal(usage.input_tokens, 3)
  assert.equal(usage.cache_read_input_tokens, 8)
  assert.equal(usage.cache_creation_input_tokens, 0, "there is no cache write on this wire")
  assert.equal(usage.output_tokens, 57, "the thinking trace is inside eval_count, with no sub-count")
  assert.equal(usage.context_tokens, 11, "the whole prompt is what occupied the window")
  // The server's own sum, input + cache_read, is the prompt again — not the
  // prompt plus its cached share.
  assert.equal(occupancyOf(usage), 11)
  assert.equal(usage.load_duration_ms, 1, "load time in ms, for the 'why was that slow' question")
})

test("a server that reports no cached count is read as zero cached, never guessed at", () => {
  const usage = usageFrom(DONE_OLD)

  assert.equal(usage.input_tokens, 26)
  assert.equal(usage.cache_read_input_tokens, 0)
  assert.equal(usage.output_tokens, 282)
  assert.equal(usage.context_tokens, 26)
})

test("an explicit zero is a full miss, and a count above the prompt is clamped", () => {
  const miss = usageFrom({ ...DONE_CURRENT, prompt_eval_cached_count: 0 })
  assert.equal(miss.input_tokens, 11)
  assert.equal(miss.cache_read_input_tokens, 0)

  // Cannot happen on a correct server (the cached tokens are a subset), but
  // a runner bug must not turn into a negative input count.
  const odd = usageFrom({ ...DONE_CURRENT, prompt_eval_cached_count: 40 })
  assert.equal(odd.input_tokens, 0)
  assert.equal(odd.cache_read_input_tokens, 11)
})

test("the model that answered rides as model_label", () => {
  // `llama3.2` resolves to `llama3.2:latest` on the wire; the label is what
  // Ollama said it ran, so the Usage page names the real tag.
  const out = ollama.collapseEvents([
    { model: "llama3.2:latest", message: { role: "assistant", content: "Hi" }, done: false },
    { ...DONE_OLD, model: "llama3.2:latest" }
  ])

  assert.equal(out.usage.model_label, "llama3.2:latest")
  assert.equal(out.usage.input_tokens, 26)

  // No final line, no label: a cut-off stream reports nothing it did not see.
  const cut = ollama.collapseEvents([{ model: "llama3.2:latest", message: { content: "Hi" }, done: false }])
  assert.equal(cut.usage.model_label, undefined)
})

// ---------------------------------------------------------------------------
// The effort dial
// ---------------------------------------------------------------------------

test("the effort dial becomes think, gated on the capability the scan reported", () => {
  forgetModelMeta()
  rememberModelMeta({
    "qwen3:8b": { capabilities: ["completion", "tools", "thinking"] },
    "llama3.2:3b": { capabilities: ["completion", "tools"] },
    "gpt-oss:20b": { capabilities: ["completion", "tools", "thinking"] }
  })

  try {
    // A thinking model takes every stop.
    assert.equal(thinkFor("low", "qwen3:8b"), false)
    assert.equal(thinkFor("medium", "qwen3:8b"), true)
    assert.equal(thinkFor("high", "qwen3:8b"), "high")
    assert.equal(thinkFor("xhigh", "qwen3:8b"), "max")
    assert.equal(thinkFor("max", "qwen3:8b"), "max")
    // Standard is the provider default: nothing is sent.
    assert.equal(thinkFor(null, "qwen3:8b"), undefined)
    assert.equal(thinkFor("", "qwen3:8b"), undefined)

    // A model that cannot think: `false` is harmless, anything else would be
    // an HTTP 400 — so the dial above Low sends nothing.
    assert.equal(thinkFor("low", "llama3.2:3b"), false)
    assert.equal(thinkFor("medium", "llama3.2:3b"), undefined)
    assert.equal(thinkFor("high", "llama3.2:3b"), undefined)

    // A model the scan never described: don't know, so don't guess.
    assert.equal(thinkFor("low", "mystery:7b"), false)
    assert.equal(thinkFor("high", "mystery:7b"), undefined)

    // gpt-oss cannot be switched off — "low" is its quietest — and its
    // levels stop at "high" (the server folds "max" itself).
    assert.equal(thinkFor("low", "gpt-oss:20b"), "low")
    assert.equal(thinkFor("max", "gpt-oss:20b"), "max")
  } finally {
    forgetModelMeta()
  }
})

test("think reaches the request body, and an untouched dial leaves the body as it was", () => {
  forgetModelMeta()
  rememberModelMeta({ "qwen3:8b": { capabilities: ["completion", "thinking"] } })

  try {
    assert.equal(buildRequest({ ...JOB, effort: "low" }).body.think, false)
    assert.equal(buildRequest({ ...JOB, effort: "high" }).body.think, "high")
    assert.equal("think" in buildRequest(JOB).body, false, "Standard sends nothing")
    assert.equal("think" in buildRequest({ ...JOB, model: "llama3.2:3b", effort: "high" }).body, false,
      "an undescribed model keeps the server default")
  } finally {
    forgetModelMeta()
  }
})

// ---------------------------------------------------------------------------
// The window
// ---------------------------------------------------------------------------

test("num_ctx is sent only from a known number — never Ollama's tier, never the app's guess", () => {
  forgetModelMeta()
  try {
    assert.equal(numCtxFor(JOB), undefined)
    assert.equal(buildRequest(JOB).body.options.num_ctx, undefined)

    // The operator's number, or one the server put on the job.
    assert.equal(withEnv({ CMA_OLLAMA_NUM_CTX: "8192" }, () => numCtxFor(JOB)), 8192)
    assert.equal(numCtxFor({ ...JOB, num_ctx: 16384 }), 16384)
    assert.equal(withEnv({ CMA_OLLAMA_NUM_CTX: "8192" }, () => buildRequest(JOB).body.options.num_ctx), 8192)

    // Junk is not a number.
    assert.equal(withEnv({ CMA_OLLAMA_NUM_CTX: "lots" }, () => numCtxFor(JOB)), undefined)
    assert.equal(numCtxFor({ ...JOB, num_ctx: -1 }), undefined)

    // Never above the window the model was trained for, once the scan knows it.
    rememberModelMeta({ "qwen3:8b": { details: { context_length: 4096 } } })
    assert.equal(numCtxFor({ ...JOB, num_ctx: 200000 }), 4096)
  } finally {
    forgetModelMeta()
  }
})

test("the operator's OLLAMA_KEEP_ALIVE is honoured when ours is unset, and ours still wins", () => {
  assert.equal(withEnv({ CMA_OLLAMA_KEEP_ALIVE: null, OLLAMA_KEEP_ALIVE: "-1" }, () => buildRequest(JOB).body.keep_alive), -1)
  assert.equal(withEnv({ CMA_OLLAMA_KEEP_ALIVE: null, OLLAMA_KEEP_ALIVE: "0" }, () => buildRequest(JOB).body.keep_alive), 0)
  assert.equal(withEnv({ CMA_OLLAMA_KEEP_ALIVE: "2h", OLLAMA_KEEP_ALIVE: "-1" }, () => buildRequest(JOB).body.keep_alive), "2h")
  assert.equal(withEnv({ CMA_OLLAMA_KEEP_ALIVE: null, OLLAMA_KEEP_ALIVE: null }, () => buildRequest(JOB).body.keep_alive), "30m")
})

test("the window the model ran with is read off /api/ps after the answer", async () => {
  forgetModelMeta()
  const calls = []
  const { server, url } = await serving(async (req, res) => {
    calls.push(`${req.method} ${req.url}`)
    if (req.method === "POST" && req.url === "/api/chat") {
      await readBody(req)
      res.writeHead(200, { "Content-Type": "application/x-ndjson" })
      res.end(ndjson([
        { model: "qwen3:8b", message: { role: "assistant", content: "Hi." }, done: false },
        DONE_CURRENT
      ]))
      return
    }
    if (req.method === "GET" && req.url === "/api/ps") {
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify(PS_LOADED))
      return
    }
    res.writeHead(404); res.end()
  })

  try {
    const output = await withEnvAsync({ CMA_OLLAMA_URL: url }, () => runCompletion({ ...JOB, runtime: "ollama" }))

    assert.equal(output.content, "Hi.")
    assert.equal(output.usage.context_window, 4096, "the laptop's real window, not an assumed 200,000")
    assert.equal(output.usage.context_tokens, 11)
    assert.equal(output.usage.cache_read_input_tokens, 8)
    assert.equal(output.usage.model_label, "qwen3:8b")
    assert.deepEqual(calls, ["POST /api/chat", "GET /api/ps"])
  } finally {
    server.close()
  }
})

test("when /api/ps says nothing, the number we sent is the window; when nothing was sent, none is claimed", async () => {
  forgetModelMeta()
  const { server, url } = await serving(async (req, res) => {
    if (req.method === "POST" && req.url === "/api/chat") {
      await readBody(req)
      res.writeHead(200, { "Content-Type": "application/x-ndjson" })
      res.end(ndjson([DONE_OLD, { ...DONE_OLD, message: { role: "assistant", content: "Hi." }, done: false }].reverse()))
      return
    }
    // An older build without the key, or a model already unloaded: no
    // context_length anywhere in the answer.
    res.writeHead(200, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ models: [] }))
  })

  try {
    const job = { ...JOB, model: "llama3.2", runtime: "ollama" }
    const sent = await withEnvAsync({ CMA_OLLAMA_URL: url, CMA_OLLAMA_NUM_CTX: "8192" }, () => runCompletion(job))
    assert.equal(sent.usage.context_window, 8192)

    const unknown = await withEnvAsync({ CMA_OLLAMA_URL: url, CMA_OLLAMA_NUM_CTX: null }, () => runCompletion(job))
    assert.equal("context_window" in unknown.usage, false, "unknown is absent, never 0")
  } finally {
    server.close()
  }
})

test("a /api/ps that fails is not a failed run", async () => {
  forgetModelMeta()
  const { server, url } = await serving(async (req, res) => {
    if (req.method === "POST" && req.url === "/api/chat") {
      await readBody(req)
      res.writeHead(200, { "Content-Type": "application/x-ndjson" })
      res.end(ndjson([{ model: "llama3.2", message: { role: "assistant", content: "Hi." }, done: false }, DONE_OLD]))
      return
    }
    res.writeHead(500); res.end("boom")
  })

  try {
    const output = await withEnvAsync({ CMA_OLLAMA_URL: url }, () => runCompletion({ ...JOB, model: "llama3.2", runtime: "ollama" }))
    assert.equal(output.content, "Hi.")
    assert.equal("context_window" in output.usage, false)
  } finally {
    server.close()
  }
})

// ---------------------------------------------------------------------------
// The catalogue
// ---------------------------------------------------------------------------

test("a scan reads capabilities, context length and cloud stubs off /api/tags", async () => {
  forgetModelMeta()
  const calls = []
  const { server, url } = await serving((req, res) => {
    calls.push(`${req.method} ${req.url}`)
    res.writeHead(200, { "Content-Type": "application/json" })
    res.end(JSON.stringify(req.url === "/api/tags" ? TAGS_CURRENT : {}))
  })

  try {
    const names = await withEnvAsync({ CMA_OLLAMA_URL: url }, () => ollama.listModels())
    assert.deepEqual(names, ["gpt-oss:120b-cloud", "llama3.2:3b", "qwen3:8b"], "names as before, sorted")

    const meta = await withEnvAsync({ CMA_OLLAMA_URL: url }, () => ollama.listModelMeta())
    assert.deepEqual(meta["qwen3:8b"], { capabilities: ["completion", "tools", "thinking"], context_length: 40960 })
    assert.deepEqual(meta["llama3.2:3b"], { capabilities: ["completion", "tools"], context_length: 131072 })
    // The cloud stub: proxied to ollama.com, spends that person's Ollama
    // account — flagged, not hidden. No training window because there are
    // no weights here to have one.
    assert.deepEqual(meta["gpt-oss:120b-cloud"],
      { capabilities: ["completion", "tools", "thinking"], remote: true, remote_host: "https://ollama.com" })

    // Described by the tags, so nothing was asked per model; and the second
    // read of the tags came from the memo, not the socket.
    assert.deepEqual(calls, ["GET /api/tags"])

    // What the request builder now knows.
    assert.equal(thinkFor("high", "qwen3:8b"), "high")
    assert.equal(thinkFor("high", "llama3.2:3b"), undefined)
    assert.equal(knownModelMeta("gpt-oss:120b-cloud").remote, true)
  } finally {
    forgetModelMeta()
    server.close()
  }
})

test("the catalogue the server receives carries the descriptions under one reserved key", async () => {
  forgetModelMeta()
  const { server, url } = await serving((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" })
    res.end(JSON.stringify(req.url === "/api/tags" ? TAGS_CURRENT : {}))
  })

  try {
    const catalogue = await withEnvAsync({ CMA_OLLAMA_URL: url }, () => runtimeCatalogue())

    assert.deepEqual(catalogue.ollama, ["gpt-oss:120b-cloud", "llama3.2:3b", "qwen3:8b"])
    assert.equal(MODEL_META_KEY, "_meta")
    assert.equal(catalogue._meta.ollama["qwen3:8b"].context_length, 40960)
    assert.equal(catalogue._meta.ollama["gpt-oss:120b-cloud"].remote, true)
    // Only runtimes that reported models are described — nothing is said
    // about a runtime that listed nothing.
    assert.deepEqual(Object.keys(catalogue._meta), ["ollama"])
  } finally {
    forgetModelMeta()
    server.close()
  }
})

test("an older server that describes nothing in its tags is asked per model with /api/show", async () => {
  forgetModelMeta()
  const shows = []
  const oldTags = {
    models: TAGS_CURRENT.models.slice(0, 2).map(({ capabilities, remote_model, remote_host, details, ...rest }) => ({
      ...rest, details: { ...details, context_length: undefined, embedding_length: undefined }
    }))
  }
  const { server, url } = await serving(async (req, res) => {
    if (req.url === "/api/show") {
      const body = await readBody(req)
      shows.push(body.model)
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify(body.model === "qwen3:8b"
        ? { capabilities: ["completion", "tools", "thinking"],
            model_info: { "general.architecture": "qwen3", "qwen3.context_length": 40960, "qwen3.embedding_length": 4096 } }
        : { capabilities: ["completion", "tools"],
            model_info: { "general.architecture": "llama", "llama.context_length": 131072 } }))
      return
    }
    res.writeHead(200, { "Content-Type": "application/json" })
    res.end(JSON.stringify(req.url === "/api/tags" ? oldTags : {}))
  })

  try {
    const meta = await withEnvAsync({ CMA_OLLAMA_URL: url }, () => ollama.listModelMeta())

    assert.deepEqual(shows.sort(), ["llama3.2:3b", "qwen3:8b"])
    assert.deepEqual(meta["qwen3:8b"], { capabilities: ["completion", "tools", "thinking"], context_length: 40960 })
    assert.deepEqual(meta["llama3.2:3b"], { capabilities: ["completion", "tools"], context_length: 131072 })

    // A second scan against the same digests remembers the answers rather
    // than asking again.
    const again = await withEnvAsync({ CMA_OLLAMA_URL: url }, () => ollama.listModelMeta())
    assert.equal(shows.length, 2)
    assert.deepEqual(again["qwen3:8b"], meta["qwen3:8b"])
  } finally {
    forgetModelMeta()
    server.close()
  }
})

test("a cloud stub is recognised by name on a server too old to say so", () => {
  forgetModelMeta()
  try {
    rememberModelMeta({ "glm-4.7:cloud": {}, "gpt-oss:120b-cloud": {}, "qwen3:8b": {} })

    assert.equal(knownModelMeta("glm-4.7:cloud").remote, true)
    assert.equal(knownModelMeta("gpt-oss:120b-cloud").remote, true)
    assert.equal(knownModelMeta("qwen3:8b").remote, false)
    assert.equal(CLOUD_MODEL_ID.test("hf.co/user/repo:Q4_K_M"), false)
  } finally {
    forgetModelMeta()
  }
})

test("a model that cannot think is told to turn the dial down, not to reinstall anything", () => {
  const cannot = ollama.classifyFailure('400: "llama3.2:3b" does not support thinking', { url: "http://127.0.0.1:11434/api/chat" })
  assert.match(cannot.message, /doesn't support thinking/)
  assert.match(cannot.message, /Standard/)

  const noTools = ollama.classifyFailure('"nomic-embed-text" does not support tools')
  assert.match(noTools.message, /tools capability/)

  const noChat = ollama.classifyFailure('"nomic-embed-text" does not support chat')
  assert.match(noChat.message, /embedding/)
})
