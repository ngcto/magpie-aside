import { describe, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { createServer } from "node:http"
import { createApi } from "../src/api.mjs"
import { createCredentialIdentity } from "../src/device.mjs"
import {
  createAuthMethods, createGoogleCallbackReceiver, GOOGLE_OAUTH_TTL_MS,
} from "../src/auth.mjs"

const ORIGIN = "https://api.aside.com"
const NOW = 1700000000000

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
}

function tokens(provider = "google", email = "person@example.com") {
  return {
    provider,
    accessToken: `aside-access-${provider}`,
    refreshToken: `aside-refresh-${provider}`,
    expiresIn: 3600,
    user: { id: `user-${email}`, email, onboardingCompletedAt: null },
  }
}

async function listener(port = 0) {
  const server = createServer((_request, response) => { response.writeHead(204); response.end() })
  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen({ host: "127.0.0.1", port }, () => { server.off("error", reject); resolve() })
  })
  return { server, port: server.address().port }
}

async function close(server) {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
}

async function unusedPort() {
  const held = await listener()
  await close(held.server)
  return held.port
}

async function expectPortClosed(port) {
  const rebound = await listener(port)
  await close(rebound.server)
}

function post(port, path, body, origin = ORIGIN) {
  return fetch(`http://127.0.0.1:${port}/auth/callback/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(origin === undefined ? {} : { Origin: origin }) },
    body: typeof body === "string" ? body : JSON.stringify(body),
  })
}

async function receiver({ api, identity, oauthAttemptId, port = 0, timeoutMs } = {}) {
  identity ??= await createCredentialIdentity()
  oauthAttemptId ??= randomUUID()
  api ??= createApi({ now: () => NOW, fetchImpl: async () => json(tokens()) })
  const local = await createGoogleCallbackReceiver({ api, identity, oauthAttemptId, port, timeoutMs })
  local.activate("server-issued-opaque-attempt-token")
  return { ...local, identity, oauthAttemptId }
}

function callbackBody(local, extra = {}) {
  return {
    accountId: local.identity.asideAccountId,
    oauthAttemptId: local.oauthAttemptId,
    supabaseAccessToken: "supabase-token-for-this-attempt",
    ...extra,
  }
}

function expectSavedIdentity(result, identity, method, email = "person@example.com") {
  expect(result).toEqual({
    type: "success",
    refresh: `aside-refresh-${method}`,
    access: `aside-access-${method}`,
    expires: NOW + 3600000,
    accountId: email,
    uid: `user-${email}`,
    loginMethod: method,
    onboardingCompletedAt: null,
    ...identity,
  })
  expect(result).not.toHaveProperty("code")
  expect(result).not.toHaveProperty("supabaseAccessToken")
  expect(result).not.toHaveProperty("oauthAttemptToken")
  expect(result).not.toHaveProperty("oauthAttemptId")
}

async function manualGoogle({
  baseURL = ORIGIN, now = () => NOW, callbackPort, exchange = async () => json(tokens()),
} = {}) {
  let identity
  let oauthAttemptId
  const oauthAttemptToken = `opaque-server-ticket-${randomUUID()}`
  const supabaseAccessToken = `supabase-token-${randomUUID()}`
  const exchanges = []
  const origin = new URL(baseURL).origin
  const api = createApi({ baseURL, now, fetchImpl: async (url, init) => {
    const body = JSON.parse(init.body)
    if (new URL(url).pathname === "/auth/oauth/google/start") {
      oauthAttemptId = body.oauthAttemptId
      return json({
        oauthAttemptToken,
        url: `https://example.supabase.co/auth/v1/authorize?provider=google&redirect_to=${encodeURIComponent(`${origin}/auth/callback?accountId=${body.accountId}&oauthAttemptId=${oauthAttemptId}`)}`,
      })
    }
    if (new URL(url).pathname !== "/auth/token/exchange") return json({ error: "Unknown endpoint." }, 404)
    exchanges.push(body)
    return exchange(body)
  } })
  const authorization = await createAuthMethods({ api, callbackPort, createIdentity: async () => {
    identity = await createCredentialIdentity()
    return identity
  } })[2].authorize()
  const callbackURL = new URL(new URL(authorization.url).searchParams.get("redirect_to"))
  callbackURL.hash = new URLSearchParams({
    access_token: supabaseAccessToken,
    refresh_token: "temporary-supabase-refresh-token",
    token_type: "bearer",
    expires_in: "3600",
  }).toString()
  return { authorization, identity, oauthAttemptId, oauthAttemptToken, supabaseAccessToken, callbackURL, exchanges }
}

describe("email code authentication", () => {
  test("keeps normalized email, leading-zero code and a fresh isolated identity per sign-in", async () => {
    let verifies = 0
    const api = createApi({ now: () => NOW, fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body)
      if (new URL(url).pathname === "/auth/email/start") {
        return json({ email: body.email.toLowerCase(), requiresEmailVerification: true })
      }
      verifies++
      if (body.code !== "012345" || body.email !== body.email.toLowerCase() || !body.device?.ikSigKeyFingerprint) {
        return json({ error: "Invalid verification code or device." }, 400)
      }
      return json({ ...tokens("email", body.email), code: body.code, oauthAttemptToken: "must-not-persist" })
    } })
    const [email] = createAuthMethods({ api })
    const first = await email.authorize({ email: " FIRST@Example.COM " })
    expect(first.url).toBe("")
    expect(first.method).toBe("code")
    const firstPromise = first.callback(" 012345 ")
    const repeated = first.callback("999999")
    const signedIn = await firstPromise
    expect(await repeated).toBe(signedIn)
    expect(verifies).toBe(1)
    expectSavedIdentity(signedIn, {
      credentialId: signedIn.credentialId, asideAccountId: 0, asideDevice: signedIn.asideDevice,
    }, "email", "first@example.com")
    const second = await email.authorize({ email: "second@example.com" })
    const another = await second.callback("012345")
    expect(another.type).toBe("success")
    expect(another.credentialId).not.toBe(signedIn.credentialId)
    expect(another.asideDevice.ikSigKeyFingerprint).not.toBe(signedIn.asideDevice.ikSigKeyFingerprint)
    expect(verifies).toBe(2)
  })

  test("rejects malformed codes without verifying or reusing a terminal attempt", async () => {
    let verifies = 0
    const api = createApi({ fetchImpl: async (url) => {
      if (new URL(url).pathname === "/auth/email/start") {
        return json({ email: "person@example.com", requiresEmailVerification: true })
      }
      verifies++
      return json(tokens("email"))
    } })
    const [email] = createAuthMethods({ api })
    for (const code of ["12345", "12a456", "１２３４５６", 123456]) {
      const attempt = await email.authorize({ email: "person@example.com" })
      const failed = await attempt.callback(code)
      expect(failed.type).toBe("failed")
      expect(failed.error).toContain("six-digit")
      expect(await attempt.callback("012345")).toBe(failed)
      expect(failed).not.toHaveProperty("access")
    }
    expect(verifies).toBe(0)
  })

  test("does not save incomplete tokens or tokens for a different verified email", async () => {
    for (const response of [
      { ...tokens("email"), refreshToken: "" },
      { ...tokens("email"), expiresIn: 0 },
      tokens("email", "another@example.com"),
    ]) {
      const api = createApi({ fetchImpl: async (url) => new URL(url).pathname === "/auth/email/start" ?
        json({ email: "person@example.com", requiresEmailVerification: true }) : json(response) })
      const attempt = await createAuthMethods({ api })[0].authorize({ email: "person@example.com" })
      const failed = await attempt.callback("012345")
      expect(failed.type).toBe("failed")
      expect(failed).not.toHaveProperty("access")
      expect(failed).not.toHaveProperty("refresh")
      expect(failed).not.toHaveProperty("asideDevice")
    }
  })
})

describe("hosted Google callback boundary", () => {
  test("rejects hostile origins, malformed state and stale accounts without consuming the real attempt", async () => {
    let exchanges = 0
    const local = await receiver({ api: createApi({ now: () => NOW, fetchImpl: async () => {
      exchanges++
      return json(tokens())
    } }) })
    let completed = false
    local.result.then(() => { completed = true })
    try {
      const hostile = await post(local.port, "exchange", callbackBody(local), "https://api.aside.com.evil.example")
      expect(hostile.status).toBe(403)
      expect(hostile.headers.get("access-control-allow-origin")).toBeNull()
      const deceptiveLoopback = await post(local.port, "report", {
        accountId: 0, oauthAttemptId: local.oauthAttemptId, error: "forged cancellation",
      }, "http://127.0.0.1:21420@evil.example")
      expect(deceptiveLoopback.status).toBe(403)
      for (const [body, status] of [
        ["{", 400],
        [callbackBody(local, { accountId: "0" }), 400],
        [callbackBody(local, { oauthAttemptId: undefined }), 400],
        [callbackBody(local, { oauthAttemptId: "not-a-uuid" }), 400],
        [callbackBody(local, { flow: "recovery" }), 400],
        [callbackBody(local, { supabaseAccessToken: "" }), 400],
        [callbackBody(local, { accountId: 1 }), 409],
        [callbackBody(local, { oauthAttemptId: randomUUID() }), 409],
      ]) {
        expect((await post(local.port, "exchange", body)).status).toBe(status)
      }
      expect(exchanges).toBe(0)
      expect(completed).toBe(false)
      const success = await post(local.port, "exchange", callbackBody(local))
      expect(success.status).toBe(200)
      expect(await success.json()).toEqual({ accountId: 0, email: "person@example.com", success: true, userId: "user-person@example.com" })
      expectSavedIdentity(await local.result, local.identity, "google")
      expect(exchanges).toBe(1)
      await expectPortClosed(local.port)
    } finally {
      await local.close()
    }
  })

  test("allows only trusted callback CORS and the requested private-network preflight", async () => {
    const local = await receiver()
    try {
      for (const origin of [ORIGIN, "https://api.asidehq.com", "http://localhost:5175", "https://127.0.0.1:4443"]) {
        const response = await fetch(`http://127.0.0.1:${local.port}/auth/callback/exchange`, {
          method: "OPTIONS",
          headers: {
            Origin: origin,
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "content-type",
            "Access-Control-Request-Private-Network": "TrUe",
          },
        })
        expect(response.status).toBe(204)
        expect(response.headers.get("access-control-allow-origin")).toBe(origin)
        expect(response.headers.get("access-control-allow-methods")).toBe("POST,OPTIONS")
        expect(response.headers.get("access-control-allow-headers")).toBe("Content-Type")
        expect(response.headers.get("access-control-allow-private-network")).toBe("true")
        expect(response.headers.get("vary")).toBe("Origin, Access-Control-Request-Private-Network")
      }
      const unrequested = await fetch(`http://127.0.0.1:${local.port}/auth/callback/report`, {
        method: "OPTIONS", headers: { Origin: ORIGIN },
      })
      expect(unrequested.headers.get("access-control-allow-private-network")).toBeNull()
      const untrusted = await fetch(`http://127.0.0.1:${local.port}/auth/callback/exchange`, {
        method: "OPTIONS", headers: { Origin: "null", "Access-Control-Request-Private-Network": "true" },
      })
      expect(untrusted.status).toBe(403)
      expect(untrusted.headers.get("access-control-allow-private-network")).toBeNull()
    } finally {
      await local.close()
    }
  })

  test("exchanges once even when matching callbacks and cancellation reports race", async () => {
    let release
    let entered
    let exchanges = 0
    const gate = new Promise((resolve) => { release = resolve })
    const entry = new Promise((resolve) => { entered = resolve })
    const local = await receiver({ api: createApi({ now: () => NOW, fetchImpl: async () => {
      exchanges++
      entered()
      await gate
      return json(tokens())
    } }) })
    try {
      const first = post(local.port, "exchange", callbackBody(local))
      await entry
      const repeated = await post(local.port, "exchange", callbackBody(local))
      expect(repeated.status).toBe(409)
      const cancellation = await post(local.port, "report", {
        accountId: 0, oauthAttemptId: local.oauthAttemptId, error: "late cancellation",
      })
      expect(cancellation.status).toBe(409)
      expect(exchanges).toBe(1)
      release()
      expect((await first).status).toBe(200)
      expectSavedIdentity(await local.result, local.identity, "google")
      await expectPortClosed(local.port)
    } finally {
      release()
      await local.close()
    }
  })

  test("reports the real terminal error and cannot cancel the next attempt on the same port", async () => {
    let exchanges = 0
    const api = createApi({ now: () => NOW, fetchImpl: async () => { exchanges++; return json(tokens()) } })
    const first = await receiver({ api })
    const oldReport = { accountId: 0, oauthAttemptId: first.oauthAttemptId, error: "Google access was denied.", code: "access_denied" }
    try {
      const response = await post(first.port, "report", oldReport)
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ success: true })
      expect(await first.result).toEqual({ type: "failed", error: "Google access was denied." })
      expect(exchanges).toBe(0)
      const next = await receiver({ api, port: first.port })
      try {
        const stale = await post(next.port, "report", oldReport)
        expect(stale.status).toBe(409)
        expect((await post(next.port, "exchange", callbackBody(next))).status).toBe(200)
        expectSavedIdentity(await next.result, next.identity, "google")
        expect(exchanges).toBe(1)
      } finally {
        await next.close()
      }
      await expectPortClosed(first.port)
    } finally {
      await first.close()
    }
  })

  test("preserves exchange errors and conflict codes while releasing the terminal listener", async () => {
    for (const [status, error, code, localStatus] of [
      [401, "Google sign-in is no longer valid.", "INVALID_TOKEN", 500],
      [409, "This account is already signed in on this device.", "ASIDE_LOCAL_ACCOUNT_ALREADY_SIGNED_IN", 409],
    ]) {
      const local = await receiver({ api: createApi({ fetchImpl: async () => json({ error, code }, status) }) })
      try {
        const response = await post(local.port, "exchange", callbackBody(local))
        expect(response.status).toBe(localStatus)
        expect(await response.json()).toEqual(localStatus === 409 ? { error, code } : { error })
        expect(await local.result).toEqual({ type: "failed", error })
        await expectPortClosed(local.port)
      } finally {
        await local.close()
      }
    }
  })

  test("rejects a non-Google exchange and closes without exposing tokens", async () => {
    const local = await receiver({ api: createApi({ fetchImpl: async () => json(tokens("email")) }) })
    try {
      const response = await post(local.port, "exchange", callbackBody(local))
      expect(response.status).toBe(500)
      expect(await response.json()).toEqual({ error: "Unexpected Google sign-in response." })
      expect(await local.result).toEqual({ type: "failed", error: "Unexpected Google sign-in response." })
      await expectPortClosed(local.port)
    } finally {
      await local.close()
    }
  })

  test("an expired matching callback aborts the attempt and releases the listener", async () => {
    let now = NOW
    let exchanges = 0
    const local = await receiver({ api: createApi({ now: () => now, fetchImpl: async () => { exchanges++; return json(tokens()) } }) })
    try {
      now += GOOGLE_OAUTH_TTL_MS + 1
      const response = await post(local.port, "exchange", callbackBody(local))
      expect(response.status).toBe(409)
      expect(await response.json()).toEqual({ error: "Google sign-in attempt expired. Start again." })
      expect(await local.result).toEqual({ type: "failed", error: "Google sign-in attempt expired. Start again." })
      expect(local.signal.aborted).toBe(true)
      expect(exchanges).toBe(0)
      await expectPortClosed(local.port)
    } finally {
      await local.close()
    }
  })

  test("oversized callback bodies do not consume the real attempt", async () => {
    const local = await receiver()
    try {
      const response = await post(local.port, "exchange", callbackBody(local, { supabaseAccessToken: "x".repeat(65537) }))
      expect(response.status).toBe(413)
      expect((await post(local.port, "exchange", callbackBody(local))).status).toBe(200)
      expectSavedIdentity(await local.result, local.identity, "google")
      await expectPortClosed(local.port)
    } finally {
      await local.close()
    }
  })
})

describe("Google authorization lifecycle", () => {
  test("uses the opaque server start and completes through the already-bound hosted callback", async () => {
    const port = await unusedPort()
    let state
    let exchanges = 0
    const identities = []
    const api = createApi({ now: () => NOW, fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body)
      if (new URL(url).pathname === "/auth/oauth/google/start") {
        state = body.oauthAttemptId
        const listening = await fetch(`http://127.0.0.1:${port}/auth/callback/exchange`, {
          method: "OPTIONS", headers: { Origin: ORIGIN },
        })
        if (listening.status !== 204 || body.accountId !== 0 || typeof state !== "string" || "callbackHandoffUrl" in body) {
          return json({ error: "Invalid hosted callback start." }, 400)
        }
        return json({
          oauthAttemptToken: "opaque-server-ticket",
          url: `https://example.supabase.co/auth/v1/authorize?provider=google&state=unchanged&redirect_to=${encodeURIComponent(`${ORIGIN}/auth/callback?accountId=0&oauthAttemptId=${state}`)}`,
        })
      }
      exchanges++
      if (body.oauthAttemptToken !== "opaque-server-ticket" || body.supabaseAccessToken !== "verified-supabase-jwt" ||
          body.authProtocol !== 2 || body.device.ikSigKeyFingerprint !== identities[0].asideDevice.ikSigKeyFingerprint) {
        return json({ error: "Wrong sign-in state." }, 400)
      }
      return json({ ...tokens(), supabaseAccessToken: "must-not-persist", oauthAttemptToken: "must-not-persist" })
    } })
    const methods = createAuthMethods({ api, callbackPort: port, createIdentity: async () => {
      const identity = await createCredentialIdentity()
      identities.push(identity)
      return identity
    } })
    const authorization = await methods[1].authorize()
    const callback = authorization.callback()
    try {
      expect(authorization.method).toBe("auto")
      const url = new URL(authorization.url)
      expect(url.searchParams.get("prompt")).toBe("select_account")
      expect(url.searchParams.get("state")).toBe("unchanged")
      expect(url.searchParams.get("redirect_to")).toBe(`${ORIGIN}/auth/callback?accountId=0&oauthAttemptId=${state}`)
      const response = await post(port, "exchange", {
        accountId: 0, oauthAttemptId: state, supabaseAccessToken: "verified-supabase-jwt",
      })
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ accountId: 0, email: "person@example.com", success: true, userId: "user-person@example.com" })
      const saved = await callback
      expectSavedIdentity(saved, identities[0], "google")
      expect(exchanges).toBe(1)
      await expectPortClosed(port)
    } finally {
      // A report is the same cancellation path the hosted page uses if sign-in fails.
      await post(port, "report", { accountId: 0, oauthAttemptId: state, error: "Test cancelled." }).catch(() => {})
    }
  })

  test("occupied ports fail before start without hijacking the running listener", async () => {
    const held = await listener()
    let starts = 0
    const api = createApi({ fetchImpl: async () => { starts++; return json({}) } })
    try {
      const method = createAuthMethods({ api, callbackPort: held.port })[1]
      try {
        await method.authorize()
        throw new Error("Expected the occupied callback port to reject sign-in.")
      } catch (error) {
        expect(error.code).toBe("EADDRINUSE")
      }
      expect(starts).toBe(0)
      expect((await fetch(`http://127.0.0.1:${held.port}/`)).status).toBe(204)
    } finally {
      await close(held.server)
    }
  })

  test("start rejection and invalid server URLs release the callback listener", async () => {
    for (const response of [
      () => json({ error: "Sign-in unavailable." }, 400),
      () => json({ oauthAttemptToken: "opaque-ticket", url: "javascript:alert(1)" }),
      () => json({ oauthAttemptToken: "", url: "https://example.supabase.co/auth/v1/authorize" }),
    ]) {
      const port = await unusedPort()
      const api = createApi({ fetchImpl: async () => response() })
      await expect(createAuthMethods({ api, callbackPort: port })[1].authorize()).rejects.toThrow()
      await expectPortClosed(port)
    }
  })

  test("the deadline aborts an unfinished start and closes the bound callback listener", async () => {
    const port = await unusedPort()
    let aborted = false
    const api = createApi({ fetchImpl: async (_url, init) => new Promise((_resolve, reject) => {
      const stop = () => { aborted = true; reject(init.signal.reason) }
      if (init.signal.aborted) stop()
      else init.signal.addEventListener("abort", stop, { once: true })
    }) })
    await expect(createAuthMethods({ api, callbackPort: port, callbackTimeoutMs: 30 })[1].authorize())
      .rejects.toThrow()
    expect(aborted).toBe(true)
    await expectPortClosed(port)
  })
})

describe("Google paste callback authentication", () => {
  test("exchanges a full callback while the local port is occupied, preserving identity but no transient secrets", async () => {
    const held = await listener()
    const identities = []
    try {
      for (const [baseURL, prefix] of [[ORIGIN, ""], ["https://api.asidehq.com", "?"]]) {
        const attempt = await manualGoogle({ baseURL, callbackPort: held.port, exchange: async (body) => {
          if (body.authProtocol !== 2 || body.accountId !== attempt.identity.asideAccountId ||
              body.oauthAttemptToken !== attempt.oauthAttemptToken || body.supabaseAccessToken !== attempt.supabaseAccessToken ||
              JSON.stringify(body.device) !== JSON.stringify(attempt.identity.asideDevice)) {
            return json({ error: "Wrong installation or OAuth attempt." }, 400)
          }
          return json({
            ...tokens(), supabaseAccessToken: body.supabaseAccessToken,
            oauthAttemptToken: body.oauthAttemptToken, callbackURL: attempt.callbackURL.toString(),
          })
        } })
        attempt.callbackURL.hash = prefix + attempt.callbackURL.hash.slice(1)
        const saved = await attempt.authorization.callback(attempt.callbackURL.toString())
        expectSavedIdentity(saved, attempt.identity, "google")
        expect(JSON.stringify(saved)).not.toContain(attempt.supabaseAccessToken)
        expect(JSON.stringify(saved)).not.toContain(attempt.oauthAttemptToken)
        expect(JSON.stringify(saved)).not.toContain("temporary-supabase-refresh-token")
        expect(attempt.exchanges).toHaveLength(1)
        identities.push(attempt.identity)
        expect((await fetch(`http://127.0.0.1:${held.port}/`)).status).toBe(204)
      }
      expect(identities[0].credentialId).not.toBe(identities[1].credentialId)
      expect(identities[0].asideDevice.ikSigKeyFingerprint).not.toBe(identities[1].asideDevice.ikSigKeyFingerprint)
    } finally {
      await close(held.server)
    }
  })

  test("rejects wrong pages and missing, duplicate or cross-account state before any exchange", async () => {
    for (const change of [
      () => "",
      (url) => url.pathname + url.search + url.hash,
      (url) => { url.hostname = "api.aside.com.evil.example" },
      (url) => { url.hostname = "api.asidehq.com" },
      (url) => { url.pathname = "/auth/callback/exchange" },
      (url) => { url.username = "secret-user"; url.password = "secret-password" },
      (url) => { url.searchParams.delete("accountId") },
      (url) => { url.searchParams.set("accountId", "1") },
      (url) => { url.searchParams.set("accountId", "00") },
      (url) => { url.searchParams.append("accountId", "0") },
      (url) => { url.searchParams.delete("oauthAttemptId") },
      (url) => { url.searchParams.set("oauthAttemptId", randomUUID()) },
      (url) => { url.searchParams.append("oauthAttemptId", url.searchParams.get("oauthAttemptId")) },
    ]) {
      const attempt = await manualGoogle()
      const url = new URL(attempt.callbackURL)
      const pasted = change(url) ?? url.toString()
      const failed = await attempt.authorization.callback(pasted)
      expect(failed.type).toBe("failed")
      expect(JSON.stringify(failed)).not.toContain(attempt.supabaseAccessToken)
      expect(JSON.stringify(failed)).not.toContain(attempt.oauthAttemptToken)
      expect(JSON.stringify(failed)).not.toContain("secret-password")
      expect(attempt.exchanges).toHaveLength(0)
      expect((await attempt.authorization.callback(attempt.callbackURL.toString())).type).toBe("failed")
      expect(attempt.exchanges).toHaveLength(0)
    }
  })

  test("requires a unique fragment token and cannot accept authorization-code, recovery or OAuth error URLs", async () => {
    for (const change of [
      (url) => { url.hash = "" },
      (url) => { url.hash = ""; url.searchParams.set("code", "google-authorization-code") },
      (url) => { url.searchParams.set("access_token", "query-only-token"); url.hash = "" },
      (url) => { url.hash = "access_token=" },
      (url) => { url.hash = "access_token=%20%09" },
      (url) => { url.hash += "&%61ccess_token=second-token" },
      (url) => { url.hash += "&type=recovery" },
      (url) => { url.searchParams.set("flow", "recovery") },
      (url) => { url.hash += "&flow=recovery" },
      (url) => { url.hash += "&error=access_denied&error_description=secret-oauth-error" },
    ]) {
      const attempt = await manualGoogle()
      const url = new URL(attempt.callbackURL)
      change(url)
      const failed = await attempt.authorization.callback(url.toString())
      expect(failed.type).toBe("failed")
      expect(JSON.stringify(failed)).not.toContain(attempt.supabaseAccessToken)
      expect(JSON.stringify(failed)).not.toContain("secret-oauth-error")
      expect(attempt.exchanges).toHaveLength(0)
      expect((await attempt.authorization.callback(attempt.callbackURL.toString())).type).toBe("failed")
      expect(attempt.exchanges).toHaveLength(0)
    }
  })

  test("a preceding attempt cannot spend the next credential's ticket", async () => {
    const first = await manualGoogle()
    const next = await manualGoogle()
    expect(next.oauthAttemptId).not.toBe(first.oauthAttemptId)
    const rejected = await next.authorization.callback(first.callbackURL.toString())
    expect(rejected.type).toBe("failed")
    expect(next.exchanges).toHaveLength(0)
    expect(first.exchanges).toHaveLength(0)
    expectSavedIdentity(await first.authorization.callback(first.callbackURL.toString()), first.identity, "google")
    expect(first.exchanges).toHaveLength(1)
    expect(next.exchanges).toHaveLength(0)
  })

  test("checks the ten-minute deadline on demand and never revives an expired ticket", async () => {
    for (const elapsed of [GOOGLE_OAUTH_TTL_MS - 1, GOOGLE_OAUTH_TTL_MS]) {
      let now = NOW
      const attempt = await manualGoogle({ now: () => now })
      now += elapsed
      const result = await attempt.authorization.callback(attempt.callbackURL.toString())
      if (elapsed < GOOGLE_OAUTH_TTL_MS) {
        expect(result).toMatchObject({ type: "success", expires: now + 3600000 })
        expect(attempt.exchanges).toHaveLength(1)
      } else {
        expect(result.type).toBe("failed")
        expect(attempt.exchanges).toHaveLength(0)
        now = NOW
        expect((await attempt.authorization.callback(attempt.callbackURL.toString())).type).toBe("failed")
        expect(attempt.exchanges).toHaveLength(0)
      }
    }
  })

  test("concurrent and repeated callbacks share one terminal exchange even when a different URL races", async () => {
    let release
    let entered
    const gate = new Promise((resolve) => { release = resolve })
    const entry = new Promise((resolve) => { entered = resolve })
    const attempt = await manualGoogle({ exchange: async () => {
      entered()
      await gate
      return json(tokens())
    } })
    try {
      const first = attempt.authorization.callback(attempt.callbackURL.toString())
      const duplicate = attempt.authorization.callback(attempt.callbackURL.toString())
      await entry
      const forged = new URL(attempt.callbackURL)
      forged.searchParams.set("oauthAttemptId", randomUUID())
      const racing = attempt.authorization.callback(forged.toString())
      expect(attempt.exchanges).toHaveLength(1)
      release()
      const saved = await first
      expectSavedIdentity(saved, attempt.identity, "google")
      await Promise.all([duplicate, racing, attempt.authorization.callback(attempt.callbackURL.toString())])
      expect(attempt.exchanges).toHaveLength(1)
    } finally {
      release()
    }
  })

  test("native response validation rejects non-Google or malformed tokens without saving a credential", async () => {
    for (const payload of [
      tokens("email"),
      { ...tokens(), provider: undefined },
      { ...tokens(), refreshToken: "" },
      { ...tokens(), expiresIn: 0 },
    ]) {
      const attempt = await manualGoogle({ exchange: async () => json(payload) })
      const failed = await attempt.authorization.callback(attempt.callbackURL.toString())
      expect(failed.type).toBe("failed")
      expect(attempt.exchanges).toHaveLength(1)
      expect((await attempt.authorization.callback(attempt.callbackURL.toString())).type).toBe("failed")
      expect(attempt.exchanges).toHaveLength(1)
    }
  })

  test("exchange failures cannot reflect the callback URL, Supabase token or opaque ticket", async () => {
    for (const transportFailure of [false, true]) {
      const attempt = await manualGoogle({ exchange: async (body) => {
        const reflected = `${attempt.callbackURL} ${body.supabaseAccessToken} ${body.oauthAttemptToken}`
        if (transportFailure) throw new Error(reflected)
        return json({ error: reflected }, 401)
      } })
      const failed = await attempt.authorization.callback(attempt.callbackURL.toString())
      expect(failed.type).toBe("failed")
      const serialized = JSON.stringify(failed)
      expect(serialized).not.toContain(attempt.callbackURL.toString())
      expect(serialized).not.toContain(attempt.supabaseAccessToken)
      expect(serialized).not.toContain(attempt.oauthAttemptToken)
      const exchangesAfterFailure = attempt.exchanges.length
      expect((await attempt.authorization.callback(attempt.callbackURL.toString())).type).toBe("failed")
      expect(attempt.exchanges).toHaveLength(exchangesAfterFailure)
    }
  })

  test("start errors and invalid authorization URLs fail without exposing server OAuth secrets", async () => {
    for (const response of [
      () => json({ error: "secret-start-ticket https://example.supabase.co/#access_token=secret-start-token" }, 401),
      () => json({ oauthAttemptToken: "secret-start-ticket", url: "javascript:secret-start-token" }),
      () => json({ oauthAttemptToken: "", url: "https://example.supabase.co/auth/v1/authorize" }),
    ]) {
      const api = createApi({ fetchImpl: async () => response() })
      const error = await createAuthMethods({ api })[2].authorize().catch((error) => error)
      expect(error).toBeInstanceOf(Error)
      expect(error.message).not.toContain("secret-start-ticket")
      expect(error.message).not.toContain("secret-start-token")
    }
  })
})
