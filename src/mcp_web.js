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
// operation path segment — fetch, browse, search — so there is no mapping to
// get wrong.
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
// that is going fine.
const TIMEOUTS = { fetch: 120000, browse: 300000, search: 60000 }

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

export async function serve() {
  return serveMcp({
    name: "cma_web",
    tools: TOOLS,
    list: () => TOOLS,
    call: callOperation
  })
}

export { TOOLS as WEB_TOOLS }
