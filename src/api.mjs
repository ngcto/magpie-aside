const DEFAULT_BASE_URL = "https://api.aside.com"
const RETRY_STATUSES = new Set([408, 429])

export class AsideApiError extends Error {
  constructor(status, message, code = "ASIDE_API_ERROR", details) {
    super(message)
    this.name = "AsideApiError"
    this.status = status
    this.code = code
    this.details = details
  }
}

function record(value) {
  return value !== null && typeof value === "object" ? value : undefined
}

export function apiError(status, details, fallback = "Aside API request failed.") {
  const body = record(details)
  const inner = record(body?.error)
  const nested = record(inner?.error)
  const code = [body?.code, inner?.code, inner?.errorCode, nested?.code]
    .find((value) => typeof value === "string" && value.trim()) ?? "ASIDE_API_ERROR"
  const message = [body?.error, inner?.error, inner?.message, nested?.message, body?.message, details]
    .find((value) => typeof value === "string" && value.trim() && !/^\s*<(?:!doctype|html)/i.test(value)) ?? fallback
  return new AsideApiError(status, message, code, details)
}

export async function errorDetails(response) {
  if (response.ok) return null
  const text = await response.clone().text()
  let body = text
  try { body = text ? JSON.parse(text) : null } catch {}
  return apiError(response.status, body)
}

export async function responseJSON(response) {
  const text = await response.text()
  let body
  try { body = text ? JSON.parse(text) : null } catch {
    if (!response.ok) throw apiError(response.status, text)
    throw new AsideApiError(502, "Aside API returned an invalid response.", "ASIDE_API_INVALID_RESPONSE")
  }
  if (!response.ok) throw apiError(response.status, body)
  return body
}

export function sleep(ms, signal) {
  if (signal?.aborted) return Promise.reject(signal.reason)
  return new Promise((resolve, reject) => {
    const done = () => { signal?.removeEventListener("abort", abort); resolve() }
    const timer = setTimeout(done, ms)
    const abort = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(signal.reason) }
    signal?.addEventListener("abort", abort, { once: true })
  })
}

export function createApi({ baseURL = DEFAULT_BASE_URL, fetchImpl = globalThis.fetch, now = Date.now, sleep: wait = sleep } = {}) {
  const base = new URL(baseURL)
  if (!["http:", "https:"].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
    throw new Error("Aside API URL must be an HTTP(S) URL without credentials, a query, or a fragment.")
  }
  baseURL = base.href.replace(/\/$/, "")

  async function request(path, { method = "GET", body, headers, signal, timeoutMs = 20000, timeoutScope = "headers", retry = 0 } = {}) {
    const url = new URL(path, `${baseURL}/`)
    if (url.origin !== base.origin) throw new Error("An Aside request cannot leave the configured API origin.")
    const outgoing = new Headers(headers)
    const jsonBody = body !== undefined && body !== null && typeof body === "object" &&
      !(body instanceof FormData) && !(body instanceof Blob) &&
      !(body instanceof ArrayBuffer) && !ArrayBuffer.isView(body) && !(body instanceof URLSearchParams)
    if (jsonBody) {
      if (!outgoing.has("content-type")) outgoing.set("content-type", "application/json")
      body = JSON.stringify(body)
    }
    for (let attempt = 0; ; attempt++) {
      signal?.throwIfAborted()
      const controller = timeoutMs > 0 && timeoutScope === "headers" ? new AbortController() : undefined
      const timer = controller ? setTimeout(() => controller.abort(new DOMException("Request timed out", "TimeoutError")), timeoutMs) : undefined
      const deadline = controller?.signal ?? (timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined)
      const combined = signal && deadline ? AbortSignal.any([signal, deadline]) : signal ?? deadline
      let response
      try {
        response = await fetchImpl(url.href, { method, headers: outgoing, body, signal: combined, redirect: "error" })
      } catch (error) {
        if (signal?.aborted) throw signal.reason
        if (attempt < retry) { await wait(1000, signal); continue }
        if (deadline?.aborted) {
          throw new AsideApiError(504, "Aside servers didn't respond in time. Check your connection and try again.", "ASIDE_API_TIMEOUT")
        }
        throw error
      } finally {
        clearTimeout(timer)
      }
      if (attempt >= retry || !(RETRY_STATUSES.has(response.status) || response.status >= 500)) return response
      await response.body?.cancel()
      await wait(1000, signal)
    }
  }

  async function json(path, options = {}) {
    try {
      return await responseJSON(await request(path, { retry: 2, ...options }))
    } catch (error) {
      if (error instanceof AsideApiError || options.signal?.aborted) throw error
      if (error?.name === "AbortError" || error?.name === "TimeoutError") {
        throw new AsideApiError(504, "Aside servers didn't respond in time. Check your connection and try again.", "ASIDE_API_TIMEOUT")
      }
      throw new AsideApiError(503, "Aside couldn't connect from this network.", "ASIDE_API_ERROR", error)
    }
  }

  return { baseURL, fetchImpl, now, sleep: wait, request, json }
}
