import { describe, expect, test } from "bun:test"
import { createApi, AsideApiError } from "../src/api.mjs"
import { createAccountManager } from "../src/accounts.mjs"
import { createCredentialIdentity } from "../src/device.mjs"

function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

async function credential(name, expires) {
  return { type: "oauth", access: `${name}-access`, refresh: `${name}-refresh`, expires,
    accountId: `${name}@example.test`, uid: name, subscriptionPlan: "pro", ...await createCredentialIdentity() }
}

function harness(initial, refreshReply) {
  const box = { auth: initial, now: 1_000_000, refreshes: 0, writes: [], delays: [] }
  const api = createApi({
    baseURL: "https://aside.example.test", now: () => box.now,
    sleep: async (delay) => { box.delays.push(delay); box.now += delay },
    fetchImpl: async (url, init) => {
      if (new URL(url).pathname === "/auth/token/refresh") {
        box.refreshes++
        return refreshReply(box.refreshes, JSON.parse(init.body))
      }
      return Response.json({ userId: "user", plan: "pro" })
    },
  })
  const client = { auth: { set: async ({ body }) => { box.writes.push(body); box.auth = structuredClone(body) } } }
  const manager = createAccountManager({ api, client })
  const session = manager.session(async () => box.auth)
  return { box, api, manager, session }
}

const tokens = (name = "new") => Response.json({ accessToken: `${name}-access`, refreshToken: `${name}-refresh`, expiresIn: 3600 })

 describe("Aside on-demand sessions", () => {
  test("reading/loading expired credentials is inert; the first authenticated use renews them", async () => {
    const auth = await credential("idle", 999_000)
    const { box, session } = harness(auth, () => tokens())
    expect((await session.getAuth()).access).toBe("idle-access")
    expect(box.refreshes).toBe(0)
    expect(box.writes).toEqual([])
    expect((await session.request("/auth/me")).status).toBe(200)
    expect(box.auth.access).toBe("new-access")
    expect(box.auth.refresh).toBe("new-refresh")
    expect(box.auth.expires).toBe(4_600_000)
    expect(box.auth.credentialId).toBe(auth.credentialId)
    expect(box.auth.asideDevice).toEqual(auth.asideDevice)
    expect(box.auth.accountId).toBe(auth.accountId)
    expect(box.auth.subscriptionPlan).toBe("pro")
  })

  test("the 60-second expiry boundary is strict and no renewal happens while idle", async () => {
    const { box, session } = harness(await credential("boundary", 1_060_000), () => tokens())
    await session.request("/auth/me")
    expect(box.refreshes).toBe(0)
    box.now++
    await session.request("/auth/me")
    expect(box.refreshes).toBe(1)
    box.now += 3_600_000
    expect((await session.getAuth()).refresh).toBe("new-refresh")
    expect(box.refreshes).toBe(1)
  })

  test("concurrent use shares one renewal, while another credential can finish independently", async () => {
    const alice = await credential("alice", 999_000)
    const bob = await credential("bob", 999_000)
    const gate = deferred(), entered = deferred()
    const store = new Map([[alice.credentialId, alice], [bob.credentialId, bob]])
    const refreshCounts = new Map()
    const api = createApi({ baseURL: "https://aside.example.test", now: () => 1_000_000,
      fetchImpl: async (url, init) => {
        if (!new URL(url).pathname.endsWith("/refresh")) return Response.json({ ok: true })
        const body = JSON.parse(init.body)
        const name = body.refreshToken.startsWith("alice") ? "alice" : "bob"
        refreshCounts.set(name, (refreshCounts.get(name) ?? 0) + 1)
        if (name === "alice") { entered.resolve(); await gate.promise }
        return tokens(name + "-new")
      } })
    const client = { auth: { set: async ({ body }) => { store.set(body.credentialId, body) } } }
    const manager = createAccountManager({ api, client })
    const a = manager.session(async () => store.get(alice.credentialId))
    const b = manager.session(async () => store.get(bob.credentialId))
    const a1 = a.request("/auth/me"), a2 = a.request("/auth/me")
    await entered.promise
    expect((await b.request("/auth/me")).status).toBe(200)
    expect(store.get(bob.credentialId).access).toBe("bob-new-access")
    expect(store.get(alice.credentialId).access).toBe("alice-access")
    gate.resolve()
    await Promise.all([a1, a2])
    expect([...refreshCounts]).toEqual([["alice", 1], ["bob", 1]])
    expect(store.get(alice.credentialId).asideDevice).toEqual(alice.asideDevice)
    expect(store.get(bob.credentialId).asideDevice).toEqual(bob.asideDevice)
  })

  test("a rotated session supersedes a slow renewal without losing the new credentials", async () => {
    const gate = deferred(), entered = deferred()
    const auth = await credential("stale", 999_000)
    const { box, session } = harness(auth, async () => { entered.resolve(); await gate.promise; return tokens("obsolete") })
    const request = session.request("/auth/me")
    await entered.promise
    box.auth = { ...auth, access: "external-access", refresh: "external-refresh", expires: 5_000_000 }
    gate.resolve()
    expect((await request).status).toBe(200)
    expect(box.auth.access).toBe("external-access")
    expect(box.auth.refresh).toBe("external-refresh")
    expect(box.writes).toEqual([])
  })

  test("signing out during renewal never resurrects the removed credential", async () => {
    const gate = deferred(), entered = deferred()
    const { box, session } = harness(await credential("removed", 999_000), async () => { entered.resolve(); await gate.promise; return tokens() })
    const result = session.request("/auth/me").catch((error) => error)
    await entered.promise
    box.auth = undefined
    gate.resolve()
    const error = await result
    expect(error.signIn).toBe("expired")
    expect(box.auth).toBeUndefined()
    expect(box.writes).toEqual([])
  })

  test("an old renewal cannot overwrite a replacement sign-in to a different device", async () => {
    const gate = deferred(), entered = deferred()
    const { box, session } = harness(await credential("old", 999_000), async () => { entered.resolve(); await gate.promise; return tokens("obsolete") })
    const request = session.request("/auth/me")
    await entered.promise
    const next = await credential("replacement", 5_000_000)
    box.auth = next
    gate.resolve()
    expect((await request).status).toBe(200)
    expect(box.auth).toEqual(next)
    expect(box.writes).toEqual([])
  })

  test("a cancelled waiter does not abort the shared renewal or another waiter", async () => {
    const gate = deferred(), entered = deferred()
    const { box, session } = harness(await credential("cancel", 999_000), async () => { entered.resolve(); await gate.promise; return tokens() })
    const controller = new AbortController()
    const cancelled = session.request("/auth/me", { signal: controller.signal }).catch((error) => error)
    const survivor = session.request("/auth/me")
    await entered.promise
    controller.abort(new DOMException("Cancelled", "AbortError"))
    expect((await cancelled).name).toBe("AbortError")
    gate.resolve()
    expect((await survivor).status).toBe(200)
    expect(box.refreshes).toBe(1)
    expect(box.auth.access).toBe("new-access")
  })

  test("a generic 401 is returned unchanged rather than spending a refresh token", async () => {
    const auth = await credential("generic", 5_000_000)
    const { box, api, manager } = harness(auth, () => tokens())
    const denied = { error: "Not allowed", code: "OTHER_AUTH_ERROR" }
    api.request = async () => Response.json(denied, { status: 401 })
    const response = await manager.session(async () => box.auth).request("/auth/me")
    expect(response.status).toBe(401)
    expect(await response.json()).toEqual(denied)
    expect(box.refreshes).toBe(0)
    expect(box.writes).toEqual([])
  })

  test("only recognized access-token errors cause one forced renewal and replay", async () => {
    const { box, api, manager } = harness(await credential("force", 5_000_000), () => tokens())
    const request = api.request
    let attempts = 0
    api.request = async (path, options) => {
      if (path === "/auth/me" && ++attempts === 1) return Response.json({ error: "Access token expired", code: "ACCESS_TOKEN_EXPIRED" }, { status: 401 })
      return request(path, options)
    }
    const response = await manager.session(async () => box.auth).request("/auth/me")
    expect(response.status).toBe(200)
    expect(box.refreshes).toBe(1)
    expect(attempts).toBe(2)
    expect(box.auth.refresh).toBe("new-refresh")
  })

  test("transient failures preserve the account and only back off later demanded renewals", async () => {
    const auth = await credential("transient", 999_000)
    const { box, session } = harness(auth, () => Response.json({ error: "Server busy" }, { status: 503 }))
    const first = await session.request("/auth/me").catch((error) => error)
    expect(first.status).toBe(503)
    expect(box.refreshes).toBe(3)
    expect(box.delays).toEqual([1000, 3000])
    expect(box.auth).toEqual(auth)
    await session.request("/auth/me").catch(() => {})
    expect(box.refreshes).toBe(3)
    box.now += 120000
    await session.request("/auth/me").catch(() => {})
    expect(box.refreshes).toBe(6)
    expect(box.auth).toEqual(auth)
  })

  test("revocation marks only the refused credential and a new sign-in can recover", async () => {
    const { box, session } = harness(await credential("revoked", 999_000), () => Response.json({ error: "Token revoked", code: "REFRESH_TOKEN_REVOKED" }, { status: 401 }))
    const error = await session.request("/auth/me").catch((error) => error)
    expect(error).toBeInstanceOf(AsideApiError)
    expect(error.signIn).toBe("expired")
    expect(box.refreshes).toBe(3)
    expect(box.delays).toEqual([])
    await session.request("/auth/me").catch(() => {})
    expect(box.refreshes).toBe(3)
    box.auth = await credential("reauthenticated", 5_000_000)
    expect((await session.request("/auth/me")).status).toBe(200)
    expect(box.auth.accountId).toBe("reauthenticated@example.test")
  })
})
