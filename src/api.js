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

export function heartbeat({ agentVersion, claudeCodeVersion }) {
  return request("/api/agent/v1/heartbeat", {
    method: "POST",
    body: { agent_version: agentVersion, claude_code_version: claudeCodeVersion }
  }).then((r) => r.data)
}

export function syncProfiles(profiles) {
  return request("/api/agent/v1/profiles", {
    method: "PUT",
    body: { profiles }
  }).then((r) => r.data)
}

export function verify({ profiles, agentVersion, claudeCodeVersion }) {
  return request("/api/agent/v1/verify", {
    method: "POST",
    body: { profiles, agent_version: agentVersion, claude_code_version: claudeCodeVersion }
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

export function submitResult(jobId, payload) {
  return request(`/api/agent/v1/jobs/${jobId}/result`, {
    method: "POST",
    body: payload
  }).then((r) => r.data)
}
