import { classifyFailure, emptyUsage, locateBin, normalizeUsage } from "./shared.js"

// ---------------------------------------------------------------------------
// Ollama — the user's own model, on the user's own machine.
//
// Every other runtime here drives a vendor CLI that spends a subscription. This
// one spends nothing: the weights are on the disk in front of them, and the
// only thing standing between this app and that model is that the app runs in a
// datacentre and the model listens on localhost.
//
// Which is exactly what the companion already solves. A paired machine is a
// place we can send work to, so "bring your own local AI" is not a new provider
// kind, a new billing mode, or a hole punched through anyone's firewall — it is
// one more runtime on a machine that is already connected. `http://127.0.0.1`
// is a perfectly good endpoint when you are standing on the right computer.
//
// ── How this differs from the CLI runtimes ─────────────────────────────────
//
// There is no process to spawn. `ollama` ships a CLI, but its non-interactive
// mode prints prose to a terminal — no token counts, no stop reason, no way to
// tell an error from an answer about errors. The HTTP API on 11434 gives all
// three, and it streams NDJSON, which is the same wire the engine already
// reads from the other three. So the adapter declares `transport: "http"` and
// hands the engine a request instead of an argv; everything downstream — the
// idle watchdog, the heartbeat, partial text, cancellation — is unchanged.
//
// ── What it cannot do, stated rather than discovered ───────────────────────
//
// No tools. Not "no tools yet" — the /api/chat endpoint answers with text and
// that is all this adapter asks it for. A repository turn on Ollama reads the
// conversation and writes an answer; it does not open files, run git, or reach
// the GitHub MCP server. That is a real difference from Claude Code and it is
// why `limitations` says so out loud and the web app repeats it at the point
// where somebody picks this runtime.
//
// Vision, on the other hand, it CAN do: /api/chat takes base64 images per
// message, and the open-weight vision families (qwen2.5vl, llava,
// llama3.2-vision, gemma4, …) run here. The server sends image parts only for
// a model it knows can read them — see messagesFor for the wire shape.
//
// ── Models ────────────────────────────────────────────────────────────────
//
// Nobody can tell you what models this runtime has. Not us, not a catalogue,
// not a constant in the Rails app: the answer is whatever that person ran
// `ollama pull` for, and it changes when they pull another. So this adapter
// reports the machine's own list on every scan and the server stores it per
// device. That is the whole reason `listModels` exists on the runtime
// interface — see `profiles.js` and `local_devices.runtime_models`.
//
// Since Ollama started describing its models, the scan reports more than
// names (`listModelMeta`): what each one can do (`capabilities` — thinking,
// vision, tools), how long a prompt it was trained for (`context_length`),
// and whether it is really here at all. A signed-in Ollama lists its cloud
// models (`gpt-oss:120b-cloud`, `glm-4.7:cloud`, …) next to the local ones
// and proxies them to ollama.com — the prompt leaves the machine and the run
// spends that person's Ollama account, so the web app must not call those
// "your own model · free". `remote_host` on the tag is the honest signal, the
// name suffix the fallback for a server too old to send it.
// ---------------------------------------------------------------------------

const DEFAULT_BASE_URL = "http://127.0.0.1:11434"

// How long to wait for the response HEADERS. Not for the first token, and the
// distinction is the whole reason this is a separate number: a 70B model on a
// laptop can take a minute to say anything, and that is a slow answer rather
// than a dead one. Generation is bounded by the engine's idle watchdog, which
// takes over the moment headers arrive.
//
// Overridable so the engine's handling of it can be tested against a real
// socket without a fifteen-second test.
const DEFAULT_CONNECT_TIMEOUT_MS = 15000

function connectTimeoutMs() {
  return Number(process.env.CMA_OLLAMA_CONNECT_TIMEOUT_MS || DEFAULT_CONNECT_TIMEOUT_MS)
}

// Reachability and version checks. Short, because these hit endpoints that
// answer from memory: if localhost hasn't replied in five seconds, nothing is
// listening.
const PROBE_TIMEOUT_MS = 5000

// How long Ollama keeps the model loaded after this request. Its own default
// is five minutes, which makes every pause longer than that pay the full
// model load — tens of seconds on a 7B, minutes on bigger weights — before
// the next turn's first token. That reload is most of why a local run "takes
// forever" on the turn after a coffee break, so half an hour is the default
// here: long enough to span the gaps real conversations have, on hardware
// whose owner chose to run this.
//
// CMA_OLLAMA_KEEP_ALIVE overrides it — a Go duration ("10m", "24h"), or a
// number of seconds; -1 keeps the model loaded until Ollama itself stops,
// 0 restores unload-immediately for a RAM-tight machine.
//
// OLLAMA_KEEP_ALIVE — Ollama's own variable, same value shapes — is honoured
// next. Ollama documents that a request's `keep_alive` OVERRIDES the server's
// setting, so before this line an operator who had set -1 on a dedicated box
// (or 0 on a starved one) silently got our thirty minutes instead.
const DEFAULT_KEEP_ALIVE = "30m"

function keepAlive() {
  const raw = String(process.env.CMA_OLLAMA_KEEP_ALIVE || process.env.OLLAMA_KEEP_ALIVE || "").trim()
  if (!raw) return DEFAULT_KEEP_ALIVE
  // Ollama reads a bare number as seconds and a string as a duration; "-1"
  // only means "forever" as a number, so numeric shapes are sent as numbers.
  return /^-?\d+$/.test(raw) ? Number(raw) : raw
}

// Turn whatever the user has in their environment into an origin we can call.
//
// OLLAMA_HOST is the variable Ollama itself documents, and it is used for two
// different jobs: telling the *server* what to bind and telling a *client*
// where to look. So it arrives in every shape — "11434", "127.0.0.1:11434",
// "http://box.local:11434" — and sometimes as a bind address that is not a
// destination at all. Exported because the parsing is the part worth testing.
export function normalizeBaseUrl(value) {
  const raw = String(value || "").trim()
  if (!raw) return null

  // A bare port is how Ollama's own docs write it.
  const withHost = /^\d+$/.test(raw) ? `127.0.0.1:${raw}` : raw
  const withScheme = /^https?:\/\//i.test(withHost) ? withHost : `http://${withHost}`

  let url
  try {
    url = new URL(withScheme)
  } catch {
    return null
  }

  // 0.0.0.0 means "listen on everything". As a destination it is meaningless
  // on macOS and merely lucky on Linux, so read it as what the person meant:
  // the server on this machine.
  if (url.hostname === "0.0.0.0" || url.hostname === "::" || url.hostname === "[::]") {
    url.hostname = "127.0.0.1"
  }

  return url.origin
}

// Ours wins over Ollama's, because CMA_OLLAMA_URL is set by someone who is
// configuring this companion specifically — most often to reach an Ollama in a
// container or on another box on their LAN.
export function baseUrl() {
  return normalizeBaseUrl(process.env.CMA_OLLAMA_URL) ||
         normalizeBaseUrl(process.env.OLLAMA_HOST) ||
         DEFAULT_BASE_URL
}

async function getJson(path, { timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  return requestJson(path, { timeoutMs })
}

async function postJson(path, body, { timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  return requestJson(path, { method: "POST", body, timeoutMs })
}

async function requestJson(path, { method = "GET", body, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetch(`${baseUrl()}${path}`, {
      method,
      headers: body ? { Accept: "application/json", "Content-Type": "application/json" }
                    : { Accept: "application/json" },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal
    })
    if (!response.ok) return { ok: false, status: response.status }
    return { ok: true, data: await response.json() }
  } catch (error) {
    return { ok: false, error }
  } finally {
    clearTimeout(timer)
  }
}

// ---------------------------------------------------------------------------
// What the machine knows about its models
//
// Filled by every scan (`listModels` / `listModelMeta`) and read by
// `buildRequest`, which is synchronous and cannot go and ask. A model pulled
// since the last scan is simply unknown until the next one — ten minutes at
// most, or `cma-agent runtimes:scan` right now — and unknown is handled by
// never sending anything that could be refused.
// ---------------------------------------------------------------------------

// name → { capabilities, context_length, remote, remote_host, digest }
const MODEL_META = new Map()

// A cloud stub's name, for a server too old to send `remote_host`. Ollama
// normalises `model:cloud` into `model:<tag>-cloud` / `model:cloud`, so both
// suffixes are real (server/routes.go).
export const CLOUD_MODEL_ID = /(?::|-)cloud$/i

// Everything Ollama's model.Capability enumerates. Anything else a server
// might send is dropped here rather than forwarded to a jsonb column.
const KNOWN_CAPABILITIES = new Set(["completion", "tools", "vision", "thinking", "embedding", "insert", "image", "audio"])

// How many /api/show calls one scan may make for a server whose /api/tags
// describes nothing. Enough for any real library; small enough that a scan
// against an old build stays a scan.
const SHOW_FALLBACK_LIMIT = 40

// The last /api/tags answer, briefly. A scan asks twice — once for names,
// once for the descriptions — and localhost or not, the second ask should
// not be a second round trip.
const TAGS_MEMO_MS = 10000
let tagsMemo = { at: 0, data: null }

async function fetchTags() {
  if (tagsMemo.data && Date.now() - tagsMemo.at < TAGS_MEMO_MS) return { ok: true, data: tagsMemo.data }

  const result = await getJson("/api/tags")
  if (result.ok) tagsMemo = { at: Date.now(), data: result.data }
  return result
}

// Test seam: what a scan would have learned, without a server.
export function rememberModelMeta(byName) {
  for (const [name, meta] of Object.entries(byName || {})) MODEL_META.set(name, describeMeta(name, meta))
}

export function forgetModelMeta() {
  MODEL_META.clear()
  tagsMemo = { at: 0, data: null }
}

export function knownModelMeta(name) {
  return MODEL_META.get(String(name || "")) || null
}

// One /api/tags entry (or a hand-written equivalent) as the shape we store.
// `capabilities: null` means the server did not say — an older build — which
// is different from "can do nothing", and the difference decides whether
// buildRequest may send `think`.
function describeMeta(name, entry = {}) {
  const capabilities = Array.isArray(entry.capabilities)
    ? entry.capabilities.map((c) => String(c).toLowerCase()).filter((c) => KNOWN_CAPABILITIES.has(c))
    : null
  const contextLength = Number(entry.context_length ?? entry.details?.context_length ?? 0)
  const remoteHost = entry.remote_host ? String(entry.remote_host) : null

  return {
    capabilities,
    context_length: Number.isFinite(contextLength) && contextLength > 0 ? Math.floor(contextLength) : null,
    remote: !!remoteHost || entry.remote === true || CLOUD_MODEL_ID.test(String(name)),
    remote_host: remoteHost,
    digest: entry.digest ? String(entry.digest) : null
  }
}

// A model can think when the server says so. Name-based guessing is what the
// capability list exists to replace: `think: true` on a model without it is
// an HTTP 400, so the answer for a model the server has not described is
// "don't know" (null), and don't-know sends nothing.
function canThink(model) {
  const meta = knownModelMeta(model)
  if (!meta || meta.capabilities === null) return null
  return meta.capabilities.includes("thinking")
}

// gpt-oss (the harmony format) takes thinking LEVELS and cannot be switched
// off: `think: false` is documented as ignored for it, so "low" is the
// quietest it goes. Every other thinking model treats a level as "on".
function harmonyModel(model) {
  return /^gpt-oss\b/i.test(String(model || ""))
}

// ---------------------------------------------------------------------------
// The wire
// ---------------------------------------------------------------------------

// Ollama takes a real message array, so unlike the CLI runtimes there is no
// flattening and no "Assistant:" scaffolding at the end of a prompt. The system
// prompt is a message with role "system", which is what the model was trained
// to expect.
export function messagesFor(job) {
  const messages = []
  if (job.system) messages.push({ role: "system", content: String(job.system) })

  for (const message of job.messages || []) {
    const role = message.role === "assistant" ? "assistant" : "user"
    const content = typeof message.content === "string" ? message.content : JSON.stringify(message.content)
    const entry = { role, content }
    const images = imagesFor(message)
    if (images.length > 0) entry.images = images
    messages.push(entry)
  }

  return messages
}

// The screenshots a vision turn carries, in the raw-base64 form Ollama's
// /api/chat documents (`messages[].images`, no data: URI wrapper).
//
// The server sends provider-neutral parts — { media_type:, data: <base64> } —
// and only sends them at all when the model's family can read them (the same
// open-weight vision families the managed server routes to: qwen2.5vl, llava,
// llama3.2-vision, …). Bare strings and data: URIs are tolerated so the shape
// can loosen upstream without stranding a machine on an older server. A
// text-only model job simply never carries the key, and nothing here changes.
function imagesFor(message) {
  const list = Array.isArray(message?.images) ? message.images : []
  return list
    .map((part) => {
      const data = typeof part === "string" ? part : String(part?.data || "")
      return data.replace(/^data:[^,]*;base64,/, "").trim()
    })
    .filter(Boolean)
}

// The effort dial, as Ollama's `think`.
//
// Ollama turns thinking ON by default for any model that can (the server
// substitutes `true` = "medium" when the key is absent), and the trace is
// generated tokens like any other — inside `eval_count`, typically several
// times the visible answer on qwen3 / deepseek-r1 / gpt-oss. So a "Low" dial
// that sent nothing did nothing, and on a laptop that is the difference
// between six seconds and sixty.
//
//   low          → false        (harmless on every model; "low" for gpt-oss,
//                                which cannot be switched off)
//   medium       → true         Ollama's own default, said out loud
//   high         → "high"
//   xhigh / max  → "max"        the server folds it to "high" for gpt-oss,
//                                whose levels stop there
//   nil          → omitted      Standard = the provider default (Ai::Effort)
//
// Everything above `false` is gated on the `thinking` capability from the
// last scan: `false` needs no gate because Ollama never refuses it, while
// anything truthy on a model without the capability is an HTTP 400. So an
// undescribed model gets nothing and keeps the server default. Never a guess
// by name — except gpt-oss, whose harmony format is the documented case where
// `false` is ignored and "low" is the quietest setting.
export function thinkFor(effort, model) {
  const level = String(effort || "").trim().toLowerCase()
  if (!level) return undefined

  const thinks = canThink(model)
  if (level === "low") return harmonyModel(model) && thinks !== false ? "low" : false
  if (thinks !== true) return undefined

  if (level === "medium") return true
  if (level === "high") return "high"
  if (level === "xhigh" || level === "max") return "max"
  return undefined
}

// The window this request runs in, when somebody has actually chosen one.
//
// Left to itself Ollama sizes `num_ctx` by VRAM — 4,096 on any GPU under
// 23 GiB, which is most laptops — and silently drops the front of the
// conversation to fit. Sending the model's full training window instead
// would be the wrong fix: the KV cache for 128k tokens is gigabytes, and a
// model pushed off the GPU by it answers at a crawl or not at all. So this
// is explicit only when the platform KNOWS a number: the operator's
// CMA_OLLAMA_NUM_CTX, or a `num_ctx` the server put on the job. Never the
// web app's 200,000 guess for an unknown model, and never above the window
// the model was trained for (Ollama clamps there anyway; saying so here
// keeps the reported window honest). Otherwise the request says nothing and
// `afterRun` reports what Ollama chose, which is how the web app learns the
// true denominator either way.
export function numCtxFor(job) {
  const candidates = [process.env.CMA_OLLAMA_NUM_CTX, job?.num_ctx]
  for (const raw of candidates) {
    const value = Number(String(raw ?? "").trim())
    if (!Number.isFinite(value) || value <= 0) continue

    const trained = knownModelMeta(job?.model)?.context_length
    return trained ? Math.min(Math.floor(value), trained) : Math.floor(value)
  }
  return undefined
}

// What the engine POSTs. Shaped as data rather than performed here so a test
// can assert the body without a server, exactly as the CLI adapters are
// asserted as argv.
export function buildRequest(job) {
  const options = {}
  if (Number(job.temperature) >= 0) options.temperature = Number(job.temperature)
  // Ollama's own name for max_tokens. -1 is its "no limit"; we simply omit the
  // key rather than guess a ceiling for a model we know nothing about.
  if (Number(job.max_tokens) > 0) options.num_predict = Number(job.max_tokens)
  const numCtx = numCtxFor(job)
  if (numCtx) options.num_ctx = numCtx

  const think = thinkFor(job.effort, job.model)

  return {
    url: `${baseUrl()}/api/chat`,
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/x-ndjson" },
    connectTimeoutMs: connectTimeoutMs(),
    body: {
      model: job.model || undefined,
      messages: messagesFor(job),
      stream: true,
      // See DEFAULT_KEEP_ALIVE: without this, every pause past five minutes
      // pays the model load again on the next turn.
      keep_alive: keepAlive(),
      ...(think === undefined ? {} : { think }),
      ...(Object.keys(options).length > 0 ? { options } : {})
    }
  }
}

// ---------------------------------------------------------------------------
// The stream
//
// {"message":{"role":"assistant","content":"Hel"},"done":false}
// {"message":{...,"thinking":"..."},"done":false}          ← reasoning models
// {"done":true,"done_reason":"stop","eval_count":298,...}  ← the last line only
// {"error":"model 'llama9' not found"}                     ← in-band failure
// ---------------------------------------------------------------------------

// There is no tool trace to narrate, so the ticker has exactly two honest
// states: thinking, and answering. Saying more would be inventing it.
function describeEvent(event) {
  if (!event || typeof event !== "object") return null
  if (event.error) return null
  if (event.done) return null

  if (event.message?.thinking) return "Thinking"
  if (event.message?.content) return "Writing the answer"
  return null
}

function partialTextFrom(event) {
  const text = event?.message?.content
  return typeof text === "string" && text ? text : null
}

// Ollama reports durations in nanoseconds and counts as plain integers. Only
// the counts matter here, and only so the Usage page can say how much work a
// machine did — none of it is billed, because none of it cost anything.
//
// The three counts on the final line, and what each one means (Ollama's
// docs/api/usage.mdx, confirmed against llm/llama_server.go):
//
//   prompt_eval_count         the WHOLE prompt, cached part included. It has
//                             been the whole prompt on every Ollama since 0.3
//                             (mid-2024); an earlier comment here that said it
//                             "already excludes KV-reused tokens" described
//                             the 0.1.x server and was wrong for years.
//   prompt_eval_cached_count  how many of those were served from the KV
//                             cache — an INCLUSIVE subset of the count above
//                             (the OpenAI convention). Optional: absent on a
//                             server older than 0.33.3, and absent means the
//                             server did not say — reported as 0 cached, not
//                             guessed at.
//   eval_count                every generated token, a thinking model's trace
//                             included. There is no separate reasoning count
//                             on this wire; the trace arrives as text.
//
// The companion's usage shape is ADDITIVE (`input_tokens` excludes what was
// cached; `cache_read_input_tokens` sits beside it), so the inclusive pair is
// converted here: input = prompt − cached, cache_read = cached. Reporting the
// raw prompt count next to a cache figure would count the cached share twice
// — once as input, once as a read.
//
// This is the one runtime where the run total and the window's occupancy are
// legitimately the same number. Every other adapter here drives an agentic
// CLI that re-sends the conversation on each step, so its totals are a sum
// over many prompts; Ollama's /api/chat has no tools and makes exactly one
// call, so `prompt_eval_count` is that single prompt — which is both what the
// run spent on input and how full the window was when it went out.
//
// `load_duration` rides along in milliseconds when the request paid the
// model load, because "why was that turn slow" has exactly one answer on a
// laptop and this is it. Informational; a server that doesn't know the key
// drops it.
export function usageFrom(event) {
  const prompt = Math.max(0, Number(event.prompt_eval_count || 0))
  const reported = event.prompt_eval_cached_count
  const cached = reported === null || reported === undefined || !Number.isFinite(Number(reported))
    ? 0
    : Math.min(Math.max(0, Number(reported)), prompt)

  const usage = normalizeUsage({
    input_tokens: prompt - cached,
    cache_read_input_tokens: cached,
    output_tokens: Number(event.eval_count || 0),
    context_tokens: prompt
  })

  const loadMs = Math.round(Number(event.load_duration || 0) / 1e6)
  if (loadMs > 0) usage.load_duration_ms = loadMs

  return usage
}

function collapseEvents(events) {
  const out = {
    content: "", usage: emptyUsage(), model: null,
    stopReason: null, isError: false, errorStatus: null
  }

  let sawResult = false
  const chunks = []

  for (const event of events) {
    if (!event || typeof event !== "object") continue

    if (event.model) out.model = event.model

    // An error can arrive as the only line (a model that isn't pulled) or
    // partway through (the server was stopped mid-answer). Either way it is
    // the answer to "what happened", not text to show the user.
    if (event.error) {
      out.isError = true
      out.errorStatus = String(event.error).slice(0, 300)
      continue
    }

    const text = partialTextFrom(event)
    if (text) chunks.push(text)

    if (event.done) {
      sawResult = true
      out.stopReason = event.done_reason || "stop"
      out.usage = usageFrom(event)
    }
  }

  // The name Ollama answered under — `llama3.2` resolves to `llama3.2:latest`
  // on the wire — so the web app records the model that actually ran, not
  // the alias it asked for.
  if (sawResult && out.model) out.usage.model_label = String(out.model)

  out.content = chunks.join("")
  return { ...out, sawResult }
}

// The window the model actually ran with, learned after the run.
//
// Nothing in the response says. The number lives on the server — request
// `num_ctx`, else the Modelfile, else OLLAMA_CONTEXT_LENGTH, else the VRAM
// tier — and the one place it is exposed is GET /api/ps, which lists the
// loaded models with the `context_length` each was given. One localhost call
// right after the answer; the model is still resident (keep_alive). It rides
// as `usage.context_window` so the web app's context meter and compactor
// can stop planning a laptop's 4,096-token conversation against an assumed
// 200,000. Best effort throughout: a miss leaves the key absent (unknown),
// never 0 and never a failed run.
async function afterRun(output, job) {
  if (!output?.sawResult) return output

  try {
    const model = output.model || job?.model
    const window = await loadedContextLength(model)
    // No /api/ps answer (an old build, a model already unloaded): the number
    // we sent is the number it ran with, clamped like Ollama clamps it.
    const chosen = window || numCtxFor({ ...job, model }) || 0
    if (!chosen) return output

    return { ...output, usage: { ...output.usage, context_window: chosen } }
  } catch (_error) {
    return output
  }
}

async function loadedContextLength(model) {
  if (!model) return 0
  const ps = await getJson("/api/ps")
  if (!ps.ok) return 0

  const wanted = String(model)
  const entry = (ps.data?.models || []).find((m) => m?.name === wanted || m?.model === wanted)
  const length = Number(entry?.context_length || 0)
  return Number.isFinite(length) && length > 0 ? Math.floor(length) : 0
}

// Ollama's failures are its own, and none of them is "sign in again" — there
// is nothing to sign into. Naming the ones that people actually hit beats
// handing back a raw HTTP body.
//
// `url` is the address the run actually used, passed in by the engine rather
// than re-read from the environment here. Same value in practice, but a
// message that names where we knocked has to be derived from where we knocked
// — not from what the environment says a fresh request would do.
function classifyOllamaFailure(detail, { url } = {}) {
  const text = String(detail || "")
  const lower = text.toLowerCase()
  const where = url ? new URL(url).origin : baseUrl()

  // Ollama's own 400s for a request the model cannot honour. The thinking one
  // is reachable from here — an effort dial above Standard on a model the scan
  // had not yet described as unable to think — and the fix is the dial, not
  // the machine.
  const unsupported = lower.match(/does not support (thinking|tools|chat)/)
  if (unsupported) {
    const what = unsupported[1]
    const fix = what === "thinking"
      ? "Set the effort back to Standard for this model, or pick a thinking model (qwen3, deepseek-r1, gpt-oss)."
      : what === "tools"
        ? "Pick a model whose Ollama page lists the tools capability."
        : "Pick a chat model — this one is an embedding or completion-only model."
    return new Error(`This model doesn't support ${what}. ${fix} ${text}`)
  }
  if (/not found|no such model|pull the model/.test(lower)) {
    return new Error(
      `Ollama doesn't have that model on this machine. Pull it there (\`ollama pull <model>\`), ` +
      `then run \`cma-agent runtimes:scan\` so the list here matches. ${text}`
    )
  }
  if (/memory|out of memory|requires more system memory|cuda|vram/.test(lower)) {
    return new Error(
      `That model is too large for this machine to load right now. Try a smaller one, or close ` +
      `what else is running. ${text}`
    )
  }
  if (/econnrefused|failed to fetch|fetch failed|connect|socket/.test(lower)) {
    return new Error(
      `Nothing answered at ${where}. Start Ollama on that machine (\`ollama serve\`, or open the ` +
      `Ollama app), or set CMA_OLLAMA_URL if it listens somewhere else. ${text}`
    )
  }

  return classifyFailure(text, { name: "Ollama", loginHint: null })
}

export const ollama = {
  id: "ollama",
  name: "Ollama",
  cli: "ollama",
  install: "https://ollama.com/download",
  binEnvVar: "CMA_OLLAMA_BIN",
  extraHomePaths: [],

  // Not a subprocess. See the header — the engine branches on this and never
  // asks this adapter for an argv.
  transport: "http",

  // No account, so no logins to isolate and nothing to sign into. One ambient
  // "Default" profile per machine, which is what `profiles.js` produces for
  // any runtime shaped like this.
  configDirEnvVar: null,
  multiLogin: false,
  ambientProfile: true,
  profilesDirName: "ollama-profiles",

  // Nobody can enumerate this from here — see the header. The engine asks the
  // machine, and the machine's answer is what the picker shows.
  reportsModels: true,

  // The tool allowance the other adapters spend so much care on does not apply:
  // /api/chat returns text, so a run has no way to touch the filesystem in the
  // first place. Declared so the server can grey out what won't work rather
  // than letting someone find out at the end of a coding session.
  filesystem: false,

  versionArgs: ["--version"],
  loginArgs: () => [],
  loginHint: "nothing to sign into — Ollama runs your own models locally",

  buildRequest,
  describeEvent,
  collapseEvents,
  partialTextFrom,
  afterRun,
  classifyFailure: classifyOllamaFailure,

  limitations: [
    "Answers questions and writes code, but cannot read or edit files, run git, or open pull requests.",
    "The models are whatever you have pulled on that machine — `ollama pull <model>` adds one.",
    "Quality and speed are your hardware's, not a hosted provider's.",
    "A cloud model listed by a signed-in Ollama (`…-cloud`, `…:cloud`) runs on ollama.com against your Ollama account, not on this machine."
  ],

  // A CLI on PATH is the ordinary signal, but it is not the only one: an
  // Ollama in Docker or on another box has no binary here at all, and setting
  // CMA_OLLAMA_URL is someone saying so explicitly. Sync, because the callers
  // that ask (`installedRuntimes`, `cma-agent status`) are listing what a
  // machine has, not waiting on a network round trip. Whether it actually
  // ANSWERS is `probe`'s question.
  isAvailable() {
    if (process.env.CMA_OLLAMA_URL) return true
    return !!this.resolveBin().bin
  },

  resolveBin() {
    return locateBin({ cli: this.cli, envVar: this.binEnvVar, extraHomePaths: this.extraHomePaths })
  },

  // Reachable, and with something to run. Both halves matter and they fail
  // differently: an Ollama nobody started is "start it", an Ollama with an
  // empty library is "pull a model" — and reporting the second as ready would
  // create a provider whose every model dropdown is empty.
  async probe() {
    const tags = await fetchTags()

    if (!tags.ok) {
      return {
        status: "unknown",
        detail: tags.status
          ? `Ollama answered ${tags.status} at ${baseUrl()}.`
          : `Nothing is listening at ${baseUrl()}. Start Ollama, or set CMA_OLLAMA_URL.`
      }
    }

    const models = modelNames(tags.data)
    if (models.length === 0) {
      return {
        status: "unknown",
        detail: `Ollama is running at ${baseUrl()} but has no models pulled. Try \`ollama pull llama3.2\`.`
      }
    }

    return { status: "ready", detail: `${models.length} model${models.length === 1 ? "" : "s"} available.` }
  },

  async version() {
    const result = await getJson("/api/version")
    if (!result.ok) return null
    return result.data?.version ? String(result.data.version) : null
  },

  // What this machine can actually run, right now. Sorted so the dropdown on
  // the web app is stable between scans — an unsorted list would rewrite the
  // stored catalogue (and log a change) every time Ollama reordered it.
  //
  // Remembers what the tags said about each model on the way past, so a
  // request built a moment later knows whether the model can think.
  async listModels() {
    const result = await fetchTags()
    if (!result.ok) return []
    rememberTags(result.data)
    return modelNames(result.data)
  },

  // What each of those models IS, for the same catalogue: `capabilities`
  // (thinking / vision / tools …), the `context_length` it was trained for,
  // and whether it is a cloud stub proxied to ollama.com. Ollama's /api/tags
  // carries all three on current builds; an older server leaves them out, and
  // for those one /api/show per model fills the gap — bounded, so a machine
  // with a hundred models does not spend a scan on it.
  //
  // Keyed by name; a model with nothing known about it is simply absent, and
  // the server treats absent as unknown. Never a reason to fail a scan.
  async listModelMeta() {
    const result = await fetchTags()
    if (!result.ok) return {}
    rememberTags(result.data)

    let shows = 0
    for (const entry of result.data?.models || []) {
      const name = entryName(entry)
      if (!name) continue
      const meta = MODEL_META.get(name)
      if (!meta || (meta.capabilities !== null && meta.context_length !== null)) continue
      // A cloud stub has no weights here: nothing to learn from /api/show,
      // and the call itself would be proxied to ollama.com.
      if (meta.remote) continue
      if (shows >= SHOW_FALLBACK_LIMIT) break
      shows += 1

      const shown = await postJson("/api/show", { model: name })
      if (!shown.ok) continue
      MODEL_META.set(name, describeMeta(name, {
        ...entry,
        capabilities: entry.capabilities ?? shown.data?.capabilities,
        context_length: meta.context_length ?? trainingContextLength(shown.data)
      }))
    }

    const out = {}
    for (const entry of result.data?.models || []) {
      const name = entryName(entry)
      const meta = name && MODEL_META.get(name)
      if (!meta) continue
      const described = {}
      if (meta.capabilities !== null) described.capabilities = meta.capabilities
      if (meta.context_length !== null) described.context_length = meta.context_length
      if (meta.remote) described.remote = true
      if (meta.remote_host) described.remote_host = meta.remote_host
      if (Object.keys(described).length > 0) out[name] = described
    }
    return out
  },

  advice() {
    if (this.isAvailable()) return null
    return `Ollama isn't installed. Install it from ${this.install} and pull a model ` +
           "(`ollama pull llama3.2`) — that model is what this machine will run."
  }
}

// Ollama returns `name` ("llama3.2:3b") and, on newer builds, an identical
// `model`. Read both so a rename in either direction costs nothing.
function entryName(entry) {
  return String(entry?.name || entry?.model || "").trim()
}

function modelNames(data) {
  return Array.from(
    new Set((data?.models || []).map(entryName).filter(Boolean))
  ).sort()
}

function rememberTags(data) {
  for (const entry of data?.models || []) {
    const name = entryName(entry)
    if (!name) continue
    const previous = MODEL_META.get(name)
    const fresh = describeMeta(name, entry)
    // A /api/show answer from an earlier scan outranks a tag that still says
    // nothing — as long as it described the same weights.
    if (previous && previous.digest && previous.digest === fresh.digest) {
      if (fresh.capabilities === null) fresh.capabilities = previous.capabilities
      if (fresh.context_length === null) fresh.context_length = previous.context_length
    }
    MODEL_META.set(name, fresh)
  }
}

// /api/show reports the training window under model_info as
// "<architecture>.context_length" (e.g. "llama.context_length"); the
// architecture is whatever the GGUF says, so match the suffix.
function trainingContextLength(show) {
  const info = show?.model_info
  if (!info || typeof info !== "object") return null
  for (const [key, value] of Object.entries(info)) {
    if (!/\.context_length$/.test(key)) continue
    const n = Number(value)
    if (Number.isFinite(n) && n > 0) return Math.floor(n)
  }
  return null
}
