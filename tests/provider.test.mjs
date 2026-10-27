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
