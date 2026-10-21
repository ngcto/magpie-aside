import { AsideApiError, errorDetails, responseJSON } from "./api.mjs"

const ACCESS_ERRORS = new Set(["ACCESS_TOKEN_EXPIRED", "ACCESS_TOKEN_INVALID", "ACCESS_TOKEN_STALE_CLAIMS"])
const REVOKED_ERRORS = new Set(["REFRESH_TOKEN_REVOKED", "REFRESH_TOKEN_COMPROMISED", "REFRESH_TOKEN_EXPIRED"])
const DEVICE_ERRORS = new Set(["REFRESH_TOKEN_DEVICE_MISMATCH", "REFRESH_TOKEN_DEVICE_REVOKED"])
const REFRESH_MARGIN = 60000
const FORCE_REUSE_WINDOW = 30000
const BACKOFF_WINDOW = 120000
const REFRESH_DELAYS = [1000, 3000]

export function expired(message, code = "ASIDE_SIGN_IN_REQUIRED") {
  return Object.assign(new AsideApiError(401, message, code), { signIn: "expired" })
}

function assertAuth(auth) {
  if (auth?.type !== "oauth" || !auth.access || !auth.refresh) throw expired("Sign in to Aside first.")
  if (typeof auth.credentialId !== "string" || !auth.credentialId ||
      !Number.isInteger(auth.asideAccountId) || auth.asideAccountId < 0 ||
      !auth.asideDevice?.ikSigKeyFingerprint || !auth.asideDevice?.ikSigPublicKeyJwk ||
      !Number.isFinite(auth.expires) || auth.expires <= 0) {
    throw expired("Sign in to Aside again to register an isolated device for this credential.")
  }
  return auth
}

function sameIdentity(a, b) {
  return a?.credentialId === b?.credentialId && a?.asideDevice?.ikSigKeyFingerprint === b?.asideDevice?.ikSigKeyFingerprint
}
function sameSession(a, b) {
  return !!a && !!b && sameIdentity(a, b) && a.refresh === b.refresh && a.access === b.access
}
function authRejected(error) {
  return error?.status === 401 || error?.status === 403 ||
    /401|403|Unauthorized|Forbidden|Token revoked/.test(error?.message ?? "")
}
function terminalRefreshError(error) {
  if (REVOKED_ERRORS.has(error?.code) || /Token revoked|Token compromised|Token expired/.test(error?.message ?? "")) {
    return expired("Aside revoked or expired this sign-in. Sign in again.", error.code)
  }
  if (DEVICE_ERRORS.has(error?.code) || /Token device mismatch|This device has been revoked/.test(error?.message ?? "")) {
    return expired("Aside rejected this credential's device. Sign in again.", error.code)
  }
  if (authRejected(error)) return expired("Aside rejected the refresh token. Sign in again.", error.code)
  return null
}

// Cancellation stops a waiter, not another account request's shared token renewal.
function waitFor(promise, signal) {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(signal.reason) }
    signal.addEventListener("abort", abort, { once: true })
    promise.then((value) => { signal.removeEventListener("abort", abort); resolve(value) },
      (error) => { signal.removeEventListener("abort", abort); reject(error) })
  })
}

export function createAccountManager({ api, client }) {
  const states = new Map()

  function stateFor(auth) {
    let state = states.get(auth.credentialId)
    if (state && !sameIdentity(state.current, auth)) {
      throw expired("Aside credential identity changed. Sign in again instead of reusing a device.")
    }
    if (!state) {
      state = { current: auth, inflight: null, recent: null, backoff: null, rejected: null }
      states.set(auth.credentialId, state)
    }
    return state
  }

  async function read(state, getAuth) {
    const incoming = await getAuth()
    if (!incoming || !sameIdentity(incoming, state.current)) return incoming
    if (!sameSession(incoming, state.current)) {
      state.current = incoming
      state.recent = null
      state.backoff = null
      state.rejected = null
    } else {
      state.current = incoming
    }
    return state.current
  }


  async function save(state, getAuth, fields, expected) {
    const current = await read(state, getAuth)
    if (!current || !sameSession(current, expected)) return current
    const next = { ...current, ...fields }
    await client.auth.set({ path: { id: "aside" }, body: next })
    state.current = next
    return next
  }

  async function refresh(state, getAuth, auth, { force = false, bypass = false } = {}) {
    if (state.inflight) return state.inflight
    const current = await read(state, getAuth)
    if (!current || !sameIdentity(current, auth)) return current
    auth = assertAuth(current)
    if (state.inflight) return state.inflight
    if (state.rejected && sameSession(state.rejected.auth, auth)) throw state.rejected.error
    if (force && state.recent?.refresh === auth.refresh && api.now() - state.recent.at <= FORCE_REUSE_WINDOW &&
        auth.expires - api.now() >= REFRESH_MARGIN) return auth
    if (!force && auth.expires - api.now() >= REFRESH_MARGIN) return auth
    if (!bypass && state.backoff?.refresh === auth.refresh && api.now() < state.backoff.until) throw state.backoff.error

    const baseline = auth
    const run = (async () => {
      let tokens, failure
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          tokens = await api.json("/auth/token/refresh", {
            method: "POST", retry: 0,
            body: { refreshToken: baseline.refresh, device: baseline.asideDevice },
          })
          if (!tokens || typeof tokens.accessToken !== "string" || !tokens.accessToken ||
              typeof tokens.refreshToken !== "string" || !tokens.refreshToken ||
              !Number.isInteger(tokens.expiresIn) || tokens.expiresIn <= 0) {
            throw new AsideApiError(502, "Aside returned invalid refreshed credentials.", "ASIDE_API_INVALID_RESPONSE")
          }
          failure = null
          break
        } catch (error) {
          failure = error
          if (attempt < 2 && !authRejected(error)) await api.sleep(REFRESH_DELAYS[attempt])
        }
      }
      const latest = await read(state, getAuth)
      if (!sameSession(latest, baseline)) return latest
      if (failure) {
        const terminal = terminalRefreshError(failure)
        if (terminal) {
          state.rejected = { auth: baseline, error: terminal }
          throw terminal
        }
        if (failure instanceof AsideApiError && (failure.status === 408 || failure.status === 429 || failure.status >= 500)) {
          state.backoff = { refresh: baseline.refresh, until: api.now() + BACKOFF_WINDOW, error: failure }
        }
        throw failure
      }
      const next = await save(state, getAuth, {
        access: tokens.accessToken, refresh: tokens.refreshToken, expires: api.now() + tokens.expiresIn * 1000,
      }, baseline)
      if (sameIdentity(next, baseline) && next?.refresh === tokens.refreshToken) {
        state.recent = { at: api.now(), refresh: next.refresh }
        state.backoff = null
        state.rejected = null
      }
      return next
    })()
    state.inflight = run
    const clear = () => { if (state.inflight === run) state.inflight = null }
    run.then(clear, clear)
    return run
  }

  // Creating/loading a session performs no network work and schedules no renewal.
  function session(getAuth) {
    async function resolve() {
      const incoming = assertAuth(await getAuth())
      let state = stateFor(incoming)
      const auth = assertAuth(await read(state, getAuth))
      if (!sameIdentity(auth, incoming)) state = stateFor(auth)
      return { state, auth }
    }
    async function valid(signal, options) {
      signal?.throwIfAborted()
      let { state, auth } = await resolve()
      if (options?.force || auth.expires - api.now() < REFRESH_MARGIN) {
        auth = assertAuth(await waitFor(refresh(state, getAuth, auth, options), signal))
      }
      signal?.throwIfAborted()
      return auth
    }
    async function request(path, options = {}) {
      const send = (auth) => {
        let headers
        if (typeof options.headers === "function") headers = options.headers(auth)
        else {
          headers = new Headers(options.headers)
          headers.set("authorization", `Bearer ${auth.access}`)
        }
        return api.request(path, { ...options, headers })
      }
      const auth = await valid(options.signal)
      let response = await send(auth)
      if (response.status !== 401) return response
      const error = await errorDetails(response)
      if (!ACCESS_ERRORS.has(error?.code)) return response
      const renewed = await valid(options.signal, { force: true, bypass: true })
      await response.body?.cancel()
      response = await send(renewed)
      return response
    }
    async function json(path, options = {}) {
      try {
        return await responseJSON(await request(path, { retry: 2, ...options }))
      } catch (error) {
        if (options.signal?.aborted) throw options.signal.reason
        if (error?.name === "AbortError" || error?.name === "TimeoutError") {
          throw new AsideApiError(504, "Aside servers didn't respond in time. Check your connection and try again.", "ASIDE_API_TIMEOUT")
        }
        throw error
      }
    }
    return { request, json, getAuth: async () => (await resolve()).auth }
  }

  return { session }
}
