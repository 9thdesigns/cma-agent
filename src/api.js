import { serverUrl, requireToken } from "./config.js"

// Thin client for the /api/agent/v1 surface.
//
// Every call is outbound. Nothing here ever listens, which is why the
// companion works behind NAT, on hotel wifi, and inside corporate networks
// without anyone opening a port.
async function request(pathname, { method = "GET", body, token, timeoutMs = 30000, auth = true } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const headers = { "Content-Type": "application/json", Accept: "application/json" }
    if (auth) headers.Authorization = `Bearer ${token || requireToken()}`

    const response = await fetch(`${serverUrl()}${pathname}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal
    })

    // 204 is the long-poll's "nothing for you" — a normal outcome, not an error.
    if (response.status === 204) return { status: 204, data: null }

    const text = await response.text()
    let data = null
    if (text) {
      try {
        data = JSON.parse(text)
      } catch (_error) {
        data = { error: text.slice(0, 500) }
      }
    }

    if (!response.ok) {
      const error = new Error(data?.error || `Request failed (${response.status})`)
      error.status = response.status
      error.body = data
      throw error
    }

    return { status: response.status, data }
  } finally {
    clearTimeout(timer)
  }
}

export function pair({ code, name, platform, agentVersion, profiles }) {
  return request("/api/agent/v1/pair", {
    method: "POST",
    auth: false,
    body: { code, name, platform, agent_version: agentVersion, profiles }
  }).then((r) => r.data)
}

// `runtime_versions` is a map — a machine can hold Claude Code AND Cursor, and
// the server wants to know which builds it is actually talking to.
//
// `claude_code_version` rides along beside it because an older server reads
// only that column and would otherwise show "unknown" for every machine the
// moment this companion ships. It is derived, not separately tracked.
export function heartbeat({ agentVersion, runtimeVersions = {} }) {
  return request("/api/agent/v1/heartbeat", {
    method: "POST",
    body: {
      agent_version: agentVersion,
      runtime_versions: runtimeVersions,
      claude_code_version: runtimeVersions.claude_code || null
    }
  }).then((r) => r.data)
}

// What the server believes about this machine. Read-only, so `status` can
// report the truth rather than the companion's own optimism.
export function status() {
  return request("/api/agent/v1/status").then((r) => r.data)
}

export function syncProfiles(profiles) {
  return request("/api/agent/v1/profiles", {
    method: "PUT",
    body: { profiles }
  }).then((r) => r.data)
}

export function verify({ profiles, agentVersion, runtimeVersions = {} }) {
  return request("/api/agent/v1/verify", {
    method: "POST",
    body: {
      profiles,
      agent_version: agentVersion,
      runtime_versions: runtimeVersions,
      claude_code_version: runtimeVersions.claude_code || null
    }
  }).then((r) => r.data)
}

// Long-poll. The server holds the request for up to `wait` seconds; the
// client timeout sits comfortably beyond that so a normal empty poll ends as a
// 204 rather than as an abort we'd have to distinguish from a real failure.
export function claimJob({ wait = 25 } = {}) {
  return request(`/api/agent/v1/jobs/next?wait=${wait}`, {
    timeoutMs: (wait + 15) * 1000
  }).then((r) => r.data?.job || null)
}

// "Still here." Posted every few seconds while a run is in flight so the
// server can wait on liveness instead of on a duration it had to guess. Fire
// and forget by design: a dropped heartbeat costs nothing (the next one lands
// well inside the server's silence budget), and blocking a run on it would be
// the tail wagging the dog.
export function reportProgress(jobId, note, { repeat = false, partial = null } = {}) {
  // `repeat` tells the server this is liveness for an action it already
  // knows about, so it refreshes the clock without adding another identical
  // line to what the user is reading.
  const body = { note: String(note || "").slice(0, 200), repeat }

  // The assistant text so far, when the run has streamed any — this is what
  // the web app renders live instead of waiting for the finish. Only added
  // when present, so an older server (or a note-only beat) sees exactly the
  // payload it always did. Bounded to match the server's own cap on what it
  // will keep in a queue row.
  if (partial) body.partial = String(partial).slice(0, 200000)

  return request(`/api/agent/v1/jobs/${jobId}/progress`, {
    method: "POST",
    body,
    timeoutMs: 10000
  }).then((r) => r.data)
}

export function submitResult(jobId, payload) {
  return request(`/api/agent/v1/jobs/${jobId}/result`, {
    method: "POST",
    body: payload
  }).then((r) => r.data)
}
