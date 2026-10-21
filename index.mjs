import { randomUUID } from "node:crypto"
import { createApi, AsideApiError } from "./src/api.mjs"
import { createAccountManager, expired } from "./src/accounts.mjs"
import { createCredentialIdentity, createDeviceRegistration } from "./src/device.mjs"
import { createAuthMethods } from "./src/auth.mjs"
import { readAsideUsage } from "./src/usage.mjs"
import { createCatalog, catalogModels, accountModels, protocolFor, isImageModel } from "./src/catalog.mjs"
import { handleImageRequest } from "./src/images.mjs"
import { accountSessionId, prepareModelRequest, modelHeaders, errorResponse } from "./src/wire.mjs"

const decoder = new TextDecoder()
const PATHS = { "anthropic-messages": "/ai/v1/messages?beta=true", "openai-responses": "/ai/v1/responses", "openai-completions": "/ai/v1/chat/completions" }

async function requestBody(input, init) {
  let body = init?.body
  if (body === undefined && input instanceof Request) body = await input.text()
  if (body instanceof ArrayBuffer) body = decoder.decode(new Uint8Array(body))
  else if (ArrayBuffer.isView(body)) body = decoder.decode(body)
  if (typeof body !== "string") throw new AsideApiError(400, "Expected a JSON request body.")
  try { return JSON.parse(body) } catch { throw new AsideApiError(400, "The request body is not valid JSON.") }
}

export const MagpieAsidePlugin = async ({ client }, options = {}) => {
  const api = createApi({ baseURL: options?.apiBaseUrl ?? process.env.ASIDE_API_URL ?? "https://api.aside.com" })
  const accounts = createAccountManager({ api, client })
  const catalog = createCatalog({ api })
  const baseURL = `${api.baseURL}/ai/v1`
  const profiles = new Map()
  const accessErrors = new Set(["ACCESS_TOKEN_EXPIRED", "ACCESS_TOKEN_INVALID", "ACCESS_TOKEN_STALE_CLAIMS"])

  function cachedPlan(auth) {
    const profile = profiles.get(auth.credentialId)
    if (profile?.uid === auth.uid && profile.fingerprint === auth.asideDevice?.ikSigKeyFingerprint) return profile.plan
    return ["pro", "max"].includes(auth.subscriptionPlan) ? auth.subscriptionPlan : "free"
  }

  // Model discovery receives an immutable auth snapshot, not a live host getter.
  // It must never rotate/save tokens or resurrect a removed/replaced account.
  async function readPlan(auth) {
    if (auth.expires - api.now() < 60000) return { plan: cachedPlan(auth), fellBack: false }
    try {
      const profile = await api.json("/auth/me", { headers: { authorization: `Bearer ${auth.access}` } })
      if (!profile || typeof profile.userId !== "string" || typeof profile.plan !== "string" || typeof profile.email !== "string") {
        throw new AsideApiError(502, "Aside returned an invalid account profile.", "ASIDE_API_INVALID_RESPONSE")
      }
      if (profile.userId !== auth.uid) throw expired("Aside's profile does not match this credential. Sign in again.")
      const plan = ["pro", "max"].includes(profile.plan) ? profile.plan : "free"
      profiles.set(auth.credentialId, { uid: auth.uid, fingerprint: auth.asideDevice?.ikSigKeyFingerprint, plan })
      return { plan, fellBack: false }
    } catch (error) {
      if (error?.signIn === "expired") throw error
      if ((error?.status === 401 || error?.status === 403) && !accessErrors.has(error.code)) throw expired(error.message, error.code)
      return { plan: cachedPlan(auth), fellBack: true }
    }
  }

  const methods = createAuthMethods({ api, createIdentity: createCredentialIdentity })
  for (const method of methods) {
    const authorize = method.authorize
    method.authorize = async (inputs) => {
      const flow = await authorize(inputs)
      const callback = flow.callback
      let completion
      flow.callback = (code) => {
        completion ??= (async () => {
          const signedIn = await callback(code)
          if (signedIn?.type !== "success") return signedIn
          try {
            signedIn.subscriptionPlan = (await readPlan(signedIn)).plan
            return signedIn
          } catch (error) {
            return { type: "failed", error: error.message }
          }
        })()
        return completion
      }
      return flow
    }
  }

  function providerFetch(account) {
    return async (input, init = {}) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      const signal = init.signal ?? (input instanceof Request ? input.signal : undefined)
      let protocol = url.pathname.endsWith("/messages") ? "anthropic-messages" : url.pathname.endsWith("/responses") ? "openai-responses" : "openai-completions"
      try {
        signal?.throwIfAborted()
        if (!["POST", "post"].includes(init.method ?? (input instanceof Request ? input.method : "POST"))) {
          throw new AsideApiError(405, "Aside model requests use POST.")
        }
        const { catalog: current } = await catalog.get({ signal })
        if (url.pathname.endsWith("/images/generations") || url.pathname.endsWith("/images/edits")) {
          return await handleImageRequest(input, { ...init, signal }, { account, catalog: current })
        }
        const body = await requestBody(input, init)
        if (isImageModel(current, body?.model)) {
          return await handleImageRequest(input, { ...init, signal }, { account, catalog: current, body })
        }
        const model = current.models.find((candidate) => candidate.id === body?.model)
        if (!model) throw new AsideApiError(400, "This model is not in Aside's current catalog.", "ASIDE_MODEL_UNAVAILABLE")
        protocol = protocolFor(model)
        const path = PATHS[protocol]
        if (!path || !url.pathname.endsWith(path.split("?")[0].replace("/ai/v1", ""))) {
          throw new AsideApiError(400, `This Aside model uses ${protocol}; route it through its declared model API.`)
        }
        const incoming = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined))
        if (!incoming.has("x-aside-session-id")) incoming.set("x-aside-session-id", randomUUID())
        const requestedFast = body.speed === "fast" || body.service_tier === "priority"
        return await account.request(path, {
          method: "POST", body, signal, timeoutMs: 600000,
          headers: (auth) => {
            const prepared = prepareModelRequest(body, model, protocol, auth, incoming, requestedFast, cachedPlan(auth))
            return modelHeaders(auth, { ...prepared, model, protocol })
          },
        })
      } catch (error) {
        if (signal?.aborted || error?.name === "AbortError") throw error
        return errorResponse(error, protocol)
      }
    }
  }

  return {
    config: async (cfg) => {
      cfg.provider ??= {}
      cfg.provider.aside ??= {
        name: "Aside", npm: "@ai-sdk/openai-compatible", api: baseURL,
        models: {},
      }
    },
    auth: {
      provider: "aside",
      icon: "https://aside.com/icon.png",
      methods,
      usage: async (getAuth) => {
        const auth = await getAuth()
        if (auth?.type !== "oauth") return {}
        return readAsideUsage(accounts.session(getAuth))
      },
      // Deliberately no auth.refresh: the host's lead/loader renewal is not Aside's lazy check.
      loader: async (getAuth) => {
        const auth = await getAuth()
        if (auth?.type !== "oauth") return {}
        return { baseURL, fetch: providerFetch(accounts.session(getAuth)) }
      },
    },
    provider: {
      id: "aside",
      async models(provider, { auth } = {}) {
        const { catalog: current, fellBack } = await catalog.get({ force: true })
        if (auth?.type !== "oauth") {
          const models = catalogModels(current, provider)
          if (fellBack) models[Symbol.for("magpie.fellBack")] = true
          return models
        }
        const { plan, fellBack: profileFallback } = await readPlan(auth)
        const models = accountModels(current, provider, { ...auth, subscriptionPlan: plan })
        if (fellBack || profileFallback) models[Symbol.for("magpie.fellBack")] = true
        return models
      },
    },
    "chat.headers": async (input, output) => {
      if (input.model.providerID !== "aside") return
      output.headers["x-aside-session-id"] = input.sessionID || randomUUID()
    },
  }
}

export const _internal = { createApi, createAccountManager, createCredentialIdentity, createDeviceRegistration, createCatalog, catalogModels, accountModels, protocolFor, isImageModel, handleImageRequest, accountSessionId, prepareModelRequest, modelHeaders, requestBody }
