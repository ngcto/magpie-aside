import { createHash, randomUUID } from "node:crypto"
import os from "node:os"
import { AsideApiError } from "./api.mjs"
import { supportsSampling } from "./catalog.mjs"

const THINKING_BUDGETS = { minimal: 1024, low: 2048, medium: 8192, high: 16384, xhigh: 16384, max: 16384 }

function normalizePlatform(platform) {
  platform = platform.toLowerCase()
  if (platform.includes("ios")) return "iOS"
  return ({ android: "Android", darwin: "MacOS", win32: "Windows", freebsd: "FreeBSD", openbsd: "OpenBSD", linux: "Linux" })[platform] ?? (platform ? `Other:${platform}` : "Unknown")
}
function normalizeArch(arch) {
  if (arch === "x86_64" || arch === "x64") return "x64"
  if (arch === "aarch64" || arch === "arm64") return "arm64"
  if (arch === "x32" || arch === "arm") return arch
  return arch ? `other:${arch}` : "unknown"
}

// A credential's random identity namespaces gateway conversations, including after a host restart.
export function accountSessionId(auth, externalId) {
  return createHash("sha256").update(auth.credentialId).update("\0").update(String(externalId)).digest("base64url").slice(0, 21)
}

function userText(body) {
  if (typeof body.input === "string") return body.input
  const messages = body.messages ?? body.input ?? []
  const user = Array.isArray(messages) ? messages.find((message) => message.role === "user") : undefined
  if (typeof user?.content === "string") return user.content
  if (!Array.isArray(user?.content)) return ""
  return user.content.filter((part) => part.type === "text" || part.type === "input_text").map((part) => part.text ?? "").join("\n")
}

export function modelHeaders(auth, { model, protocol, body, sessionId, title, fastMode }) {
  const anthropic = protocol === "anthropic-messages"
  // These are the shipped SDK's names and detection algorithms, not a plugin User-Agent.
  const headers = new Headers({
    "content-type": "application/json",
    accept: "application/json",
    "user-agent": `pi (${os.platform()} ${os.release()}; ${os.arch()})`,
    "x-stainless-lang": "js",
    "x-stainless-package-version": anthropic ? "0.124.0" : "6.40.0",
    "x-stainless-os": normalizePlatform(process.platform),
    "x-stainless-arch": normalizeArch(process.arch),
    "x-stainless-runtime": "node",
    "x-stainless-runtime-version": process.version,
    "x-stainless-retry-count": "0",
    "x-aside-provider": "true",
    "x-aside-fast-mode": fastMode ? "true" : "false",
    "x-aside-model-id": model.id,
    "x-aside-model-provider": "aside",
    "x-aside-session-id": sessionId,
    "x-aside-session-title": encodeURIComponent(title.slice(0, 500)),
    "x-aside-provider-session-id": sessionId,
    "x-aside-account-id": String(auth.asideAccountId),
  })
  if (anthropic) {
    headers.set("x-api-key", auth.access)
    headers.set("anthropic-version", "2023-06-01")
    headers.set("anthropic-dangerous-direct-browser-access", "true")
    headers.set("x-stainless-timeout", "600")
    if (body.thinking?.type === "enabled" && model.reasoning) {
      headers.set("anthropic-beta", "interleaved-thinking-2025-05-14")
    }
  } else {
    headers.set("authorization", `Bearer ${auth.access}`)
    if (protocol === "openai-responses") {
      headers.set("session_id", sessionId)
      headers.set("x-client-request-id", sessionId)
    }
  }
  return headers
}

export function prepareModelRequest(body, model, protocol, auth, incomingHeaders, requestedFast, subscriptionPlan = auth.subscriptionPlan) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new AsideApiError(400, "Expected a JSON model request.")
  const externalId = new Headers(incomingHeaders).get("x-aside-session-id") || randomUUID()
  const sessionId = accountSessionId(auth, externalId)
  const title = userText(body)
  const fastMode = requestedFast ?? (body.speed === "fast" || body.service_tier === "priority")
  if (fastMode && (!model.supportsFastMode || !["pro", "max"].includes(subscriptionPlan))) {
    throw new AsideApiError(400, "This Aside model or plan does not offer Fast mode.", "ASIDE_FAST_MODE_UNAVAILABLE")
  }

  if (protocol === "anthropic-messages") {
    delete body.betas
    if (body.thinking?.type === "adaptive") {
      const budget = THINKING_BUDGETS[body.output_config?.effort] ?? THINKING_BUDGETS.high
      const max = body.max_tokens ?? model.maxTokens
      if (max <= 1024) throw new AsideApiError(400, "Aside's budgeted thinking needs max_tokens greater than 1024.")
      body.thinking = { type: "enabled", budget_tokens: Math.min(budget, max - 1), display: "summarized" }
      if (body.output_config) {
        delete body.output_config.effort
        if (!Object.keys(body.output_config).length) delete body.output_config
      }
    } else if (body.thinking?.type === "enabled") {
      body.thinking.display ??= "summarized"
    }
    if (body.thinking?.type === "enabled") delete body.temperature
    if (Array.isArray(body.tools)) for (const tool of body.tools) {
      if (tool.type === undefined || tool.type === "custom") {
        tool.eager_input_streaming = true
        delete tool.strict
      }
    }
    delete body.service_tier
    if (fastMode) body.speed = "fast"
    return { path: "/ai/v1/messages?beta=true", body, sessionId, title, fastMode }
  }

  const effort = protocol === "openai-responses" ? body.reasoning?.effort : body.reasoning_effort
  if (!supportsSampling(model, effort)) {
    delete body.temperature
    delete body.top_p
    delete body.top_logprobs
    if (protocol === "openai-responses") {
      if (Array.isArray(body.include) && body.include.includes("message.output_text.logprobs")) {
        body.include = body.include.filter((value) => value !== "message.output_text.logprobs")
      }
    } else {
      delete body.logprobs
    }
  }

  const messages = protocol === "openai-responses" ? body.input : body.messages
  if (Array.isArray(messages)) for (const message of messages) {
    if (message.role === "developer") message.role = "system"
  }
  if (protocol === "openai-responses") {
    body.store = false
    body.prompt_cache_key = sessionId.slice(0, 64)
    if (body.max_output_tokens !== undefined) body.max_output_tokens = Math.max(body.max_output_tokens, 16)
    if (body.reasoning?.effort === "off") body.reasoning.effort = "none"
    if (body.reasoning && body.reasoning.effort !== "none") {
      body.reasoning.summary ??= "auto"
      body.include = [...new Set([...(body.include ?? []), "reasoning.encrypted_content"])]
    }
    if (fastMode) body.service_tier = "priority"
    delete body.speed
    return { path: "/ai/v1/responses", body, sessionId, title, fastMode }
  }
  delete body.store
  if (body.max_tokens !== undefined) {
    body.max_completion_tokens ??= body.max_tokens
    delete body.max_tokens
  }
  if (body.stream) body.stream_options = { ...body.stream_options, include_usage: true }
  if (body.reasoning_effort === "off") body.reasoning_effort = "none"
  if (body.tools === undefined && body.messages?.some((message) => message.tool_calls?.length)) body.tools = []
  delete body.speed
  delete body.service_tier
  return { path: "/ai/v1/chat/completions", body, sessionId, title, fastMode }
}

export function errorResponse(error, protocol = "openai-completions") {
  const status = error instanceof AsideApiError ? error.status : 500
  const message = error instanceof Error ? error.message : "Aside request failed."
  const headers = error?.signIn === "expired" ? { "X-Magpie-Sign-In": "expired" } : undefined
  if (protocol === "anthropic-messages") {
    const type = status === 401 || status === 403 ? "authentication_error" : status === 429 ? "rate_limit_error" : status >= 500 ? "api_error" : "invalid_request_error"
    return Response.json({ type: "error", error: { type, message } }, { status, headers })
  }
  return Response.json({ error: { message, type: status >= 500 ? "server_error" : "invalid_request_error", code: error?.code ?? "ASIDE_API_ERROR" } }, { status, headers })
}
