import { AsideApiError } from "./api.mjs"

const PLAN_SLUGS = new Set(["free", "pro", "max"])
const CREDIT_FORMAT = new Intl.NumberFormat("en-US")
const CENTS_PER_USD = 100n
const MAX_NUMERIC_CREDIT_HUNDREDTHS = BigInt(Number.MAX_SAFE_INTEGER) / 100n

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function invalidUsage() {
  throw new AsideApiError(502, "Aside returned invalid account allowance data.", "ASIDE_USAGE_INVALID_RESPONSE")
}

function micros(value) {
  if (typeof value !== "string" || !/^\d+$/.test(value)) invalidUsage()
  return BigInt(value)
}

function timestamp(value) {
  if (typeof value !== "string") invalidUsage()
  const time = Date.parse(value)
  // Aside's parseResetTimestamp omits an unavailable or unparseable date.
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined
}

function creditText(value, microsPerUsd) {
  // Aside's add-on-credits-dialog We/Je display USD-cent-equivalent credits,
  // rounded half up using the returned scale, not a fixed micros-per-credit.
  const credits = (value * CENTS_PER_USD + microsPerUsd / 2n) / microsPerUsd
  return `${CREDIT_FORMAT.format(credits)} ${credits === 1n ? "credit" : "credits"}`
}

function numericCredits(value, microsPerUsd) {
  const hundredths = (value * CENTS_PER_USD * 100n + microsPerUsd / 2n) / microsPerUsd
  return hundredths <= MAX_NUMERIC_CREDIT_HUNDREDTHS ? Number(hundredths) / 100 : undefined
}

function mapBilling(billing, user) {
  if (!object(billing) || !object(billing.credit) ||
      (billing.subscription !== null && !object(billing.subscription))) invalidUsage()
  const subscription = billing.subscription
  if (subscription && (!object(subscription.plan) || !PLAN_SLUGS.has(subscription.plan.slug) ||
      typeof subscription.plan.name !== "string" || typeof subscription.status !== "string" ||
      typeof subscription.cancelAtPeriodEnd !== "boolean" ||
      (subscription.currentPeriodEnd !== null && typeof subscription.currentPeriodEnd !== "string"))) invalidUsage()

  const credit = billing.credit
  if (!Number.isInteger(credit.used_percent) || credit.used_percent < 0 || credit.used_percent > 100 ||
      !Number.isSafeInteger(credit.credit_micros_per_usd) || credit.credit_micros_per_usd <= 0) invalidUsage()
  const scale = BigInt(credit.credit_micros_per_usd)
  const balance = micros(credit.balance_micros)
  const grant = micros(credit.monthly_grant_micros)
  const addOn = credit.add_on_balance_micros === undefined ? undefined : micros(credit.add_on_balance_micros)
  const resetsAt = timestamp(credit.refresh_at)
  // syncCachedSubscriptionPlanFromBilling treats active and trialing as live;
  // canceled, past-due and all other inactive subscriptions have the free plan.
  const active = subscription && (subscription.status === "active" || subscription.status === "trialing")
  const paid = active && subscription.plan.slug !== "free"
  const until = paid && subscription.currentPeriodEnd !== null ? timestamp(subscription.currentPeriodEnd) : undefined
  // With an explicitly empty add-on wallet, the grant minus its remaining
  // balance is a known spent count. Other wallet combinations stay separate.
  const limit = addOn === 0n ? numericCredits(grant, scale) : undefined
  const amount = limit > 0 && balance <= grant ? numericCredits(grant - balance, scale) : undefined
  const counted = amount !== undefined && limit > 0

  return {
    plan: active ? subscription.plan.name || subscription.plan.slug : "Free",
    ...(typeof user === "string" && user.trim() ? { user } : {}),
    ...(paid ? { renew: subscription.cancelAtPeriodEnd ? "off" : "auto" } : {}),
    ...(until !== undefined ? { until } : {}),
    windows: [{
      name: "Credits",
      used: credit.used_percent,
      // Billing does not establish when all spendable wallets are exhausted.
      // Preserve request admission by Aside; this meter is informational.
      aside: true,
      ...(resetsAt !== undefined ? { resetsAt } : {}),
      ...(counted ? {
        amount, limit, unit: "credits",
        display: `${CREDIT_FORMAT.format(amount)} / ${CREDIT_FORMAT.format(limit)}`,
      } : {
        // Unknown wallet composition or unsafe numeric precision must not
        // become a fabricated zero spent amount or lose an add-on balance.
        display: `${creditText(balance, scale)} balance · ${creditText(grant, scale)} allowance` +
          (addOn > 0n && (addOn * CENTS_PER_USD + scale / 2n) / scale > 0n ? ` · ${creditText(addOn, scale)} add-on` : ""),
      }),
    }],
  }
}

function owner(auth) {
  return {
    credentialId: auth.credentialId,
    fingerprint: auth.asideDevice?.ikSigKeyFingerprint,
    asideAccountId: auth.asideAccountId,
    uid: auth.uid,
    accountId: auth.accountId,
  }
}

function assertOwner(before, after) {
  if (before.credentialId !== after.credentialId || before.fingerprint !== after.fingerprint ||
      before.asideAccountId !== after.asideAccountId || before.uid !== after.uid || before.accountId !== after.accountId) {
    throw new AsideApiError(409, "Aside account changed while its allowance was being read. Read it again.", "ASIDE_USAGE_ACCOUNT_CHANGED")
  }
}

export async function readAsideUsage(account) {
  // Snapshot identity values, not the mutable auth object. Token rotation is
  // permitted; a replacement sign-in must never receive the old account's read.
  const before = owner(await account.getAuth())
  const billing = await account.json("/billing/subscription", {
    timeoutMs: 60000,
    headers: (auth) => {
      assertOwner(before, owner(auth))
      return { authorization: `Bearer ${auth.access}` }
    },
  })
  assertOwner(before, owner(await account.getAuth()))
  return mapBilling(billing, before.accountId)
}
