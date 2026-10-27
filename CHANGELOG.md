# Changelog

## 0.1.7 — 2026-10-27

- Remove automatic hosted web-search injection for GPT/Grok and both Native web search / Native X search plugin options.
- Keep Grok native X search available without plugin configuration: retain hosted-tool capability and caller-declared tools/filters, but never inject search tools or override tool restrictions.

## 0.1.6 — 2026-10-26

- Omit `context_management` on Aside's Messages endpoint, which rejects Claude Code's server-side context-editing directives with a 400. Preserve the supplied conversation history, thinking, structured output, caching, and tools; client-side context management remains the caller's responsibility.
- Leave Responses context-management settings and unrelated upstream validation errors unchanged.

## 0.1.5 — 2026-10-25

- Avoid GPT reasoning-request 400s by removing incompatible temperature, top-p, and log-probability controls before dispatch; retain structured output and unrelated response includes.
- Preserve sampling and log probabilities for explicit none/off requests when the live GPT catalog supports disabled reasoning, and leave other model families' sampling controls unchanged.
- Stop advertising temperature for GPT models whose catalog has no disabled-reasoning variant. Omitted GPT effort is treated conservatively because the catalog does not declare the server default.

## 0.1.4 — 2026-10-21

- Declare native hosted search so GPT/Grok Responses requests retain web/X search tools instead of being rewritten as generic search.
- Add off-by-default Native web search and Native X search switches in Aside's provider editor for clients using ordinary function tools or translated APIs.
- Keep explicit tool restrictions, existing search filters, and user-configured native-search opt-outs; do not inject X search into GPT or Chat models.
- Cover live opt-in changes, billing boundaries, and duplicate hosted-tool prevention.

## 0.1.3 — 2026-10-21

- Remove the third Google paste-callback sign-in method and its parser, tests, and current instructions.
- Keep email-code and automatic Google sign-in.
- Use WorkBuddy-style native credit counts when the spent amount is known safely; retain authoritative percentages.
- Hide zero add-ons, show positive add-ons inline, and avoid an inferred Monthly/Pace cycle.
- Do not show paid renewal metadata on free plans.

## 0.1.2 — 2026-10-21

- Add account-scoped usage and allowance reporting from Aside's authenticated billing subscription endpoint.
- Show current plan, renewal/reset dates, authoritative usage percentage, balances, monthly allowance, and separate add-on credits.
- Preserve exact credit rounding and reject stale cross-account reads.
- Keep allowance meters informational so monthly exhaustion does not block add-on spending.
- Document stock Magpie's provider-placement and inline OAuth callback limitations.

## 0.1.1 — 2026-10-21

- Add Google OAuth paste-callback-URL sign-in for remote or hosted Magpie, without a loopback listener.
- Document capturing the final Supabase redirect's `Location` header before Aside clears the callback URL.
- Use Aside's HTTPS icon URL in both plugin and provider metadata.
- Align package and README branding with Aside.
- Cover manual callback correlation, expiry, credential isolation, and transient-secret redaction.

## 0.1.0 — 2026-10-21

- Add the `magpie-aside` package and `aside` provider with dynamic LLM/image catalog discovery; no bundled model IDs.
- Integrate passwordless email-code and server-issued Google OAuth sign-in.
- Mirror Aside's native request headers and P-256 device-registration format with isolated state per credential.
- Renew tokens only on authenticated demand, with per-credential single-flight and stale-result guards.
- Support native Chat/Responses/Anthropic streaming and standard image-generation/edit adapters.
- Keep model discovery read-only; preserve structured-output constraints, Fast intent during auth recovery, and progressing stream lifetimes.
- Add one `tests/` suite and document cloud-verification and Magpie image-picker limitations.
