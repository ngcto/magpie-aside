import { AsideApiError } from "./api.mjs"

const PLAN_SLUGS = new Set(["free", "pro", "max"])
const CREDIT_FORMAT = new Intl.NumberFormat("en-US")
const CENTS_PER_USD = 100n

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
  const until = active && subscription.currentPeriodEnd !== null ? timestamp(subscription.currentPeriodEnd) : undefined

  return {
    plan: active ? subscription.plan.name || subscription.plan.slug : "Free",
    ...(typeof user === "string" && user.trim() ? { user } : {}),
    ...(active ? { renew: subscription.cancelAtPeriodEnd ? "off" : "auto" } : {}),
    ...(until !== undefined ? { until } : {}),
    ...(addOn !== undefined ? { balance: `Add-on: ${creditText(addOn, scale)}` } : {}),
    windows: [{
      name: "Monthly",
      used: credit.used_percent,
      // Billing does not establish when all spendable wallets are exhausted.
      // Preserve request admission by Aside; this meter is informational.
      aside: true,
      ...(resetsAt !== undefined ? { resetsAt } : {}),
      // The native quota uses used_percent and refresh_at. The billing UI shows
      // the grant and add-on separately, but does not establish whether balance
      // includes add-ons or how much of the monthly grant was spent. Show the
      // reported values without inventing a spent count or summing wallets.
      // Magpie displays 0 / limit when a numeric limit lacks an amount.
      display: `${creditText(balance, scale)} balance · ${creditText(grant, scale)} monthly allowance`,
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
