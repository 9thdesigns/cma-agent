// Bring-your-own local AI.
//
// Ollama is the first runtime here that is not a subprocess, so the things
// worth asserting are different from the CLI adapters': there is no argv to
// compare, but there IS a URL that has to survive every shape people write
// OLLAMA_HOST in, a request body the server has to accept, and a stream whose
// last line is the only one carrying the token counts.
//
// Run with: node --test "agent/test/*.test.js"

import { test } from "node:test"
import assert from "node:assert/strict"

import { ollama, baseUrl, normalizeBaseUrl, buildRequest, messagesFor } from "../src/runtimes/ollama.js"
import { getRuntime, isHttpRuntime, isInstalled, RUNTIMES, runtimeIds } from "../src/runtimes/index.js"

const JOB = {
  model: "llama3.2:3b",
  system: "operator instructions",
  temperature: 0.4,
  max_tokens: 1024,
  messages: [
    { role: "user", content: "hello" },
    { role: "assistant", content: "hi" },
    { role: "user", content: "again" }
  ]
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

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

test("ollama is registered and reachable by id", () => {
  assert.ok(runtimeIds().includes("ollama"))
  assert.equal(getRuntime("ollama"), ollama)
  assert.ok(RUNTIMES.includes(ollama))
})

test("ollama is the only http-transport runtime; the rest are still spawned", () => {
  assert.equal(isHttpRuntime(ollama), true)
  for (const runtime of RUNTIMES.filter((r) => r.id !== "ollama")) {
    assert.equal(isHttpRuntime(runtime), false, `${runtime.id} should still be a subprocess`)
  }
})

test("an explicit URL counts as installed even with no ollama binary on PATH", () => {
  withEnv({ CMA_OLLAMA_URL: "http://192.168.1.9:11434", PATH: "/nonexistent" }, () => {
    assert.equal(isInstalled(ollama), true)
  })
})

// ---------------------------------------------------------------------------
// Where to call
//
// OLLAMA_HOST is documented for two different jobs — telling the server what
// to bind, and telling a client where to look — so it arrives in every shape,
// including ones that are not destinations at all.
// ---------------------------------------------------------------------------

test("a bare port, a host:port, and a full URL all resolve to an origin", () => {
  assert.equal(normalizeBaseUrl("11434"), "http://127.0.0.1:11434")
  assert.equal(normalizeBaseUrl("127.0.0.1:11434"), "http://127.0.0.1:11434")
  assert.equal(normalizeBaseUrl("box.local:11434"), "http://box.local:11434")
  assert.equal(normalizeBaseUrl("https://ollama.example.com"), "https://ollama.example.com")
})

test("a bind address is read as this machine, not called as one", () => {
  // 0.0.0.0 is what people set to make Ollama listen on every interface. As a
  // destination it is meaningless on macOS, so calling it verbatim would fail
  // on exactly the machines whose owners configured it most deliberately.
  assert.equal(normalizeBaseUrl("0.0.0.0:11434"), "http://127.0.0.1:11434")
  assert.equal(normalizeBaseUrl("http://0.0.0.0:11434"), "http://127.0.0.1:11434")
})

test("junk resolves to nothing rather than to a wrong host", () => {
  assert.equal(normalizeBaseUrl(""), null)
  assert.equal(normalizeBaseUrl("   "), null)
  assert.equal(normalizeBaseUrl("http://"), null)
})

test("our variable wins over Ollama's, and the default is loopback", () => {
  withEnv({ CMA_OLLAMA_URL: "http://ours:1", OLLAMA_HOST: "theirs:2" }, () => {
    assert.equal(baseUrl(), "http://ours:1")
  })
  withEnv({ CMA_OLLAMA_URL: null, OLLAMA_HOST: "theirs:2" }, () => {
    assert.equal(baseUrl(), "http://theirs:2")
  })
  withEnv({ CMA_OLLAMA_URL: null, OLLAMA_HOST: null }, () => {
    assert.equal(baseUrl(), "http://127.0.0.1:11434")
  })
})

// ---------------------------------------------------------------------------
// The request
// ---------------------------------------------------------------------------

test("the conversation goes as messages, not as a flattened prompt", () => {
  // Every CLI runtime renders the history into one string because that is all
  // its argv accepts. Ollama takes a real message array, and flattening here
  // would throw away the role boundaries the model was trained on.
  assert.deepEqual(messagesFor(JOB), [
    { role: "system", content: "operator instructions" },
    { role: "user", content: "hello" },
    { role: "assistant", content: "hi" },
    { role: "user", content: "again" }
  ])
})

test("a job with no system prompt sends no system message", () => {
  const messages = messagesFor({ messages: [{ role: "user", content: "hi" }] })
  assert.deepEqual(messages, [{ role: "user", content: "hi" }])
})

test("the request streams, names the model, and maps the sampling options", () => {
  const request = withEnv({ CMA_OLLAMA_URL: "http://127.0.0.1:11434" }, () => buildRequest(JOB))

  assert.equal(request.url, "http://127.0.0.1:11434/api/chat")
  assert.equal(request.method, "POST")
  assert.equal(request.body.stream, true)
  assert.equal(request.body.model, "llama3.2:3b")
  assert.equal(request.body.options.temperature, 0.4)
  // Ollama's name for max_tokens.
  assert.equal(request.body.options.num_predict, 1024)
})

test("the model is kept warm past Ollama's five-minute default", () => {
  // Ollama unloads after five idle minutes, so the turn after a pause paid
  // the whole model load again before its first token — most of what made a
  // local run feel slow. The request says how long to keep the weights up.
  const request = withEnv({ CMA_OLLAMA_KEEP_ALIVE: null }, () => buildRequest(JOB))
  assert.equal(request.body.keep_alive, "30m")
})

test("keep-alive is the operator's when they set it, seconds as numbers", () => {
  // A duration string rides as-is…
  const tuned = withEnv({ CMA_OLLAMA_KEEP_ALIVE: "2h" }, () => buildRequest(JOB))
  assert.equal(tuned.body.keep_alive, "2h")
  // …and a numeric shape goes as a number, because "-1" only means "never
  // unload" to Ollama when it is one.
  const forever = withEnv({ CMA_OLLAMA_KEEP_ALIVE: "-1" }, () => buildRequest(JOB))
  assert.equal(forever.body.keep_alive, -1)
})

test("a vision turn's image parts ride as raw base64, per message", () => {
  // The server sends provider-neutral parts ({media_type, data}) and only on
  // turns whose model can read them. Ollama wants bare base64 strings in
  // `images` — no data: wrapper, no media type.
  const messages = messagesFor({
    messages: [
      { role: "user", content: "what is in this?", images: [{ media_type: "image/png", data: "AAAA" }] },
      { role: "assistant", content: "a chart" },
      // Tolerated shapes: a bare string, and a data: URI that gets stripped.
      { role: "user", content: "and this?", images: ["BBBB", "data:image/jpeg;base64,CCCC"] }
    ]
  })

  assert.deepEqual(messages[0].images, ["AAAA"])
  assert.equal(messages[1].images, undefined)
  assert.deepEqual(messages[2].images, ["BBBB", "CCCC"])
})

test("a text-only conversation carries no images key at all", () => {
  // Absent, not empty: an `images: []` on every message would be a wire
  // change for nothing.
  for (const message of messagesFor(JOB)) {
    assert.equal("images" in message, false)
  }
})

test("an unset token ceiling is omitted rather than guessed at", () => {
  // We know nothing about a model somebody pulled themselves — inventing a
  // num_predict would truncate its answers for no reason.
  const request = buildRequest({ model: "m", messages: [], max_tokens: 0, temperature: -1 })
  assert.equal(request.body.options, undefined)
})

// ---------------------------------------------------------------------------
// The stream
//
// {"message":{"content":"Hel"},"done":false}
// {"done":true,"done_reason":"stop","eval_count":298,...}   ← counts, last line only
// {"error":"model 'llama9' not found"}                      ← in-band, under a 200
// ---------------------------------------------------------------------------

test("text is assembled from the chunks and usage from the final line", () => {
  const output = ollama.collapseEvents([
    { model: "llama3.2:3b", message: { role: "assistant", content: "Hel" }, done: false },
    { model: "llama3.2:3b", message: { role: "assistant", content: "lo" }, done: false },
    {
      model: "llama3.2:3b", done: true, done_reason: "stop",
      prompt_eval_count: 26, eval_count: 298
    }
  ])

  assert.equal(output.content, "Hello")
  assert.equal(output.model, "llama3.2:3b")
  assert.equal(output.stopReason, "stop")
  assert.equal(output.sawResult, true)
  assert.equal(output.isError, false)
  assert.equal(output.usage.input_tokens, 26)
  assert.equal(output.usage.output_tokens, 298)
})

test("an in-band error is a failure, not an answer", () => {
  // It arrives with a 200 around it, so nothing but this check stands between
  // "model not found" and that sentence being stored as the assistant's reply.
  const output = ollama.collapseEvents([{ error: "model 'llama9' not found, try pulling it first" }])

  assert.equal(output.isError, true)
  assert.match(output.errorStatus, /not found/)
  assert.equal(output.content, "")
})

test("a stream cut off mid-answer keeps what arrived and reports no result", () => {
  const output = ollama.collapseEvents([
    { message: { content: "half an ans" }, done: false }
  ])

  assert.equal(output.content, "half an ans")
  assert.equal(output.sawResult, false)
})

test("partial text is the content chunk and nothing else", () => {
  assert.equal(ollama.partialTextFrom({ message: { content: "tok" } }), "tok")
  // A reasoning model's private thinking is not the answer, and streaming it
  // into the user's message would put the model's scratchpad in the transcript.
  assert.equal(ollama.partialTextFrom({ message: { thinking: "hmm" } }), null)
  assert.equal(ollama.partialTextFrom({ done: true }), null)
})

test("the ticker distinguishes thinking from writing and says nothing else", () => {
  assert.equal(ollama.describeEvent({ message: { thinking: "hmm" } }), "Thinking")
  assert.equal(ollama.describeEvent({ message: { content: "x" } }), "Writing the answer")
  assert.equal(ollama.describeEvent({ done: true }), null)
  assert.equal(ollama.describeEvent({ error: "nope" }), null)
})

// ---------------------------------------------------------------------------
// Failures worth naming
// ---------------------------------------------------------------------------

test("a missing model tells you the command that fixes it", () => {
  const error = ollama.classifyFailure("model 'llama9' not found")
  assert.match(error.message, /ollama pull/)
})

test("nothing listening names the address we actually tried", () => {
  // The address comes from the run, not from the environment at throw time.
  const error = ollama.classifyFailure("fetch failed: ECONNREFUSED",
                                       { url: "http://box.local:11434/api/chat" })

  assert.match(error.message, /http:\/\/box\.local:11434\./)
  assert.match(error.message, /CMA_OLLAMA_URL/)
})

test("a model too big for the machine is not reported as a login problem", () => {
  // The shared classifier treats "requires more system memory" as auth-shaped
  // if it gets there first, which would send someone to sign into an account
  // that does not exist.
  const error = ollama.classifyFailure("model requires more system memory (12.6 GiB) than is available")
  assert.match(error.message, /too large for this machine/)
  assert.doesNotMatch(error.message, /sign(ing)? in/i)
})

// ---------------------------------------------------------------------------
// What it cannot do
// ---------------------------------------------------------------------------

test("ollama declares no filesystem, and every CLI runtime still has one", () => {
  // A repository turn on this runtime answers in text and edits nothing. The
  // flag is what lets the web app say so BEFORE somebody picks it for a coding
  // session, rather than at the end of one.
  assert.equal(ollama.filesystem, false)
  for (const runtime of RUNTIMES.filter((r) => r.id !== "ollama")) {
    assert.notEqual(runtime.filesystem, false, `${runtime.id} should still reach the filesystem`)
  }
})

test("ollama reports its own models; the subscription runtimes have curated lists", () => {
  assert.equal(ollama.reportsModels, true)
  assert.equal(typeof ollama.listModels, "function")
  for (const runtime of RUNTIMES.filter((r) => r.id !== "ollama")) {
    assert.notEqual(runtime.reportsModels, true, `${runtime.id} should not report a model list`)
  }
})

test("there is no login to add, and the error says why", () => {
  assert.equal(ollama.multiLogin, false)
  assert.deepEqual(ollama.loginArgs(), [])
  assert.match(ollama.loginHint, /nothing to sign into/i)
})

// ---------------------------------------------------------------------------
// The transport, end to end
//
// Everything above asserts shapes. This asserts the part that actually breaks:
// a real socket, chunked NDJSON that does not align to line boundaries, and
// the engine reading it without a subprocess anywhere in sight.
// ---------------------------------------------------------------------------

import http from "node:http"
import { runCompletion } from "../src/engine.js"

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

test("a streamed answer is read off the socket, chunk boundaries and all", async () => {
  let received = null

  const body = ndjson([
    { model: "llama3.2:3b", message: { role: "assistant", content: "Hel" }, done: false },
    { model: "llama3.2:3b", message: { role: "assistant", content: "lo " }, done: false },
    { model: "llama3.2:3b", message: { role: "assistant", content: "there" }, done: false },
    { model: "llama3.2:3b", done: true, done_reason: "stop", prompt_eval_count: 11, eval_count: 3 }
  ])

  const { server, url } = await serving((req, res) => {
    let raw = ""
    req.on("data", (chunk) => (raw += chunk))
    req.on("end", () => {
      received = JSON.parse(raw)
      res.writeHead(200, { "Content-Type": "application/x-ndjson" })
      // Split mid-line on purpose: NDJSON arrives in TCP chunks, not in
      // events, and a reader that assumes one chunk is one line works
      // perfectly against a fast localhost and fails against a real model.
      res.write(body.slice(0, 40))
      res.write(body.slice(40))
      res.end()
    })
  })

  try {
    const output = await withEnv({ CMA_OLLAMA_URL: url }, () =>
      runCompletion({ ...JOB, runtime: "ollama" }))

    assert.equal(output.content, "Hello there")
    assert.equal(output.model, "llama3.2:3b")
    assert.equal(output.stopReason, "stop")
    assert.equal(output.usage.output_tokens, 3)
    // No filesystem, so no documents — stated as an empty list rather than
    // left undefined, because the caller reads it either way.
    assert.deepEqual(output.files, [])

    // And the server really was asked the thing we thought we were asking.
    assert.equal(received.stream, true)
    assert.equal(received.model, "llama3.2:3b")
    assert.equal(received.messages[0].role, "system")
  } finally {
    server.close()
  }
})

test("partial text reaches the progress callback before the run finishes", async () => {
  const partials = []

  const { server, url } = await serving((req, res) => {
    req.resume()
    req.on("end", async () => {
      res.writeHead(200, { "Content-Type": "application/x-ndjson" })
      res.write(ndjson([{ message: { content: "first" }, done: false }]))
      // Past MIN_NOTE_INTERVAL_MS, so the second chunk is a post rather than
      // being swallowed by the once-a-second ceiling. This is the behaviour
      // that makes a local run stream in the web app instead of arriving whole.
      await new Promise((r) => setTimeout(r, 1100))
      res.write(ndjson([
        { message: { content: " second" }, done: false },
        { done: true, done_reason: "stop", eval_count: 2 }
      ]))
      res.end()
    })
  })

  try {
    const output = await withEnv({ CMA_OLLAMA_URL: url }, () =>
      runCompletion({ ...JOB, runtime: "ollama" }, {
        onProgress: (_note, { partial } = {}) => { if (partial) partials.push(partial) }
      }))

    assert.equal(output.content, "first second")
    assert.ok(partials.length >= 1, "expected the answer so far to be reported while running")
    // Always the full text so far, never a delta — the caller overwrites.
    assert.equal(partials[partials.length - 1], "first second")
  } finally {
    server.close()
  }
})

test("an error under a 200 fails the run instead of becoming the answer", async () => {
  const { server, url } = await serving((req, res) => {
    req.resume()
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/x-ndjson" })
      res.end(ndjson([{ error: "model 'llama9' not found, try pulling it first" }]))
    })
  })

  try {
    await assert.rejects(
      withEnv({ CMA_OLLAMA_URL: url }, () => runCompletion({ ...JOB, runtime: "ollama" })),
      /ollama pull/
    )
  } finally {
    server.close()
  }
})

test("an HTTP error body is reported as the runtime's own words", async () => {
  const { server, url } = await serving((req, res) => {
    req.resume()
    req.on("end", () => {
      res.writeHead(404, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ error: "model 'llama9' not found" }))
    })
  })

  try {
    await assert.rejects(
      withEnv({ CMA_OLLAMA_URL: url }, () => runCompletion({ ...JOB, runtime: "ollama" })),
      /ollama pull/
    )
  } finally {
    server.close()
  }
})

test("nothing listening is reported as an address to start, not a broken app", async () => {
  // Port 9 (discard) on loopback: reliably refused, and refused fast. The
  // assertion pins the port with a boundary on BOTH sides — "127.0.0.1:1" is
  // a prefix of the default "127.0.0.1:11434", so a loose regex here would
  // pass even if the message named an address we never tried.
  await assert.rejects(
    withEnv({ CMA_OLLAMA_URL: "http://127.0.0.1:9" }, () =>
      runCompletion({ ...JOB, runtime: "ollama" })),
    /Nothing answered at http:\/\/127\.0\.0\.1:9\./
  )
})

test("a slow first token is a slow answer, not a dead connection", async () => {
  // The failure this guards: a 70B model on a laptop can take well over the
  // connect timeout to produce its first token. A deadline on FIRST TOKEN
  // rather than on the connection would kill exactly the runs this feature
  // exists for — so the connect timer is cleared the moment headers arrive,
  // and silence after that belongs to the idle watchdog (ten minutes).
  const { server, url } = await serving((req, res) => {
    req.resume()
    req.on("end", async () => {
      // Headers now, body well after the connect budget below.
      res.writeHead(200, { "Content-Type": "application/x-ndjson" })
      res.flushHeaders()
      await new Promise((r) => setTimeout(r, 400))
      res.end(ndjson([
        { message: { content: "worth the wait" }, done: false },
        { done: true, done_reason: "stop", eval_count: 3 }
      ]))
    })
  })

  try {
    // 100ms connect budget against a 400ms first token: if the timer outlived
    // the connection this run would be killed before a byte of the answer.
    const output = await withEnv(
      { CMA_OLLAMA_URL: url, CMA_OLLAMA_CONNECT_TIMEOUT_MS: "100" },
      () => runCompletion({ ...JOB, runtime: "ollama" })
    )

    assert.equal(output.content, "worth the wait")
  } finally {
    server.close()
  }
})

test("but a server that never answers at all is given up on", async () => {
  // The other direction: the connect budget has to actually fire, or a machine
  // that accepts the socket and then says nothing would hang for ten minutes
  // on the idle watchdog instead of failing in seconds.
  const { server, url } = await serving((req) => {
    req.resume()
    // Deliberately never respond.
  })

  try {
    await assert.rejects(
      withEnv({ CMA_OLLAMA_URL: url, CMA_OLLAMA_CONNECT_TIMEOUT_MS: "150" }, () =>
        runCompletion({ ...JOB, runtime: "ollama" })),
      /Nothing answered at/
    )
  } finally {
    server.close()
  }
})
