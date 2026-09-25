// What a cloud machine says about the SUBSCRIPTION it runs on.
//
// On a laptop the vendor's words land in a terminal in front of the person.
// On a machine Configure My AI runs for them, nobody is reading the terminal
// — so every failure a run or a probe produces is classified here, in the
// vendor's own words, into one of a handful of states the web app can turn
// back into a sentence and a button. The vocabulary is shared with the
// server (CloudCompanions::SubscriptionStatus); add a state in both places.
//
// Pure on purpose: no I/O, no imports from the rest of the companion, so the
// runner, the profile scan and the tests can all use it without a cycle.

export function isHosted() {
  return /^(1|true|yes)$/i.test(String(process.env.CMA_HOSTED || ""))
}

export function hostedRuntimeId() {
  return String(process.env.CMA_HOSTED_RUNTIME || "").trim() || null
}

export const LOGIN_KINDS = new Set(["login.start", "login.code", "login.cancel"])

// First match wins, so the order is the order of specificity: a billing
// refusal that also mentions a limit is a billing refusal; a rate limit that
// also says "try again" is a rate limit; and only a message about nothing
// else is a login problem, because nearly every vendor error mentions
// authentication somewhere.
const RULES = [
  ["payment", /billing|payment (method|failed|required)|card (was )?declined|past due|unpaid|purchase (more|credits|a plan)|subscription (is |has )?(expired|required|inactive|cancel|lapsed)/i],
  ["account", /suspended|disabled|banned|deactivated|not eligible|not available in your (country|region)|organi[sz]ation has been|account has been|violat(ed|ion of) (the )?(terms|policy|usage polic)/i],
  ["quota", /out of credits|insufficient credit|credit balance|usage credits (are )?(exhausted|used)|quota (has been )?exceeded|exhausted|no remaining|extra usage|spending (limit|cap)|budget (has been )?(reached|exceeded)/i],
  ["rate_limited", /rate.?limit|too many requests|\b429\b|usage limit|limit (has been )?reached|hit your limit|reached your limit|resets? (at|in) |try again (later|in )|overloaded|at capacity|capacity constraints/i],
  ["needs_login", /log ?in|sign ?in|unauthori[sz]ed|\b401\b|authenticat|invalid api key|api key|expired|credential|not authenticated|oauth|token (is |was )?(invalid|expired|revoked|missing)|needs signing in|forbidden|\b403\b/i],
  ["unreachable", /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ECONNRESET|EAI_AGAIN|EHOSTUNREACH|network (error|is|was)|fetch failed|could not connect|connection (refused|reset|failed|closed)|\b50[234]\b|service unavailable|temporarily unavailable|timed out/i]
]

// { state, detail } for a message that says something about the plan, or
// null for one that does not — a syntax error in the prompt, a killed
// process, an empty answer say nothing about the subscription, and a wrong
// verdict there would send someone to sign in again for no reason.
export function classifySubscription(message) {
  const text = String(message || "").replace(/\s+/g, " ").trim()
  if (!text) return null

  for (const [state, pattern] of RULES) {
    if (pattern.test(text)) return { state, detail: text.slice(0, 300) }
  }
  return null
}

// A login probe's result as a subscription verdict. "ready" is a working
// subscription — a probe is a real request and it answered — and "logged
// out" needs a sign-in; anything else is classified from the words the
// vendor used, or left unsaid.
export function subscriptionFromProbe(probe) {
  if (!probe || typeof probe !== "object") return null
  if (probe.status === "ready") return { state: "connected" }
  if (probe.status === "logged_out") return { state: "needs_login", detail: String(probe.detail || "").slice(0, 300) || undefined }
  if (probe.status === "not_installed") return null

  return classifySubscription(probe.detail)
}
