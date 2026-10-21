import { describe, expect, test } from "bun:test"
import { createApi, AsideApiError } from "../src/api.mjs"
import { createAccountManager } from "../src/accounts.mjs"
import { readAsideUsage } from "../src/usage.mjs"

const NOW = 1_000_000
const PERIOD_END = "2026-11-01T00:00:00Z"
const CREDIT_REFRESH = "2026-10-25T08:30:00Z"

function credential(name, fields = {}) {
  return {
    type: "oauth", access: `${name}-access`, refresh: `${name}-refresh`, expires: NOW + 3_600_000,
    credentialId: `${name}-credential`, accountId: `${name}@example.test`, uid: `${name}-uid`,
    asideAccountId: 0, subscriptionPlan: "max",
    asideDevice: { ikSigKeyFingerprint: `${name}-device`, ikSigPublicKeyJwk: { kty: "EC", crv: "P-256" } },
    ...fields,
  }
}

function subscription(fields = {}) {
  return {
    plan: { slug: "pro", name: "Aside Pro", tier: 1 }, status: "active", interval: "month",
    currentPeriodStart: "2026-10-01T00:00:00Z", currentPeriodEnd: PERIOD_END,
    cancelAtPeriodEnd: false, features: [], ...fields,
  }
}

function billing({ credit = {}, subscription: plan = subscription() } = {}) {
  return {
    joined_at: "2026-04-15T00:00:00Z", subscription: plan,
    credit: {
      add_on_balance_micros: "5000000", balance_micros: "40000000", credit_micros_per_usd: 1_000_000,
      monthly_grant_micros: "100000000", remaining_percent: 40, used_percent: 60,
      refresh_at: CREDIT_REFRESH, ...credit,
    },
  }
}

function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

function fixture({ auth = credential("alice"), value = billing(), reply } = {}) {
  const box = { auth, value, reply }
  const api = createApi({
    baseURL: "https://aside.example.test", now: () => NOW, sleep: async () => {},
    fetchImpl: async (url, init) => {
      const path = new URL(url).pathname
      if (path === "/auth/token/refresh") {
        return Response.json({ accessToken: "renewed-access", refreshToken: "renewed-refresh", expiresIn: 3600 })
      }
      if (path !== "/billing/subscription") throw new Error(`Unexpected endpoint: ${path}`)
      return box.reply ? box.reply(init) : Response.json(box.value)
    },
  })
  const client = { auth: { set: async ({ body }) => { box.auth = structuredClone(body) } } }
  const account = createAccountManager({ api, client }).session(async () => box.auth)
  return { box, account }
}

function counts(text) {
  return (text.match(/\d[\d,]*/g) ?? []).map((value) => BigInt(value.replaceAll(",", "")))
}

function time(value) {
  return value === undefined ? undefined : Date.parse(value)
}

describe("Aside account allowance", () => {
  test("live, trialing, inactive and absent subscriptions replace stale saved plan entitlements", async () => {
    const { box, account } = fixture()
    let usage = await readAsideUsage(account)
    expect(usage.plan).toBe("Aside Pro")
    expect(usage.renew).toBe("auto")

    box.value.subscription = subscription({
      status: "trialing", plan: { slug: "max", name: "Aside Max", tier: 2 },
    })
    usage = await readAsideUsage(account)
    expect(usage.plan).toBe("Aside Max")
    expect(usage.renew).toBe("auto")

    for (const status of ["past_due", "canceled", "unpaid", "incomplete", "paused", "unknown"]) {
      box.value.subscription.status = status
      usage = await readAsideUsage(account)
      expect(usage.plan).toBe("Free")
      expect(usage.until).toBeUndefined()
      expect(usage.renew).toBeUndefined()
      expect(usage.windows[0].used).toBe(60)
    }
    box.value.subscription = null
    usage = await readAsideUsage(account)
    expect(usage.plan).toBe("Free")
    expect(usage.windows[0].used).toBe(60)
    expect(box.auth.subscriptionPlan).toBe("max")
  })

  test("scheduled cancellation retains the live plan until its actual end, independently of the credit refresh", async () => {
    const { box, account } = fixture({ value: billing({ subscription: subscription({ cancelAtPeriodEnd: true }) }) })
    let usage = await readAsideUsage(account)
    expect(usage.plan).toBe("Aside Pro")
    expect(usage.renew).toBe("off")
    expect(time(usage.until)).toBe(Date.parse(PERIOD_END))
    expect(time(usage.windows[0].resetsAt)).toBe(Date.parse(CREDIT_REFRESH))
    expect(time(usage.until)).not.toBe(time(usage.windows[0].resetsAt))

    box.value.subscription.cancelAtPeriodEnd = false
    usage = await readAsideUsage(account)
    expect(usage.renew).toBe("auto")
    expect(time(usage.until)).toBe(Date.parse(PERIOD_END))
  })

  test("used percentage is authoritative even when wallet, grant and remaining percentage cannot reproduce it", async () => {
    const { account } = fixture({ value: billing({ credit: {
      used_percent: 42, remaining_percent: 61, balance_micros: "125000000",
      monthly_grant_micros: "150000000", add_on_balance_micros: "90000000",
    } }) })
    const usage = await readAsideUsage(account)
    const window = usage.windows[0]
    expect(window.used).toBe(42)
    expect(counts(window.display)).toEqual([12500n, 15000n])
    expect(counts(usage.balance)).toEqual([9000n])
    // A lone numeric limit makes Magpie show a fabricated zero spent amount.
    expect(Object.hasOwn(window, "amount")).toBe(false)
    expect(Object.hasOwn(window, "limit")).toBe(false)
  })

  for (const used of [0, 100]) {
    test(`the reported ${used}% endpoint stays authoritative with a positive add-on balance`, async () => {
      const { account } = fixture({ value: billing({ credit: { used_percent: used, remaining_percent: 37 } }) })
      const usage = await readAsideUsage(account)
      expect(usage.windows[0].used).toBe(used)
      expect(usage.windows[0].aside).toBe(true)
      expect(counts(usage.balance)).toEqual([500n])
      expect(counts(usage.windows[0].display)).toEqual([4000n, 10000n])
    })
  }

  test("display credits use the server scale, not a fixed micros-per-credit or a dollar amount", async () => {
    const { account } = fixture({ value: billing({ credit: {
      credit_micros_per_usd: 20_000, balance_micros: "5000", monthly_grant_micros: "200000",
      add_on_balance_micros: "10000",
    } }) })
    const usage = await readAsideUsage(account)
    expect(counts(usage.windows[0].display)).toEqual([25n, 1000n])
    expect(counts(usage.balance)).toEqual([50n])
  })

  for (const [raw, scale, expected] of [
    ["4999", 1_000_000, 0n],
    ["5000", 1_000_000, 1n],
    ["14999", 1_000_000, 1n],
    ["15000", 1_000_000, 2n],
    ["5000", 1_000_001, 0n],
    ["5001", 1_000_001, 1n],
    ["90071992547409934999", 1_000_000, 9007199254740993n],
    ["90071992547409935000", 1_000_000, 9007199254740994n],
  ]) {
    test(`credit rounding preserves the ${raw}/${scale} boundary without Number coercion`, async () => {
      const { account } = fixture({ value: billing({ credit: {
        credit_micros_per_usd: scale, balance_micros: raw, monthly_grant_micros: raw,
        add_on_balance_micros: raw,
      } }) })
      const usage = await readAsideUsage(account)
      expect(counts(usage.windows[0].display)).toEqual([expected, expected])
      expect(counts(usage.balance)).toEqual([expected])
      expect(usage.windows[0].used).toBe(60)
    })
  }

  test("missing optional identity, add-on and dates do not invent balances, cycle lengths or renew dates", async () => {
    const value = billing({ subscription: subscription({
      interval: "year", currentPeriodStart: "2026-01-01T00:00:00Z", currentPeriodEnd: null,
    }), credit: { refresh_at: "" } })
    delete value.credit.add_on_balance_micros
    const auth = credential("alice")
    delete auth.accountId
    const { account } = fixture({ auth, value })
    const usage = await readAsideUsage(account)
    const window = usage.windows[0]
    expect(usage.user).toBeUndefined()
    expect(usage.balance).toBeUndefined()
    expect(usage.until).toBeUndefined()
    expect(usage.renew).toBe("auto")
    expect(window.resetsAt).toBeUndefined()
    expect(window.span).toBeUndefined()
    expect(window.resetSecs).toBeUndefined()
    expect(window.runsOutAt).toBeUndefined()
    expect(window.used).toBe(60)
    expect(counts(window.display)).toEqual([4000n, 10000n])
  })

  test("unparseable reported dates remain unknown while valid balances and usage are preserved", async () => {
    const { account } = fixture({ value: billing({
      subscription: subscription({ currentPeriodEnd: "unavailable" }), credit: { refresh_at: "unavailable" },
    }) })
    const usage = await readAsideUsage(account)
    expect(usage.until).toBeUndefined()
    expect(usage.windows[0].resetsAt).toBeUndefined()
    expect(usage.windows[0].used).toBe(60)
    expect(counts(usage.windows[0].display)).toEqual([4000n, 10000n])
  })

  for (const [label, mutate] of [
    ["missing credit", (value) => { delete value.credit }],
    ["missing subscription", (value) => { delete value.subscription }],
    ["non-object subscription", (value) => { value.subscription = [] }],
    ["missing live plan", (value) => { delete value.subscription.plan }],
    ["unknown live plan", (value) => { value.subscription.plan.slug = "enterprise" }],
    ["invalid plan name", (value) => { value.subscription.plan.name = 7 }],
    ["missing subscription status", (value) => { delete value.subscription.status }],
    ["invalid cancellation state", (value) => { value.subscription.cancelAtPeriodEnd = "false" }],
    ["non-string period end", (value) => { value.subscription.currentPeriodEnd = 1700000000 }],
    ["missing used percentage", (value) => { delete value.credit.used_percent }],
    ["string used percentage", (value) => { value.credit.used_percent = "60" }],
    ["negative used percentage", (value) => { value.credit.used_percent = -1 }],
    ["over-range used percentage", (value) => { value.credit.used_percent = 101 }],
    ["fractional billing percentage", (value) => { value.credit.used_percent = 60.5 }],
    ["zero conversion scale", (value) => { value.credit.credit_micros_per_usd = 0 }],
    ["negative conversion scale", (value) => { value.credit.credit_micros_per_usd = -1 }],
    ["fractional conversion scale", (value) => { value.credit.credit_micros_per_usd = 10.5 }],
    ["inexact conversion scale", (value) => { value.credit.credit_micros_per_usd = Number.MAX_SAFE_INTEGER + 1 }],
    ["missing balance", (value) => { delete value.credit.balance_micros }],
    ["numeric balance", (value) => { value.credit.balance_micros = 40000000 }],
    ["negative balance", (value) => { value.credit.balance_micros = "-1" }],
    ["fractional balance", (value) => { value.credit.balance_micros = "1.5" }],
    ["missing monthly grant", (value) => { delete value.credit.monthly_grant_micros }],
    ["null add-on balance", (value) => { value.credit.add_on_balance_micros = null }],
    ["non-string refresh date", (value) => { value.credit.refresh_at = null }],
  ]) {
    test(`${label} fails visibly instead of reporting an unused allowance`, async () => {
      const value = billing()
      mutate(value)
      const { account } = fixture({ value })
      const error = await readAsideUsage(account).catch((failure) => failure)
      expect(error).toBeInstanceOf(AsideApiError)
      expect(error.status).toBe(502)
      expect(error.code).toBe("ASIDE_USAGE_INVALID_RESPONSE")
    })
  }

  for (const value of [null, [], {}, { error: "Billing data is unavailable" }]) {
    test(`an unstructured billing reply ${JSON.stringify(value)} is not an empty success`, async () => {
      const { account } = fixture({ value })
      await expect(readAsideUsage(account)).rejects.toHaveProperty("code", "ASIDE_USAGE_INVALID_RESPONSE")
    })
  }

  for (const status of [401, 403, 429, 503]) {
    test(`a billing ${status} remains a transport error with its original status and code`, async () => {
      const { account } = fixture({ reply: () => Response.json({ error: "Billing unavailable", code: "BILLING_READ_FAILED" }, { status }) })
      const error = await readAsideUsage(account).catch((failure) => failure)
      expect(error).toBeInstanceOf(AsideApiError)
      expect(error.status).toBe(status)
      expect(error.code).toBe("BILLING_READ_FAILED")
    })
  }

  test("invalid JSON after a successful read does not reuse a stale successful allowance", async () => {
    const { box, account } = fixture()
    expect((await readAsideUsage(account)).windows[0].used).toBe(60)
    box.reply = () => new Response("{not-json", { status: 200 })
    await expect(readAsideUsage(account)).rejects.toHaveProperty("code", "ASIDE_API_INVALID_RESPONSE")
  })

  test("on-demand token renewal allows the read without writing the returned billing plan into the profile", async () => {
    const { box, account } = fixture({ auth: credential("alice", { expires: NOW - 1 }) })
    const usage = await readAsideUsage(account)
    expect(usage.plan).toBe("Aside Pro")
    expect(usage.windows[0].used).toBe(60)
    expect(box.auth.access).toBe("renewed-access")
    expect(box.auth.refresh).toBe("renewed-refresh")
    expect(box.auth.credentialId).toBe("alice-credential")
    expect(box.auth.subscriptionPlan).toBe("max")
  })

  test("concurrent accounts keep their own allowance while one account's read is slow", async () => {
    const alice = credential("alice"), bob = credential("bob")
    const store = new Map([[alice.credentialId, alice], [bob.credentialId, bob]])
    const gate = deferred(), entered = deferred()
    const api = createApi({
      baseURL: "https://aside.example.test", now: () => NOW, sleep: async () => {},
      fetchImpl: async (url, init) => {
        if (new URL(url).pathname !== "/billing/subscription") throw new Error("Unexpected endpoint")
        if (init.headers.get("authorization") === "Bearer alice-access") {
          entered.resolve()
          await gate.promise
          return Response.json(billing({ credit: { used_percent: 73, balance_micros: "27000000" } }))
        }
        if (init.headers.get("authorization") === "Bearer bob-access") {
          return Response.json(billing({ subscription: subscription({ plan: { slug: "max", name: "Aside Max", tier: 2 } }),
            credit: { used_percent: 15, balance_micros: "85000000" } }))
        }
        return Response.json({ error: "Wrong account" }, { status: 401 })
      },
    })
    const client = { auth: { set: async ({ body }) => { store.set(body.credentialId, body) } } }
    const manager = createAccountManager({ api, client })
    const a = manager.session(async () => store.get(alice.credentialId))
    const b = manager.session(async () => store.get(bob.credentialId))
    const pending = readAsideUsage(a)
    await entered.promise
    try {
      const second = await readAsideUsage(b)
      expect(second.user).toBe("bob@example.test")
      expect(second.plan).toBe("Aside Max")
      expect(second.windows[0].used).toBe(15)
      expect(counts(second.windows[0].display)[0]).toBe(8500n)
    } finally {
      gate.resolve()
    }
    const first = await pending
    expect(first.user).toBe("alice@example.test")
    expect(first.plan).toBe("Aside Pro")
    expect(first.windows[0].used).toBe(73)
    expect(counts(first.windows[0].display)[0]).toBe(2700n)
  })

  test("a replacement sign-in during the billing response cannot receive the previous account's allowance", async () => {
    const gate = deferred(), entered = deferred()
    const alice = credential("alice"), bob = credential("bob")
    const { box, account } = fixture({ auth: alice, reply: async () => {
      entered.resolve()
      await gate.promise
      return Response.json(billing())
    } })
    const pending = readAsideUsage(account).catch((error) => error)
    await entered.promise
    box.auth = bob
    gate.resolve()
    const error = await pending
    expect(error).toBeInstanceOf(AsideApiError)
    expect(error.code).toBe("ASIDE_USAGE_ACCOUNT_CHANGED")
    expect(error.signIn).toBeUndefined()
    expect(box.auth.accountId).toBe("bob@example.test")

    box.reply = () => Response.json(billing({ subscription: null, credit: { used_percent: 11 } }))
    const next = await readAsideUsage(account)
    expect(next.user).toBe("bob@example.test")
    expect(next.plan).toBe("Free")
    expect(next.windows[0].used).toBe(11)
  })

  test("an account switch before sending cannot leak another account's data even if the original identity returns", async () => {
    const alice = credential("alice"), bob = credential("bob")
    const { box, account } = fixture({ auth: alice, reply: () => {
      box.auth = alice
      return Response.json(billing({ subscription: null, credit: { used_percent: 99 } }))
    } })
    const switching = {
      getAuth: account.getAuth,
      json: (path, options) => {
        box.auth = bob
        return account.json(path, options)
      },
    }
    const error = await readAsideUsage(switching).catch((failure) => failure)
    expect(error).toBeInstanceOf(AsideApiError)
    expect(error.code).toBe("ASIDE_USAGE_ACCOUNT_CHANGED")
    expect(error.signIn).toBeUndefined()
  })

  test("in-place changes to the vendor account identity cannot relabel an already pending allowance", async () => {
    const gate = deferred(), entered = deferred()
    const { box, account } = fixture({ reply: async () => {
      entered.resolve()
      await gate.promise
      return Response.json(billing())
    } })
    const pending = readAsideUsage(account).catch((error) => error)
    await entered.promise
    box.auth.accountId = "renamed@example.test"
    box.auth.uid = "different-vendor-user"
    gate.resolve()
    await expect(pending).resolves.toHaveProperty("code", "ASIDE_USAGE_ACCOUNT_CHANGED")
  })

  test("signing out during the billing response remains a sign-in error and cannot resurrect the account", async () => {
    const gate = deferred(), entered = deferred()
    const { box, account } = fixture({ reply: async () => {
      entered.resolve()
      await gate.promise
      return Response.json(billing())
    } })
    const pending = readAsideUsage(account).catch((error) => error)
    await entered.promise
    box.auth = undefined
    gate.resolve()
    const error = await pending
    expect(error).toBeInstanceOf(AsideApiError)
    expect(error.signIn).toBe("expired")
    expect(box.auth).toBeUndefined()
  })
})
