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
      expect(await authorization.callback()).toBe(saved)
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
        expect(error.message).toContain(`127.0.0.1:${held.port}`)
        expect(error.message).toContain("Email sign-in")
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
      .rejects.toThrow("Google sign-in attempt expired. Start again.")
    expect(aborted).toBe(true)
    await expectPortClosed(port)
  })
})
