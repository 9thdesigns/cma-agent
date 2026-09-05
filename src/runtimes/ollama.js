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
// llama3.2-vision, …) run here. The server sends image parts only for a model
// it knows can read them — see messagesFor for the wire shape.
//
// ── Models ────────────────────────────────────────────────────────────────
//
// Nobody can tell you what models this runtime has. Not us, not a catalogue,
// not a constant in the Rails app: the answer is whatever that person ran
// `ollama pull` for, and it changes when they pull another. So this adapter
// reports the machine's own list on every scan and the server stores it per
// device. That is the whole reason `listModels` exists on the runtime
// interface — see `profiles.js` and `local_devices.runtime_models`.
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
const DEFAULT_KEEP_ALIVE = "30m"

function keepAlive() {
  const raw = String(process.env.CMA_OLLAMA_KEEP_ALIVE || "").trim()
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
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetch(`${baseUrl()}${path}`, {
      headers: { Accept: "application/json" },
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

// What the engine POSTs. Shaped as data rather than performed here so a test
// can assert the body without a server, exactly as the CLI adapters are
// asserted as argv.
export function buildRequest(job) {
  const options = {}
  if (Number(job.temperature) >= 0) options.temperature = Number(job.temperature)
  // Ollama's own name for max_tokens. -1 is its "no limit"; we simply omit the
  // key rather than guess a ceiling for a model we know nothing about.
  if (Number(job.max_tokens) > 0) options.num_predict = Number(job.max_tokens)

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
// This is the one runtime where the run total and the window's occupancy are
// legitimately the same number. Every other adapter here drives an agentic
// CLI that re-sends the conversation on each step, so its totals are a sum
// over many prompts; Ollama's /api/chat has no tools and makes exactly one
// call, so `prompt_eval_count` is that single prompt — which is both what the
// run spent on input and how full the window was when it went out.
//
// What we still cannot state is the DENOMINATOR: the window a local model
// runs with is `num_ctx`, set on the machine per model, and nothing in the
// response reports it. Code::Session draws no meter unless it knows the
// window, so this number reaches the server honestly and simply isn't
// rendered as a percentage of a window nobody measured.
function usageFrom(event) {
  const prompt = Number(event.prompt_eval_count || 0)
  return normalizeUsage({
    input_tokens: prompt,
    output_tokens: Number(event.eval_count || 0),
    context_tokens: prompt
  })
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

  out.content = chunks.join("")
  return { ...out, sawResult }
}

// Ollama's failures are its own, and none of them is "sign in again" — there
// is nothing to sign into. Naming the two that people actually hit beats
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
  classifyFailure: classifyOllamaFailure,

  limitations: [
    "Answers questions and writes code, but cannot read or edit files, run git, or open pull requests.",
    "The models are whatever you have pulled on that machine — `ollama pull <model>` adds one.",
    "Quality and speed are your hardware's, not a hosted provider's."
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
    const tags = await getJson("/api/tags")

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
  async listModels() {
    const result = await getJson("/api/tags")
    if (!result.ok) return []
    return modelNames(result.data)
  },

  advice() {
    if (this.isAvailable()) return null
    return `Ollama isn't installed. Install it from ${this.install} and pull a model ` +
           "(`ollama pull llama3.2`) — that model is what this machine will run."
  }
}

// Ollama returns `name` ("llama3.2:3b") and, on newer builds, an identical
// `model`. Read both so a rename in either direction costs nothing.
function modelNames(data) {
  return Array.from(
    new Set(
      (data?.models || [])
        .map((entry) => String(entry?.name || entry?.model || "").trim())
        .filter(Boolean)
    )
  ).sort()
}
