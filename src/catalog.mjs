import { AsideApiError, responseJSON } from "./api.mjs"

const CACHE_MS = 43_200_000
const FAILURE_COOLDOWN_MS = 60_000
const TIMEOUT_MS = 5_000
const DEFAULT_API_URL = "https://api.aside.com/ai/v1"
const PLAN_TIER = Object.freeze({ free: 0, pro: 1, max: 2 })
const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"])
const THINKING_BUDGETS = Object.freeze({ minimal: 1024, low: 2048, medium: 8192, high: 16384, xhigh: 16384, max: 16384 })
const NPM = Object.freeze({
  "anthropic-messages": "@ai-sdk/anthropic",
  "openai-responses": "@ai-sdk/openai",
  "openai-completions": "@ai-sdk/openai-compatible",
})
const MODALITIES = ["text", "image", "audio", "video", "pdf"]

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function text(value) {
  return typeof value === "string" && value.length > 0
}

function invalidCatalog() {
  throw new AsideApiError(502, "Aside returned an invalid public model catalog.", "ASIDE_CATALOG_INVALID_RESPONSE")
}

// The schema, cache policy and entitlements follow Aside's shipped catalog
// implementation. Unknown IDs are valid; historical redirects are not applied.
function parseCatalog(value) {
  if (!object(value) || value.provider !== "aside" || !Array.isArray(value.models)) invalidCatalog()
  const images = value.imageModels === undefined ? [] : value.imageModels
  if (!Array.isArray(images) || (value.visibleModelIds !== undefined &&
      (!Array.isArray(value.visibleModelIds) || !value.visibleModelIds.every(text)))) invalidCatalog()

  const models = value.models.map((model) => {
    if (!object(model) || !text(model.id) || !text(model.name) || !Object.hasOwn(PLAN_TIER, model.minPlan) ||
        typeof model.reasoning !== "boolean" || typeof model.supportsReasoningEffort !== "boolean" ||
        typeof model.supportsFastMode !== "boolean" ||
        (model.api !== undefined && model.api !== "anthropic-messages" && model.api !== "openai-responses") ||
        !Number.isInteger(model.contextWindow) || model.contextWindow <= 0 ||
        !Number.isInteger(model.maxTokens) || model.maxTokens <= 0 ||
        !Array.isArray(model.availableThinkingLevels) || !model.availableThinkingLevels.length ||
        !model.availableThinkingLevels.every((level) => THINKING_LEVELS.has(level))) invalidCatalog()
    return Object.freeze({
      id: model.id,
      name: model.name,
      minPlan: model.minPlan,
      reasoning: model.reasoning,
      supportsReasoningEffort: model.supportsReasoningEffort,
      ...(model.api !== undefined ? { api: model.api } : {}),
      supportsFastMode: model.supportsFastMode,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      availableThinkingLevels: Object.freeze([...model.availableThinkingLevels]),
    })
  })
  const imageModels = images.map((model) => {
    if (!object(model) || !text(model.id) || !text(model.name)) invalidCatalog()
    return Object.freeze({ id: model.id, name: model.name })
  })
  return Object.freeze({
    provider: "aside",
    models: Object.freeze(models),
    imageModels: Object.freeze(imageModels),
    ...(value.visibleModelIds?.length ? { visibleModelIds: Object.freeze([...value.visibleModelIds]) } : {}),
  })
}

function waitingFor(promise, signal) {
  if (!signal) return promise
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason)
    signal.addEventListener("abort", abort, { once: true })
    promise.then(
      (value) => { signal.removeEventListener("abort", abort); resolve(value) },
      (error) => { signal.removeEventListener("abort", abort); reject(error) },
    )
  })
}

export function createCatalog({ api }) {
  let current
  let fetchedAt = null
  let etag
  let retryAfter = 0
  let failure
  let fellBack = false
  let inFlight

  const result = () => ({ catalog: current, fellBack })

  async function refresh() {
    try {
      // The catalog is public. Never use an account session or copy SDK/auth
      // headers onto this request; only the cached validator belongs here.
      let response = await api.request("/ai/catalog/v1", {
        headers: etag ? { "if-none-match": etag } : {}, timeoutMs: TIMEOUT_MS, retry: 0,
      })
      if (response.status === 404 || response.status === 405) {
        await response.body?.cancel()
        response = await api.request("/ai/models/v2", { headers: {}, timeoutMs: TIMEOUT_MS, retry: 0 })
      }
      if (response.status === 304 && fetchedAt !== null) {
        fetchedAt = api.now()
      } else {
        const next = parseCatalog(await responseJSON(response))
        current = next
        fetchedAt = api.now()
        etag = response.headers.get("etag") ?? undefined
      }
      retryAfter = 0
      failure = undefined
      fellBack = false
    } catch (error) {
      // An outage can retain only a catalog obtained from an earlier successful
      // request. First-use failures are explicit; no static list is invented.
      retryAfter = api.now() + FAILURE_COOLDOWN_MS
      failure = error
      if (!current) throw error
      fellBack = true
    }
    return result()
  }

  async function get({ force = false, signal } = {}) {
    signal?.throwIfAborted()
    const now = api.now()
    if (!force && now < retryAfter) {
      if (!current) throw failure
      return result()
    }
    if (!force && fetchedAt !== null && now - fetchedAt < CACHE_MS) return result()
    // Request lifetime is shared, while a cancelled caller stops waiting
    // independently. The only timer is the on-demand public request timeout.
    inFlight ??= refresh().finally(() => { inFlight = undefined })
    return waitingFor(inFlight, signal)
  }

  return { get, peek: () => current }
}

export function protocolFor(model) {
  if (typeof model?.api === "string" && Object.hasOwn(NPM, model.api)) return model.api
  const npm = model?.api?.npm
  if (npm === NPM["anthropic-messages"]) return "anthropic-messages"
  if (npm === NPM["openai-responses"]) return "openai-responses"
  return "openai-completions"
}

export function isImageModel(catalog, id) {
  return catalog?.imageModels?.some((model) => model.id === id) ?? false
}

function variantsFor(model) {
  if (!model.reasoning) return {}
  const protocol = protocolFor(model)
  return Object.fromEntries(model.availableThinkingLevels.map((level) => {
    if (protocol === "anthropic-messages") {
      return [level, {
        thinking: level === "off" ? { type: "disabled" } : { type: "enabled", budgetTokens: THINKING_BUDGETS[level] },
      }]
    }
    if (!model.supportsReasoningEffort) return [level, {}]
    return [level, { reasoningEffort: level === "off" ? "none" : level }]
  }))
}

function price() {
  return { input: 0, output: 0, cache: { read: 0, write: 0 } }
}

function modalities(kinds) {
  return Object.fromEntries(MODALITIES.map((kind) => [kind, kinds.includes(kind)]))
}

export function catalogModels(catalog, provider) {
  return normalizedModels(provider, catalog.models, catalog.imageModels, false)
}

export function accountModels(catalog, provider, auth) {
  const plan = auth?.subscriptionPlan === "pro" || auth?.subscriptionPlan === "max" ? auth.subscriptionPlan : "free"
  const models = catalog.models.filter((model) => PLAN_TIER[plan] >= PLAN_TIER[model.minPlan])
  const images = auth?.type === "oauth" || auth?.access || auth?.refresh ? catalog.imageModels : []
  return normalizedModels(provider, models, images, plan !== "free")
}

function normalizedModels(provider, models, images, allowFast) {
  const url = (provider.api || provider.options?.baseURL || DEFAULT_API_URL).replace(/\/+$/, "")
  const providerID = provider.id ?? "aside"

  return Object.fromEntries([
    ...models.map((model) => {
      const fast = allowFast && model.supportsFastMode
      return [model.id, {
        id: model.id,
        providerID,
        name: model.name,
        api: { id: model.id, url, npm: NPM[protocolFor(model)] },
        status: "active",
        headers: {},
        options: { ...(provider.models?.[model.id]?.options ?? {}) },
        cost: price(),
        limit: { context: model.contextWindow, output: model.maxTokens },
        capabilities: {
          temperature: true,
          reasoning: model.reasoning,
          attachment: true,
          toolcall: true,
          input: modalities(["text", "image"]),
          output: modalities(["text"]),
          interleaved: false,
        },
        release_date: "",
        minPlan: model.minPlan,
        supportsReasoningEffort: model.supportsReasoningEffort,
        availableThinkingLevels: [...model.availableThinkingLevels],
        supportsFastMode: fast,
        fast,
        serviceTiers: fast ? ["priority"] : [],
        variants: variantsFor(model),
      }]
    }),
    ...images.map((model) => [model.id, {
      id: model.id,
      providerID,
      name: model.name,
      api: { id: model.id, url, npm: NPM["openai-completions"] },
      status: "active",
      headers: {},
      options: { ...(provider.models?.[model.id]?.options ?? {}) },
      cost: price(),
      // Aside publishes no token limits for image models; zero is Magpie's
      // explicit unknown limit, not a fabricated language-model context.
      limit: { context: 0, output: 0 },
      capabilities: {
        temperature: false,
        reasoning: false,
        attachment: true,
        toolcall: false,
        input: modalities(["text", "image"]),
        output: modalities(["image"]),
        interleaved: false,
      },
      release_date: "",
      supportsFastMode: false,
      fast: false,
      serviceTiers: [],
      variants: {},
    }]),
  ])
}
