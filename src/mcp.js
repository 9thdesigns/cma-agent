// An MCP server that hands Claude Code the Configure My AI GitHub connection.
//
// Why this exists rather than a documented `curl`:
//
// A coding turn on this machine runs headless. There is no terminal for anyone
// to answer a permission prompt in, so anything not pre-approved is refused —
// which is exactly what happened when the session was told to POST to the
// operations endpoint: `curl` came back "This command requires approval" and
// the turn ended by asking the user to run the commands themselves. That is
// the same dead end as "press the button", one layer down.
//
// Tools do not have that problem. Claude Code pre-approves an MCP server by
// name, the model calls typed tools instead of composing shell, and the token
// never appears in a command line (so it cannot be echoed into a transcript).
// The result is that a session on this machine opens pull requests the same
// way a session on an API key does — which is the whole point.
//
// The server itself is deliberately dumb: it forwards to the endpoint and
// returns what came back. Every rule about what may be done — protected
// branches, valid branch names, de-duplicating an already-open PR — lives on
// the server, in Code::GithubOps, so the machine cannot be talked out of one.

import { createInterface } from "node:readline"

const PROTOCOL_VERSION = "2024-11-05"

// One entry per operation the server exposes. `name` is what Claude sees
// (as `mcp__cma_github__<name>`); the operation is the same name with its
// first underscore turned back into a dot.
const TOOLS = [
  {
    name: "repo_info",
    description:
      "Which GitHub repository this session ships to, its base branch, this session's working branch, and which branches are protected. Call this first if you are unsure where work should go.",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "branch_list",
    description: "List the branches that exist on the remote.",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "branch_create",
    description:
      "Create a branch on the remote, cut from `from` (defaults to the session base branch). Succeeds quietly if it already exists. You do not need this before `local_push` or `pr_open` — both create the branch as they push.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "New branch name." },
        from: { type: "string", description: "Branch to cut it from. Optional." }
      },
      required: ["name"]
    }
  },
  {
    name: "branch_delete",
    description:
      "Delete a branch on the remote. Refuses the repository default branch and this session's base branch.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string", description: "Branch to delete." } },
      required: ["name"]
    }
  },
  {
    name: "branch_rename",
    description:
      "Rename a branch on the remote. Refuses the repository default branch and this session's base branch.",
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "string", description: "Current branch name." },
        to: { type: "string", description: "New branch name." }
      },
      required: ["from", "to"]
    }
  },
  {
    name: "local_push",
    description:
      "Commit everything in this checkout's working tree onto a branch and push it. The commit and the push happen on the machine, outside this run, so they are not subject to this run's command permissions — this is how work gets pushed, not `git push`. Nothing to commit is fine: the branch is pushed as it stands.",
    inputSchema: {
      type: "object",
      properties: {
        branch: { type: "string", description: "Branch to push to. Defaults to this session's working branch." },
        message: { type: "string", description: "Commit message. Optional." }
      }
    }
  },
  {
    name: "pr_open",
    description:
      "Ship the work: commit this checkout's working tree onto `head`, push it, and open the pull request — all three, in one call. Do NOT run git yourself first. If a pull request for that branch is already open, its title and body are updated instead of failing.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short imperative title." },
        body: { type: "string", description: "Markdown description." },
        head: { type: "string", description: "Branch to commit, push and open the PR from. Defaults to this session's working branch." },
        base: { type: "string", description: "Branch to merge into. Defaults to the session base branch." },
        draft: { type: "boolean", description: "Open as a draft." }
      },
      required: ["title"]
    }
  },
  {
    name: "pr_list",
    description: "List pull requests, newest first.",
    inputSchema: {
      type: "object",
      properties: { state: { type: "string", description: '"open" (default), "closed" or "all".' } }
    }
  },
  {
    name: "pr_get",
    description: "Read one pull request: title, state, head/base branches and URL.",
    inputSchema: {
      type: "object",
      properties: { number: { type: "integer", description: "Pull request number." } },
      required: ["number"]
    }
  },
  {
    name: "pr_update",
    description:
      "Edit a pull request — title, description, base branch — or close/reopen it with `state`. Only the fields you pass are changed.",
    inputSchema: {
      type: "object",
      properties: {
        number: { type: "integer", description: "Pull request number." },
        title: { type: "string" },
        body: { type: "string" },
        base: { type: "string", description: "New base branch." },
        state: { type: "string", description: '"closed" to close it, "open" to reopen.' },
        draft: { type: "boolean" }
      },
      required: ["number"]
    }
  },
  {
    name: "pr_comment",
    description: "Post a comment on a pull request conversation.",
    inputSchema: {
      type: "object",
      properties: {
        number: { type: "integer", description: "Pull request number." },
        body: { type: "string", description: "Markdown comment body." }
      },
      required: ["number", "body"]
    }
  },
  {
    name: "deploy_site",
    description:
      "Deploy this session's work to its Configure My AI cloud machine and serve it at a public " +
      "URL — the platform's way to put work live, with or without a repository. With a linked " +
      "repository the machine pulls the branch from GitHub, so push first (local_push or " +
      "pr_open); without one it deploys the files this session wrote (fenced files included), so " +
      "just call it. A site with an index.html at its root is published automatically; pass " +
      "serve_command for an app that needs its own runtime. Creating the machine bills the " +
      "workspace, so call this only when the user asked for a deploy or agreed to one. The " +
      "response includes the URL; the user manages the machine under Devices → Cloud machines.",
    inputSchema: {
      type: "object",
      properties: {
        branch: {
          type: "string",
          description:
            "Branch to deploy. Defaults to this session's working branch when it exists on GitHub, else the base branch."
        },
        dir: {
          type: "string",
          description: "Folder to publish, relative to the repository root. Default: the repository root."
        },
        serve_command: {
          type: "string",
          description: "Command that starts the app on the machine, binding to `port` — for anything busier than static files."
        },
        port: { type: "integer", description: "Port the server listens on (default 8080)." }
      }
    }
  },
  {
    name: "pr_merge",
    description:
      "Merge a pull request. Only do this when the user has explicitly asked for it — an open PR is normally theirs to merge.",
    inputSchema: {
      type: "object",
      properties: {
        number: { type: "integer", description: "Pull request number." },
        method: { type: "string", description: '"merge" (default), "squash" or "rebase".' },
        title: { type: "string" },
        message: { type: "string" }
      },
      required: ["number"]
    }
  }
]

function operationFor(toolName) {
  return String(toolName).replace("_", ".")
}

// The repositories this session is linked to, when there is more than one.
// Empty for the ordinary single-repo session, which is why `repo` only shows
// up in the tool schemas below when there is genuinely a choice to make.
function linkedRepos() {
  try {
    const raw = process.env.CMA_GITHUB_REPOS
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch (_error) {
    return []
  }
}

// Every operation acts on ONE repository, so each tool grows a `repo`
// argument once the session spans several. Added here rather than written
// into each definition: the answer is the same for all of them, and a schema
// that lists the legal values is the difference between the model choosing
// and the model guessing.
function toolsForSession() {
  const repos = linkedRepos()
  if (repos.length < 2) return TOOLS

  const names = repos.map((r) => r.repo).filter(Boolean)
  const primary = repos.find((r) => r.primary)?.repo || names[0]
  const description =
    `Which linked repository to act on, as "owner/repo" — one of: ${names.join(", ")}. ` +
    `Optional; defaults to ${primary}. A change spanning repositories needs one ` +
    `call per repository, so pass this explicitly rather than relying on the default.`

  return TOOLS.map((tool) => ({
    ...tool,
    inputSchema: {
      ...tool.inputSchema,
      type: "object",
      properties: { ...(tool.inputSchema?.properties || {}), repo: { type: "string", description } }
    }
  }))
}

// The endpoint and token arrive in the environment, put there by the process
// that launched Claude Code for this job. They are never written to disk and
// never passed as arguments, so neither a stray file nor `ps` exposes them.
function connection() {
  const endpoint = (process.env.CMA_GITHUB_ENDPOINT || "").replace(/\/+$/, "")
  const token = process.env.CMA_GITHUB_TOKEN || ""
  if (!endpoint || !token) {
    throw new Error(
      "This session was not given GitHub access. Tell the user that the session " +
        "has no GitHub repository linked, or that GitHub is not connected in Configure My AI."
    )
  }
  return { endpoint, token }
}

// An operation that pushes reaches back out to the machine, which commits and
// talks to a git remote over whatever network a laptop is on. That is minutes
// on a first push of a large tree, not seconds, and cutting it short would
// abandon a push that is going fine. Everything else is one GitHub API call.
const PUSHING_OPERATIONS = new Set(["local_push", "pr_open"])
const TIMEOUT_MS = 60000
const PUSH_TIMEOUT_MS = 240000

async function callOperation(toolName, args) {
  const { endpoint, token } = connection()
  const controller = new AbortController()
  const budget = PUSHING_OPERATIONS.has(toolName) ? PUSH_TIMEOUT_MS : TIMEOUT_MS
  const timer = setTimeout(() => controller.abort(), budget)

  try {
    const response = await fetch(`${endpoint}/${operationFor(toolName)}`, {
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

    // An error from the server is an answer, not a transport failure: it says
    // what to do differently ("push the branch first", "that branch is
    // protected"). Handing it back as tool output lets the model act on it,
    // where throwing would just end the turn.
    if (!response.ok || data?.ok === false) {
      return { ok: false, text: data?.error || `Request failed (${response.status})` }
    }

    return { ok: true, text: JSON.stringify(data, null, 2) }
  } finally {
    clearTimeout(timer)
  }
}

// ---------------------------------------------------------------------------
// JSON-RPC over stdio. Small enough to hand-roll, and hand-rolling it keeps
// the companion dependency-free — which is the reason it installs anywhere
// Node runs without a build step.
// ---------------------------------------------------------------------------

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function respond(id, result) {
  write({ jsonrpc: "2.0", id, result })
}

function respondError(id, code, message) {
  write({ jsonrpc: "2.0", id, error: { code, message } })
}

// One rpc loop for every server the companion mounts. `spec` carries what
// differs — the name Claude Code sees, the tool list, and how a call is
// executed — so the web server (mcp_web.js) is a spec, not a second copy of
// this file that can drift.
function makeHandler(spec) {
  return async function handle(request) {
    const { id, method, params } = request

    switch (method) {
      case "initialize":
        respond(id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: spec.name, version: "1" }
        })
        return

      // Notifications carry no id and take no reply.
      case "notifications/initialized":
      case "notifications/cancelled":
        return

      case "tools/list":
        respond(id, { tools: spec.list() })
        return

      case "tools/call": {
        const name = params?.name
        const tool = spec.tools.find((t) => t.name === name)
        if (!tool) {
          respondError(id, -32602, `Unknown tool ${name}`)
          return
        }

        try {
          const result = await spec.call(name, params?.arguments)
          respond(id, {
            content: [{ type: "text", text: result.text }],
            isError: !result.ok
          })
        } catch (error) {
          respond(id, {
            content: [{ type: "text", text: String(error?.message || error) }],
            isError: true
          })
        }
        return
      }

      case "ping":
        respond(id, {})
        return

      default:
        if (id !== undefined) respondError(id, -32601, `Method not found: ${method}`)
    }
  }
}

export async function serveMcp(spec) {
  const handle = makeHandler(spec)
  const rl = createInterface({ input: process.stdin })

  for await (const line of rl) {
    const trimmed = line.trim()
    if (!trimmed) continue

    let request = null
    try {
      request = JSON.parse(trimmed)
    } catch (_error) {
      continue
    }

    try {
      await handle(request)
    } catch (error) {
      if (request?.id !== undefined) {
        respondError(request.id, -32603, String(error?.message || error))
      }
    }
  }

  return 0
}

export async function serve() {
  return serveMcp({
    name: "cma_github",
    tools: TOOLS,
    list: toolsForSession,
    call: callOperation
  })
}

export { TOOLS, operationFor }
