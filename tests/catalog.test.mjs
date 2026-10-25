import { expect, test } from "bun:test"
import { createApi } from "../src/api.mjs"
import { accountModels, catalogModels, createCatalog, isImageModel, protocolFor } from "../src/catalog.mjs"

function model(fields = {}) {
  return {
    id: "next-live-model",
    name: "Next Live Model",
    minPlan: "free",
    reasoning: true,
    supportsReasoningEffort: true,
    supportsFastMode: false,
    contextWindow: 1_048_576,
    maxTokens: 64_000,
    availableThinkingLevels: ["off", "low", "high"],
    ...fields,
  }
}

function payload(models = [model()], imageModels = []) {
  return { provider: "aside", models, imageModels }
}

function fixture(respond) {
  const calls = []
  let now = 0
  const api = createApi({
    baseURL: "https://aside.example",
    now: () => now,
    fetchImpl: async (input, init) => {
      calls.push({ url: new URL(input), init })
      return respond(calls.length, input, init)
    },
  })
  return { catalog: createCatalog({ api }), calls, at: (time) => { now = time } }
}

function gate() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

const provider = { id: "aside", api: "https://aside.example/ai/v1", models: {} }
const auth = (subscriptionPlan) => ({ type: "oauth", access: "account-access-token", subscriptionPlan })


test("concurrent discovery has one flight and publishes newly introduced IDs", async () => {
  const pending = gate()
  const f = fixture(() => pending.promise)
  const first = f.catalog.get()
  const forced = f.catalog.get({ force: true })
  expect(f.calls).toHaveLength(1)
  pending.resolve(Response.json(payload(
    [model({ id: "new-native-model", api: "openai-responses" })],
    [{ id: "new-image-model", name: "New Image Model" }],
  )))

  const [a, b] = await Promise.all([first, forced])
  expect(a.catalog).toBe(b.catalog)
  expect(a.fellBack).toBe(false)
  const available = accountModels(a.catalog, provider, auth("max"))
  expect(Object.keys(available).sort()).toEqual(["new-image-model", "new-native-model"])
  expect(isImageModel(a.catalog, "new-image-model")).toBe(true)
})

test("forced discovery replaces a fresh successful cache with newly published IDs", async () => {
  const f = fixture((number) => Response.json(payload(
    [model({ id: number === 1 ? "first-live-model" : "newly-published-model" })],
    number === 1 ? [] : [{ id: "newly-published-image", name: "Newly Published Image" }],
  )))
  const initial = await f.catalog.get()
  expect(initial.catalog.models[0].id).toBe("first-live-model")
  expect((await f.catalog.get()).catalog).toBe(initial.catalog)
  expect(f.calls).toHaveLength(1)

  const updated = await f.catalog.get({ force: true })
  expect(updated.fellBack).toBe(false)
  expect(Object.keys(catalogModels(updated.catalog, provider))).toEqual(["newly-published-model", "newly-published-image"])
  expect(f.calls).toHaveLength(2)
})

test("a 304 retains the validated payload and restarts twelve-hour freshness", async () => {
  const f = fixture((number) => {
    if (number === 1) return Response.json(payload(), { headers: { etag: '"catalog-1"' } })
    if (number === 2) return new Response(null, { status: 304 })
    return Response.json(payload([model({ id: "replacement-model" })]), { headers: { etag: '"catalog-2"' } })
  })
  const initial = await f.catalog.get()
  f.at(43_200_000 - 1)
  expect((await f.catalog.get()).catalog).toBe(initial.catalog)
  expect(f.calls).toHaveLength(1)

  f.at(43_200_000)
  const validated = await f.catalog.get()
  expect(validated.catalog).toBe(initial.catalog)
  expect(validated.fellBack).toBe(false)
  expect([...f.calls[1].init.headers]).toEqual([["if-none-match", '"catalog-1"']])
  f.at(86_400_000 - 1)
  await f.catalog.get()
  expect(f.calls).toHaveLength(2)
  f.at(86_400_000)
  expect((await f.catalog.get()).catalog.models[0].id).toBe("replacement-model")
  expect(f.calls).toHaveLength(3)
})

for (const status of [404, 405]) {
  test(`only ${status} compatibility fallback switches to the legacy public endpoint`, async () => {
    const f = fixture((number) => {
      if (number === 1) return Response.json(payload(), { headers: { etag: '"catalog-1"' } })
      if (number === 2) return new Response("legacy endpoint required", { status })
      return Response.json({ provider: "aside", models: [model({ id: "legacy-live-model" })] })
    })
    await f.catalog.get()
    const result = await f.catalog.get({ force: true })
    expect(result.fellBack).toBe(false)
    expect(result.catalog.models[0].id).toBe("legacy-live-model")
    expect(result.catalog.imageModels).toEqual([])
    expect(f.calls.map((call) => call.url.pathname)).toEqual(["/ai/catalog/v1", "/ai/catalog/v1", "/ai/models/v2"])
    expect([...f.calls[1].init.headers]).toEqual([["if-none-match", '"catalog-1"']])
    expect([...f.calls[2].init.headers]).toEqual([])
  })
}

for (const status of [401, 403, 429, 500]) {
  test(`a ${status} cold public failure throws without another endpoint or an auth call`, async () => {
    const f = fixture(() => new Response("unavailable", { status }))
    await expect(f.catalog.get()).rejects.toHaveProperty("status", status)
    expect(f.catalog.peek()).toBeUndefined()
    expect(f.calls.map((call) => call.url.pathname)).toEqual(["/ai/catalog/v1"])
    f.at(59_999)
    await expect(f.catalog.get()).rejects.toHaveProperty("status", status)
    expect(f.calls).toHaveLength(1)
  })
}

test("a failed refresh keeps the last complete live list, cools down, and can be forced", async () => {
  const f = fixture((number) => {
    if (number === 1) return Response.json(payload())
    if (number === 2) return new Response("unavailable", { status: 503 })
    return Response.json(payload([model({ id: "recovered-model" })]))
  })
  const live = await f.catalog.get()
  f.at(43_200_000)
  const failed = await f.catalog.get()
  expect(failed.fellBack).toBe(true)
  expect(failed.catalog).toBe(live.catalog)
  f.at(43_259_999)
  expect((await f.catalog.get()).fellBack).toBe(true)
  expect(f.calls).toHaveLength(2)

  const recovered = await f.catalog.get({ force: true })
  expect(recovered.fellBack).toBe(false)
  expect(recovered.catalog.models[0].id).toBe("recovered-model")
  expect(f.calls).toHaveLength(3)
})

test("the cooldown expires after sixty seconds without a background refresh", async () => {
  const f = fixture((number) => number === 1
    ? new Response("unavailable", { status: 500 })
    : Response.json(payload()))
  await expect(f.catalog.get()).rejects.toHaveProperty("status", 500)
  f.at(60_000)
  expect(f.calls).toHaveLength(1)
  expect((await f.catalog.get()).fellBack).toBe(false)
  expect(f.calls).toHaveLength(2)
})

test("an invalid model cannot replace part of a previously validated catalog", async () => {
  const f = fixture((number) => Response.json(number === 1 ? payload() : payload([
    model({ id: "valid-new-model" }),
    model({ id: "broken-new-model", maxTokens: 0 }),
  ])))
  const live = await f.catalog.get()
  const failed = await f.catalog.get({ force: true })
  expect(failed.fellBack).toBe(true)
  expect(failed.catalog).toBe(live.catalog)
  expect(failed.catalog.models.map((entry) => entry.id)).toEqual(["next-live-model"])
})

test("a cold 304 cannot invent a previously validated catalog", async () => {
  const f = fixture(() => new Response(null, { status: 304 }))
  await expect(f.catalog.get()).rejects.toHaveProperty("status", 304)
  expect(f.catalog.peek()).toBeUndefined()
  expect(f.calls).toHaveLength(1)
})

test("cancelled waiters reject without cancelling another caller's shared discovery", async () => {
  const pending = gate()
  const f = fixture(() => pending.promise)
  const controller = new AbortController()
  const reason = new Error("discovery cancelled")
  const cancelled = f.catalog.get({ signal: controller.signal })
  const survivor = f.catalog.get()
  controller.abort(reason)
  await expect(cancelled).rejects.toBe(reason)
  pending.resolve(Response.json(payload()))
  expect((await survivor).fellBack).toBe(false)
  expect(f.calls).toHaveLength(1)

  await expect(f.catalog.get({ force: true, signal: controller.signal })).rejects.toBe(reason)
  expect(f.calls).toHaveLength(1)
})

test("a real five-second public request deadline throws when no catalog has been fetched", async () => {
  const f = fixture((_number, _input, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true })
  }))
  await expect(f.catalog.get()).rejects.toHaveProperty("code", "ASIDE_API_TIMEOUT")
  expect(f.catalog.peek()).toBeUndefined()
  expect(f.calls).toHaveLength(1)
}, 7_000)

test("free/pro/max and unknown plans have distinct entitlements without claiming free pricing", () => {
  const catalog = payload([
    model({ id: "free-chat", supportsFastMode: true }),
    model({ id: "pro-responses", minPlan: "pro", api: "openai-responses" }),
    model({ id: "max-messages", minPlan: "max", api: "anthropic-messages" }),
  ], [{ id: "account-image", name: "Account Image" }])
  const unsigned = catalogModels(catalog, provider)
  expect(Object.keys(unsigned)).toEqual(["free-chat", "pro-responses", "max-messages", "account-image"])
  expect(unsigned["free-chat"].supportsFastMode).toBe(false)
  expect(unsigned["free-chat"].serviceTiers).toEqual([])
  expect(Object.keys(accountModels(catalog, provider, auth("free")))).toEqual(["free-chat", "account-image"])
  expect(Object.keys(accountModels(catalog, provider, auth("unknown")))).toEqual(["free-chat", "account-image"])
  expect(Object.keys(accountModels(catalog, provider, auth("pro")))).toEqual(["free-chat", "pro-responses", "account-image"])
  expect(Object.keys(accountModels(catalog, provider, auth("max")))).toEqual(["free-chat", "pro-responses", "max-messages", "account-image"])
  expect(Object.keys(accountModels(catalog, provider, undefined))).toEqual(["free-chat"])

  const free = accountModels(catalog, provider, auth("free"))["free-chat"]
  const pro = accountModels(catalog, provider, auth("pro"))["free-chat"]
  expect(free.supportsFastMode).toBe(false)
  expect(free.fast).toBe(false)
  expect(free.serviceTiers).toEqual([])
  expect(pro.supportsFastMode).toBe(true)
  expect(pro.fast).toBe(true)
  expect(pro.serviceTiers).toEqual(["priority"])
  expect(free.free).not.toBe(true)
  expect(pro.free).not.toBe(true)
})

test("temperature availability distinguishes GPT reasoning-only models from sampling-capable models", async () => {
  const f = fixture(() => Response.json(payload([
    model({ id: "gpt-reasoning-only", api: "openai-responses", availableThinkingLevels: ["low", "high"] }),
    model({ id: "gpt-switchable", api: "openai-responses" }),
    model({ id: "grok-reasoning-only", api: "openai-responses", availableThinkingLevels: ["low", "high"] }),
    model({ id: "gemini-reasoning-only", availableThinkingLevels: ["low", "high"] }),
    model({ id: "gpt-chat", reasoning: false }),
  ])))
  const { catalog } = await f.catalog.get()
  for (const models of [catalogModels(catalog, provider), accountModels(catalog, provider, auth("free"))]) {
    expect(models["gpt-reasoning-only"].capabilities.temperature).toBe(false)
    for (const id of ["gpt-switchable", "grok-reasoning-only", "gemini-reasoning-only", "gpt-chat"]) {
      expect(models[id].capabilities.temperature).toBe(true)
    }
  }
})

