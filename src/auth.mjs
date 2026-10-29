import { randomUUID } from "node:crypto"
import { createServer } from "node:http"
import { AsideApiError, DEFAULT_BASE_URL } from "./api.mjs"
import { createCredentialIdentity } from "./device.mjs"

export const GOOGLE_CALLBACK_HOST = "127.0.0.1"
export const GOOGLE_CALLBACK_PORT = 21420
export const GOOGLE_OAUTH_TTL_MS = 600000

const EXPIRED_ATTEMPT = "Google sign-in attempt expired. Start again."
const COMPLETING_ATTEMPT = "Google sign-in is already being completed."
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const MAX_CALLBACK_BODY_BYTES = 65536
const CALLBACK_SOCKET_TIMEOUT_MS = 10000
const ASIDE_ORIGINS = new Set([DEFAULT_BASE_URL, "https://api.aside.com"])
const CONFLICT_CODES = new Set([
  "ASIDE_PROFILE_ALREADY_BOUND_TO_DIFFERENT_ACCOUNT",
  "ASIDE_LOCAL_ACCOUNT_ALREADY_SIGNED_IN",
])

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function nonempty(value) {
  return typeof value === "string" && value.trim().length > 0
}

function failure(error) {
  return { type: "failed", error: error instanceof Error ? error.message : "Aside sign-in failed." }
}

function invalidResponse() {
  return new AsideApiError(502, "Aside API returned an invalid sign-in response.", "ASIDE_API_INVALID_RESPONSE")
}

function signInResult(tokens, identity, loginMethod, now, expectedEmail) {
  if (!record(tokens) || !record(tokens.user) || !nonempty(tokens.accessToken) ||
      !nonempty(tokens.refreshToken) || !Number.isSafeInteger(tokens.expiresIn) || tokens.expiresIn <= 0 ||
      !nonempty(tokens.user.id) || typeof tokens.user.email !== "string" || !EMAIL.test(tokens.user.email) ||
      !(tokens.user.onboardingCompletedAt === null || typeof tokens.user.onboardingCompletedAt === "string") ||
      !(tokens.provider === undefined || tokens.provider === "email" || tokens.provider === "google")) {
    throw invalidResponse()
  }
  if (loginMethod === "google" && tokens?.provider !== "google") {
    throw new Error("Unexpected Google sign-in response.")
  }
  if (expectedEmail && tokens.user.email.toLowerCase() !== expectedEmail.toLowerCase()) {
    throw new Error("Aside returned a different account from the email being verified. Start sign-in again.")
  }
  const expires = now() + tokens.expiresIn * 1000
  if (!Number.isSafeInteger(expires)) throw invalidResponse()
  return {
    type: "success",
    refresh: tokens.refreshToken,
    access: tokens.accessToken,
    expires,
    accountId: tokens.user.email,
    uid: tokens.user.id,
    loginMethod,
    onboardingCompletedAt: tokens.user.onboardingCompletedAt,
    ...identity,
  }
}

async function startGoogleSignIn(api, identity, oauthAttemptId, signal) {
  // The attempt ID goes to Aside; its separate opaque ticket stays with this authorization.
  const started = await api.json("/auth/oauth/google/start", {
    method: "POST",
    signal,
    body: { accountId: identity.asideAccountId, oauthAttemptId },
  })
  if (!record(started) || !nonempty(started.oauthAttemptToken) || typeof started.url !== "string") {
    throw invalidResponse()
  }
  let url
  try { url = new URL(started.url) } catch { throw invalidResponse() }
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) throw invalidResponse()
  url.searchParams.set("prompt", "select_account")
  return { url: url.toString(), oauthAttemptToken: started.oauthAttemptToken }
}

function exchangeGoogleToken(api, identity, oauthAttemptToken, supabaseAccessToken, signal) {
  return api.json("/auth/token/exchange", {
    method: "POST",
    signal,
    body: {
      authProtocol: 2,
      accountId: identity.asideAccountId,
      supabaseAccessToken,
      device: identity.asideDevice,
      oauthAttemptToken,
    },
  })
}

export function isAllowedCallbackOrigin(origin) {
  if (ASIDE_ORIGINS.has(origin)) return true
  try {
    const url = new URL(origin)
    return url.origin === origin && ["http:", "https:"].includes(url.protocol) &&
      ["localhost", "127.0.0.1"].includes(url.hostname)
  } catch {
    return false
  }
}

function applyCors(request, response) {
  const origin = request.headers.origin
  if (!origin || !isAllowedCallbackOrigin(origin)) return
  response.setHeader("Access-Control-Allow-Origin", origin)
  response.setHeader("Vary", "Origin, Access-Control-Request-Private-Network")
  response.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS")
  response.setHeader("Access-Control-Allow-Headers", "Content-Type")
  if (request.headers["access-control-request-private-network"]?.toLowerCase() === "true") {
    response.setHeader("Access-Control-Allow-Private-Network", "true")
  }
}

function reply(response, status, body) {
  if (response.destroyed || response.writableEnded) return
  response.statusCode = status
  response.setHeader("Cache-Control", "no-store")
  response.setHeader("Connection", "close")
  if (body === undefined) response.end()
  else {
    response.setHeader("Content-Type", "application/json; charset=utf-8")
    response.end(JSON.stringify(body))
  }
}

function readCallbackBody(request) {
  return new Promise((resolve, reject) => {
    let size = 0
    let chunks = []
    let settled = false
    request.on("data", (chunk) => {
      if (settled) return
      size += chunk.length
      if (size > MAX_CALLBACK_BODY_BYTES) {
        settled = true
        chunks = []
        reject(new AsideApiError(413, "Invalid request"))
        return
      }
      chunks.push(chunk)
    })
    request.once("end", () => {
      if (settled) return
      settled = true
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))) }
      catch { reject(new AsideApiError(400, "Invalid request")) }
      chunks = []
    })
    const interrupted = () => {
      if (settled) return
      settled = true
      chunks = []
      reject(new AsideApiError(400, "Invalid request"))
    }
    request.once("aborted", interrupted)
    request.once("error", interrupted)
  })
}

function loopbackRequest(request, port) {
  const address = request.socket.remoteAddress
  if (address !== "127.0.0.1" && address !== "::ffff:127.0.0.1") return false
  try {
    const host = new URL(`http://${request.headers.host}`)
    return ["127.0.0.1", "localhost"].includes(host.hostname) &&
      Number(host.port || 80) === port && !host.username && !host.password &&
      host.pathname === "/" && !host.search && !host.hash
  } catch {
    return false
  }
}

function occupiedPort(error, port) {
  if (error?.code !== "EADDRINUSE") return error
  const result = new Error(
    `Google sign-in needs ${GOOGLE_CALLBACK_HOST}:${port}, but that port is already in use. ` +
    "Close Aside or the other process using this port, then start Google sign-in again. " +
    "Email sign-in does not need a local callback port.",
    { cause: error },
  )
  result.code = "EADDRINUSE"
  return result
}

// The hosted Aside callback has a fixed loopback destination. Port/timeout injection is
// internal test support, not an alternative OAuth handoff or a backend redirect setting.
export async function createGoogleCallbackReceiver({
  api, identity, oauthAttemptId, port = GOOGLE_CALLBACK_PORT, timeoutMs = GOOGLE_OAUTH_TTL_MS,
}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid callback port.")
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error("Invalid callback timeout.")
  if (typeof oauthAttemptId !== "string" || !UUID.test(oauthAttemptId)) throw new Error("Invalid OAuth attempt ID.")

  const server = createServer()
  const sockets = new Set()
  const abort = new AbortController()
  let credential = identity
  let oauthAttemptToken
  let phase = "starting"
  let expiresAt
  let timer
  let activeResponse
  let resolveResult
  let rejectListen
  let listening = false
  const result = new Promise((resolve) => { resolveResult = resolve })

  const trackConnection = (socket) => {
    sockets.add(socket)
    socket.once("close", () => sockets.delete(socket))
  }
  server.on("connection", trackConnection)
  server.requestTimeout = CALLBACK_SOCKET_TIMEOUT_MS
  server.headersTimeout = CALLBACK_SOCKET_TIMEOUT_MS
  server.setTimeout(CALLBACK_SOCKET_TIMEOUT_MS, (socket) => socket.destroy())

  function finish(value, response) {
    if (phase === "terminal") return result
    phase = "terminal"
    oauthAttemptToken = undefined
    credential = undefined
    clearTimeout(timer)
    abort.abort(new Error(value.type === "failed" ? value.error : "Google sign-in completed."))
    const keep = response?.socket
    keep?.setTimeout(CALLBACK_SOCKET_TIMEOUT_MS)
    server.close(() => {
      server.off("request", handleRequest)
      server.off("connection", trackConnection)
      server.off("error", serverError)
      resolveResult(value)
    })
    for (const socket of sockets) {
      if (socket !== keep) socket.destroy()
    }
    server.closeIdleConnections?.()
    return result
  }

  function expire(response) {
    if (response) reply(response, 409, { error: EXPIRED_ATTEMPT })
    return finish(failure(new Error(EXPIRED_ATTEMPT)), response)
  }

  async function handleRequest(request, response) {
    applyCors(request, response)
    if (!loopbackRequest(request, port) ||
        (request.headers.origin !== undefined && !isAllowedCallbackOrigin(request.headers.origin))) {
      request.resume()
      reply(response, 403, { error: "Forbidden" })
      return
    }
    const path = request.url?.split("?", 1)[0]
    if (path !== "/auth/callback/exchange" && path !== "/auth/callback/report") {
      request.resume()
      reply(response, 404, { error: "Not found" })
      return
    }
    if (request.method === "OPTIONS") {
      request.resume()
      reply(response, 204)
      return
    }
    if (request.method !== "POST") {
      request.resume()
      response.setHeader("Allow", "POST, OPTIONS")
      reply(response, 405, { error: "Method not allowed" })
      return
    }

    let body
    try { body = await readCallbackBody(request) }
    catch (error) {
      reply(response, error instanceof AsideApiError ? error.status : 400, { error: "Invalid request" })
      return
    }
    if (!record(body) || !Number.isSafeInteger(body.accountId) || body.accountId < 0 ||
        typeof body.oauthAttemptId !== "string" || !UUID.test(body.oauthAttemptId) ||
        body.flow !== undefined ||
        (path === "/auth/callback/exchange" ? !nonempty(body.supabaseAccessToken) :
          !nonempty(body.error) || (body.code !== undefined && !nonempty(body.code)))) {
      reply(response, 400, { error: "Invalid request" })
      return
    }
    if (phase === "terminal" || body.accountId !== credential?.asideAccountId || body.oauthAttemptId !== oauthAttemptId) {
      reply(response, 409, { error: EXPIRED_ATTEMPT })
      return
    }
    if (phase === "exchanging") {
      reply(response, 409, { error: COMPLETING_ATTEMPT })
      return
    }
    if (api.now() >= expiresAt) {
      await expire(response)
      return
    }
    if (phase !== "ready") {
      reply(response, 409, { error: EXPIRED_ATTEMPT })
      return
    }
    if (path === "/auth/callback/report") {
      reply(response, 200, { success: true })
      await finish(failure(new Error(body.error)), response)
      return
    }

    phase = "exchanging"
    activeResponse = response
    // Header/body deadlines must not cut off a valid exchange while the API is responding.
    request.socket.setTimeout(0)
    try {
      const tokens = await exchangeGoogleToken(
        api, credential, oauthAttemptToken, body.supabaseAccessToken, abort.signal,
      )
      if (phase === "terminal") return
      const completed = signInResult(tokens, credential, "google", api.now)
      // Mirror Aside's token-free local callback response, not its remote token payload.
      reply(response, 200, {
        accountId: credential.asideAccountId,
        email: tokens.user.email,
        success: true,
        userId: tokens.user.id,
      })
      await finish(completed, response)
    } catch (error) {
      if (phase === "terminal") return
      const failed = failure(error)
      const conflict = error instanceof AsideApiError && CONFLICT_CODES.has(error.code)
      reply(response, conflict ? 409 : 500, {
        ...(conflict ? { code: error.code } : {}),
        error: failed.error,
      })
      await finish(failed, response)
    } finally {
      activeResponse = undefined
      body = undefined
    }
  }

  function serverError(error) {
    if (!listening) rejectListen?.(occupiedPort(error, port))
    else {
      const failed = failure(error)
      if (activeResponse) reply(activeResponse, 500, { error: failed.error })
      void finish(failed, activeResponse)
    }
  }
  server.on("error", serverError)
  server.on("request", handleRequest)
  try {
    await new Promise((resolve, reject) => {
      rejectListen = reject
      server.once("listening", () => { listening = true; resolve() })
      server.listen({ host: GOOGLE_CALLBACK_HOST, port, exclusive: true })
    })
    if (phase === "terminal") throw abort.signal.reason
    port = server.address().port
    expiresAt = api.now() + timeoutMs
    timer = setTimeout(() => {
      if (activeResponse) reply(activeResponse, 500, { error: EXPIRED_ATTEMPT })
      void finish(failure(new Error(EXPIRED_ATTEMPT)), activeResponse)
    }, timeoutMs)
    timer.unref?.()
  } catch (error) {
    await finish(failure(error))
    throw error
  }

  return {
    port,
    signal: abort.signal,
    result,
    activate(token) {
      if (phase !== "starting" || api.now() >= expiresAt) throw new Error(EXPIRED_ATTEMPT)
      if (!nonempty(token)) throw invalidResponse()
      oauthAttemptToken = token
      phase = "ready"
    },
    close(error = new Error("Google sign-in cancelled.")) {
      if (activeResponse) reply(activeResponse, 500, { error: failure(error).error })
      return finish(failure(error), activeResponse)
    },
  }
}

export function createAuthMethods({
  api, createIdentity = createCredentialIdentity,
  callbackPort = GOOGLE_CALLBACK_PORT, callbackTimeoutMs = GOOGLE_OAUTH_TTL_MS,
}) {
  return [
    {
      type: "oauth",
      label: "Sign in with email code",
      prompts: [{
        type: "text",
        key: "email",
        message: "Aside email address",
        placeholder: "you@example.com",
        validate(value) {
          return typeof value === "string" && EMAIL.test(value.trim()) ? undefined : "Enter a valid email address."
        },
      }],
      async authorize(inputs) {
        const email = typeof inputs?.email === "string" ? inputs.email.trim() : ""
        if (!EMAIL.test(email)) throw new Error("Enter a valid email address.")
        const identity = await createIdentity()
        const started = await api.json("/auth/email/start", {
          method: "POST",
          body: { email, accountId: identity.asideAccountId, intent: "start" },
        })
        if (!record(started) || typeof started.email !== "string" || !EMAIL.test(started.email) ||
            started.requiresEmailVerification !== true) throw invalidResponse()
        const normalizedEmail = started.email
        let completion
        return {
          url: "",
          method: "code",
          instructions: `Enter the six-digit verification code sent to ${normalizedEmail}. Use the code, not the email link.`,
          callback(code) {
            if (completion) return completion
            completion = (async () => {
              const value = typeof code === "string" ? code.trim() : ""
              if (!/^\d{6}$/.test(value)) {
                return failure(new Error("Enter the six-digit code from your Aside email."))
              }
              try {
                const tokens = await api.json("/auth/email/verify-code", {
                  method: "POST",
                  body: {
                    accountId: identity.asideAccountId,
                    email: normalizedEmail,
                    code: value,
                    device: identity.asideDevice,
                  },
                })
                return signInResult(tokens, identity, "email", api.now, normalizedEmail)
              } catch (error) {
                return failure(error)
              }
            })()
            return completion
          },
        }
      },
    },
    {
      type: "oauth",
      label: "Sign in with Google",
      async authorize() {
        const identity = await createIdentity()
        const oauthAttemptId = randomUUID()
        const receiver = await createGoogleCallbackReceiver({
          api, identity, oauthAttemptId, port: callbackPort, timeoutMs: callbackTimeoutMs,
        })
        try {
          let started = await startGoogleSignIn(api, identity, oauthAttemptId, receiver.signal)
          const url = started.url
          receiver.activate(started.oauthAttemptToken)
          started = undefined
          return {
            url,
            method: "auto",
            instructions: "Complete Google sign-in in your browser. Allow local network access if Aside asks, then return to Magpie. " +
              "Google sign-in expires after ten minutes; the hosted Aside callback connects to 127.0.0.1:21420.",
            callback() { return receiver.result },
          }
        } catch (error) {
          await receiver.close(error)
          throw error
        }
      },
    },
  ]
}
