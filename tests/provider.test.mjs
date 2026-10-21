import { expect, test } from "bun:test"
import { MagpieAsidePlugin } from "../index.mjs"
import { createCredentialIdentity } from "../src/device.mjs"

function gate() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}
const model = (id, minPlan = "free") => ({ id, name: id, minPlan, reasoning: false, supportsReasoningEffort: false,
  supportsFastMode: false, contextWindow: 200000, maxTokens: 32000, availableThinkingLevels: ["off"] })

async function fixture() {
  const entered = gate(), release = gate()
  let current, writes = 0, refreshes = 0, profiles = 0, added = false
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname
    if (path === "/ai/catalog/v1") return Response.json({ provider: "aside",
      models: [model("public-model"), model("paid-model", "pro"), ...(added ? [model("newly-published-model")] : [])],
      imageModels: [{ id: "live-image-model", name: "Live Image" }] })
    if (path === "/auth/token/refresh") { refreshes++; return Response.json({ error: "Unexpected metadata renewal" }, { status: 500 }) }
    if (path === "/auth/me") {
      profiles++
      const a = request.headers.get("authorization") === "Bearer a-access"
      if (a) { entered.resolve(); await release.promise }
      return Response.json({ userId: a ? "a" : "b", email: `${a ? "a" : "b"}@example.test`, plan: a ? "pro" : "free" })
    }
    return new Response(null, { status: 404 })
  } })
  const api = server.url.href.replace(/\/$/, "")
  const hooks = await MagpieAsidePlugin({ client: { auth: { set: async ({ body }) => { writes++; current = body } } } }, { apiBaseUrl: api })
  const provider = { id: "aside", api: api + "/ai/v1", models: {} }
  const auth = async (id, fields = {}) => ({ type: "oauth", access: `${id}-access`, refresh: `${id}-refresh`, uid: id,
    accountId: `${id}@example.test`, expires: Date.now() + 3600000, ...await createCredentialIdentity(), ...fields })
  return { hooks, provider, auth, entered, release, stop: () => server.stop(true),
    get current() { return current }, set current(value) { current = value },
    counts: () => ({ writes, refreshes, profiles }), add: () => { added = true } }
}

test("finishing model discovery cannot resurrect a signed-out credential", async () => {
  const f = await fixture()
  try {
    const auth = await f.auth("a")
    f.current = auth
    const listing = f.hooks.provider.models(f.provider, { auth })
    await f.entered.promise
    f.current = undefined
    f.release.resolve()
    await listing
    expect(f.current).toBeUndefined()
    expect(f.counts().writes).toBe(0)
  } finally { f.release.resolve(); f.stop() }
})

test("a stale profile cannot overwrite a replacement sign-in or transfer its paid plan", async () => {
  const f = await fixture()
  try {
    const a = await f.auth("a"), b = await f.auth("b")
    f.current = a
    const stale = f.hooks.provider.models(f.provider, { auth: a })
    await f.entered.promise
    f.current = b
    f.release.resolve()
    await stale
    expect(f.current).toBe(b)
    const replacement = await f.hooks.provider.models(f.provider, { auth: b })
    expect(Object.keys(replacement)).toEqual(["public-model", "live-image-model"])
    expect(f.counts().writes).toBe(0)
  } finally { f.release.resolve(); f.stop() }
})

test("expired metadata uses its own cached plan while discovery fetches new IDs without token renewal", async () => {
  const f = await fixture()
  try {
    const auth = await f.auth("a", { expires: Date.now() - 1, subscriptionPlan: "pro" })
    f.current = auth
    const initial = await f.hooks.provider.models(f.provider, { auth })
    expect(Object.keys(initial)).toEqual(["public-model", "paid-model", "live-image-model"])
    f.add()
    const changed = await f.hooks.provider.models(f.provider, { auth })
    expect(Object.keys(changed)).toEqual(["public-model", "paid-model", "newly-published-model", "live-image-model"])
    expect(f.counts()).toEqual({ writes: 0, refreshes: 0, profiles: 0 })
    expect(f.current).toBe(auth)
  } finally { f.release.resolve(); f.stop() }
})

async function hostedSearchFixture() {
  let enabled = { web_search: false, x_search: false }
  const charges = { web: 0, x: 0 }
  const models = [
    { ...model("gpt-next"), api: "openai-responses" },
    { ...model("grok-next"), api: "openai-responses" },
    model("grok-chat"),
    { ...model("another-family"), api: "openai-responses" },
  ]
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (new URL(request.url).pathname === "/ai/catalog/v1") return Response.json({ provider: "aside", models, imageModels: [] })
    const body = await request.json()
    for (const tool of body.tools ?? []) {
      if (typeof tool?.type === "string" && tool.type.startsWith("web_search")) charges.web++
      if (tool?.type === "x_search") charges.x++
    }
    return Response.json({ id: "reply", output: [] })
  } })
  const auth = { type: "oauth", access: "access", refresh: "refresh", expires: Date.now() + 3600000,
    uid: "user", accountId: "user@example.test", ...await createCredentialIdentity() }
  const hooks = await MagpieAsidePlugin({ client: { auth: { set: async () => {} } },
    magpie: { option: (_provider, key) => enabled[key] } }, { apiBaseUrl: server.url.origin })
  const loader = await hooks.auth.loader(async () => auth)
  return {
    charges,
    enable(values) { enabled = values },
    async send(id, fields = {}) {
      const path = id === "grok-chat" ? "chat/completions" : "responses"
      const response = await loader.fetch(`${server.url.origin}/ai/v1/${path}`, {
        method: "POST", body: JSON.stringify({ model: id, input: "Hello", tools: [{ type: "function", name: "read_file", parameters: { type: "object" } }], ...fields }),
      })
      await response.arrayBuffer()
    },
    stop() { server.stop(true) },
  }
}

test("live hosted-search switches control extra charges independently and exclude other families and Chat", async () => {
  const f = await hostedSearchFixture()
  try {
    f.enable({ web_search: false, x_search: false })
    await f.send("grok-next")
    expect(f.charges).toEqual({ web: 0, x: 0 })
    f.enable({ web_search: true, x_search: false })
    await f.send("grok-next")
    expect(f.charges).toEqual({ web: 1, x: 0 })
    f.enable({ web_search: false, x_search: true })
    await f.send("grok-next")
    expect(f.charges).toEqual({ web: 1, x: 1 })
    f.enable({ web_search: true, x_search: true })
    await f.send("gpt-next")
    expect(f.charges).toEqual({ web: 2, x: 1 })
    await f.send("grok-chat")
    await f.send("another-family")
    expect(f.charges).toEqual({ web: 2, x: 1 })
    f.enable({ web_search: false, x_search: false })
    await f.send("grok-next")
    expect(f.charges).toEqual({ web: 2, x: 1 })
  } finally { f.stop() }
})

test("hosted-search switches cannot expand explicit tool restrictions or a turn without automatic tool use", async () => {
  const f = await hostedSearchFixture()
  try {
    f.enable({ web_search: true, x_search: true })
    for (const fields of [
      { tool_choice: "none" },
      { tool_choice: "required" },
      { tool_choice: { type: "function", name: "read_file" } },
      { tool_choice: { type: "allowed_tools", mode: "auto", tools: [{ type: "function", name: "read_file" }] } },
      { tools: [] },
      { tools: undefined },
    ]) await f.send("grok-next", fields)
    expect(f.charges).toEqual({ web: 0, x: 0 })
    await f.send("grok-next", { tool_choice: "auto", tools: [] })
    expect(f.charges).toEqual({ web: 1, x: 1 })
  } finally { f.stop() }
})

test("existing hosted search declarations are not duplicated into additional billable tools", async () => {
  const f = await hostedSearchFixture()
  try {
    f.enable({ web_search: true, x_search: true })
    for (const type of ["web_search", "web_search_preview"]) {
      await f.send("grok-next", { tools: [
        { type, filters: { allowed_domains: ["example.com"] } },
        { type: "x_search", allowed_x_handles: ["example"] },
      ] })
    }
    expect(f.charges).toEqual({ web: 2, x: 2 })
  } finally { f.stop() }
})
