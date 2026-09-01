// An MCP server that hands Claude Code the Configure My AI web channel.
//
// Why this exists: a coding turn on this machine runs headless, and Claude
// Code's own WebFetch/WebSearch sit behind a permission prompt that no one is
// there to answer — which produced whole turns of "please approve WebFetch"
// going nowhere. These tools have no prompt: the server does the fetching on
// the app's own browser ladder (Stagehand → Playwright → default renderer)
// and hands text back. The machine never holds a browser, an API key, or a
// grant — the same boundary the GitHub server draws, one endpoint over.
//
// The server is deliberately dumb: it forwards to /api/code/v1/web/<op> and
// returns what came back. The SSRF guard, the ladder, the login vault — all
// of it lives server-side where the machine cannot be talked out of it.

import { serveMcp } from "./mcp.js"

// `name` is what Claude sees (as `mcp__cma_web__<name>`) and is also the
// operation path segment — fetch, browse, search, request — so there is no
// mapping to get wrong.
const TOOLS = [
  {
    name: "fetch",
    description:
      "Read one web page as text, via Configure My AI's own browser — no permission needed, " +
      "ever. Use this instead of WebFetch, which is not granted in this run. JavaScript-heavy " +
      "pages are rendered server-side automatically.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Absolute http(s) URL to read." },
        max_chars: { type: "integer", description: "Cap on returned text (default 12000)." }
      },
      required: ["url"]
    }
  },
  {
    name: "browse",
    description:
      "Drive a real browser through a page: click, fill forms, log in, extract text, take a " +
      "screenshot — a whole journey in ONE call, run server-side with no permission prompt. " +
      "Stored logins for a site are reused automatically. Use it when the content is behind " +
      "a click, a login or a form; use fetch for a page that just needs reading.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Absolute http(s) URL to open first." },
        steps: {
          type: "array",
          description:
            'Ordered actions, e.g. [{"action":"click","selector":"text=Sign in"},' +
            '{"action":"fill","selector":"#q","value":"term"},{"action":"extract","selector":"main"}]. ' +
            "Selectors are CSS or Playwright text=… labels.",
          items: { type: "object" }
        },
        use_saved_login: { type: "boolean", description: "Reuse a stored browser session for this site (default true)." },
        screenshot: { type: "boolean", description: "Also capture a screenshot at the end." },
        max_chars: { type: "integer", description: "Cap on returned text (default 8000)." }
      },
      required: ["url"]
    }
  },
  {
    name: "search",
    description:
      "Search the web and get a numbered result list back — Configure My AI's own search, no " +
      "permission needed. Use this instead of WebSearch, which is not granted in this run.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to search for." }
      },
      required: ["query"]
    }
  },
  {
    name: "request",
    description:
      "Call an HTTP API — your own method, headers and body — and get the status, the headers " +
      "and the raw body back, server-side with no permission prompt. This is the one that can " +
      "send a credential: put the token in headers as {\"Authorization\": \"Bearer …\"}. Use it " +
      "for anything that is an API rather than a page — a JSON endpoint, a POST that creates " +
      "something, a call that needs a key. Use fetch for a page you just want to read; fetch " +
      "cannot send headers and browse cannot attach one to a navigation, so neither can reach " +
      "an authenticated endpoint. A non-2xx comes back as a normal result with the body intact, " +
      "because that body is what says why it failed — do not retry it as if it were an error.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Absolute http(s) URL to call." },
        method: {
          type: "string",
          description: "GET (default), HEAD, POST, PUT, PATCH or DELETE.",
          enum: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]
        },
        headers: {
          type: "object",
          description:
            'Request headers, e.g. {"Authorization": "Bearer sk-…", "Content-Type": "application/json"}. ' +
            "Credentials are dropped if the endpoint redirects to another host."
        },
        body: {
          description:
            "Request body for POST/PUT/PATCH. An object is sent as JSON (and sets the content type " +
            "for you); a string is sent exactly as written.",
          type: ["object", "string", "array"]
        },
        max_chars: { type: "integer", description: "Cap on the returned body text (default 12000)." }
      },
      required: ["url"]
    }
  }
]

// The endpoint and token arrive in the environment, put there by the process
// that launched Claude Code for this job — never on disk, never in `ps`.
function connection() {
  const endpoint = (process.env.CMA_WEB_ENDPOINT || "").replace(/\/+$/, "")
  const token = process.env.CMA_WEB_TOKEN || ""
  if (!endpoint || !token) {
    throw new Error(
      "This session was not given web access. Say plainly which page you could not " +
        "read and ask the user to paste it — do not ask for tool permissions."
    )
  }
  return { endpoint, token }
}

// A browse journey can walk several pages through the server's browser ladder;
// a fetch may itself escalate from plain HTTP to a rendered browser. Neither is
// one quick API call, so both get room — cutting a journey short abandons work
// that is going fine. `request` is one call, but it may follow redirects and
// the endpoint may be slow, so it gets the server's own ceiling with room over.
const TIMEOUTS = { fetch: 120000, browse: 300000, search: 60000, request: 120000 }

async function callOperation(toolName, args) {
  const { endpoint, token } = connection()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUTS[toolName] || 120000)

  try {
    const response = await fetch(`${endpoint}/${toolName}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      body: JSON.stringify(args || {}),
      signal: controller.signal
    })

    const text = await response.text()
    let data = null
    try {
      data = text ? JSON.parse(text) : null
    } catch (_error) {
      data = { error: text.slice(0, 500) }
    }

    // A server error is an answer about the SITE — a page that would not
    // load, a blocked URL — never about permissions. Handing it back as tool
    // output lets the model act on it instead of ending the turn.
    if (!response.ok || data?.ok === false) {
      return { ok: false, text: data?.error || `Request failed (${response.status})` }
    }

    return { ok: true, text: data?.text ?? JSON.stringify(data, null, 2) }
  } finally {
    clearTimeout(timer)
  }
}

// The served list wins; the baked one above is the floor. This is what ends
// the era of "the server has the tool, the binary doesn't": TOOLS in this
// file is a snapshot frozen at release time, and a machine that stays on one
// build for months was showing months-old capability while the server answered
// operations the model was never told about. GET <endpoint>/tools is the
// server's own copy (Code::WebOps.tool_definitions); one fetch per process,
// remembered, and any failure — old server without the route, no network,
// malformed answer — quietly keeps the snapshot. Nothing a machine ever had
// can be lost this way; things it never had can now arrive.
export function pickServedTools(payload, fallback) {
  const served = payload?.tools
  if (!Array.isArray(served)) return fallback

  const valid = served.filter(
    (t) => t && typeof t.name === "string" && typeof t.description === "string" &&
      t.inputSchema && typeof t.inputSchema === "object"
  )
  return valid.length > 0 ? valid : fallback
}

let toolsPromise = null

function currentTools() {
  toolsPromise ||= (async () => {
    try {
      const { endpoint, token } = connection()
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 5000)
      try {
        const response = await fetch(`${endpoint}/tools`, {
          headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
          signal: controller.signal
        })
        if (!response.ok) return TOOLS
        return pickServedTools(JSON.parse(await response.text()), TOOLS)
      } finally {
        clearTimeout(timer)
      }
    } catch (_error) {
      return TOOLS
    }
  })()
  return toolsPromise
}

export async function serve() {
  return serveMcp({
    name: "cma_web",
    tools: TOOLS,
    list: currentTools,
    call: callOperation
  })
}

export { TOOLS as WEB_TOOLS }
