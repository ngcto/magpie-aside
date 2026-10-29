# Repository Guidelines

## Project Overview

`magpie-aside` is a Magpie provider plugin for Aside language and image models. It supplies email-code/Google authentication, dynamic model discovery, protocol-specific requests, and account allowance reporting. Magpie hosts it; it is not a standalone application.

## Architecture & Data Flow

- `index.mjs` exports `MagpieAsidePlugin`, composing `config`, `auth`, `provider.models`, and `chat.headers` hooks. Host configuration is initialized without replacing existing user settings.
- **Discovery:** `src/catalog.mjs` reads the anonymous catalog, normalizes model SDK/API metadata, and filters entitlements using the supplied auth snapshot. Discovery must not renew or save credentials. Never hardcode model IDs or fabricate a cold-start catalog.
- **Requests:** the loader's custom fetch selects the model's declared protocol; `src/wire.mjs` prepares native headers/body, then `src/accounts.mjs` sends through `src/api.mjs`. Preserve upstream streaming and Magpie's cross-protocol translation. `src/images.mjs` handles JSON/multipart image requests separately.
- **Authentication:** `src/auth.mjs` implements email codes and automatic Google callbacks. `src/device.mjs` creates a fresh credential UUID and P-256 public registration for each sign-in; conversation identities are credential-namespaced.
- **Allowances:** `src/usage.mjs` reads billing through a live account session, checking ownership before dispatch and after completion. Financial micro-units use `BigInt`; numeric spent/limit counts require an explicitly empty add-on wallet and safe precision. Meters remain informational.

## Key Directories

- `src/`: implementation modules; extend the existing module responsible for the behavior.
- `tests/`: the single Bun suite, organized as `<module>.test.mjs`; fixtures are local/in-memory.
- No `scripts/`, generated distribution, or build-tool directory exists.

## Development Commands

Run from the repository root:

```sh
bun test                              # full suite; also bun run test
bun test tests/auth.test.mjs           # focused regression file
npm pack --dry-run                    # inspect the publication allowlist
magpie plugin add .                    # load this checkout in Magpie
magpie plugin login aside              # email code or automatic Google
magpie plugin --json                   # plugin status
magpie provider models aside           # discover current model IDs
magpie quota aside --json              # account allowance output
```

There are no configured build, lint, formatter, or standalone run commands. After source edits, restart the plugin host: disable/re-enable the plugin or use a new CLI process.

## Code Conventions & Common Patterns

- Native ESM `.mjs`, explicit relative imports, two-space indentation, double quotes, and no routine semicolons. Use `camelCase` functions/variables, `PascalCase` error classes, and uppercase constants.
- Prefer small factories with closure-owned state. Inject dependencies through `createApi({ fetchImpl, now, sleep })`, API/client objects, and identity factories rather than global mocks.
- Keep immutable discovery snapshots separate from live `getAuth` getters. Renewal is credential-scoped/single-flight; re-check identity and access/refresh values before persisting. Late work must not resurrect a removed account or overwrite its replacement.
- Do not add `auth.refresh`, startup renewal, or periodic refresh timers. Authenticated requests renew near expiry or replay once for recognized access-token 401 codes; other 401s are not blindly retried.
- Use `AsideApiError` status/code/details; terminal authentication failures use `signIn: "expired"`. Preserve cancellation reasons. A cancelled waiter must not abort another caller's shared renewal/discovery.
- Request preparation mutates bodies: retain structured-output constraints and original Fast intent across replay. Preserve native header allowlists and device wire fields, including intentional `macos` registration on non-Windows hosts.
- Preserve provider `searches: true` and explicit user opt-outs so client-declared native Grok X search survives host translation. Native Responses tool declarations, filters, and restrictions pass through unchanged; do not invent filters lost during cross-protocol translation.
- Images use byte-derived PNG/JPEG/WebP MIME validation. Do not fetch remote references, invent unsupported controls, or retry billable generations transiently.

## Important Files

- `package.json`: direct entry/export, sole test script, discovery metadata, and publication allowlist. SDK package names emitted in model metadata are host identifiers, not local dependencies.
- `src/api.mjs`: origin security, HTTP error conversion, retry and deadline boundaries.
- `src/accounts.mjs`: lazy renewal, stale-save guards, per-credential state, and request replay.
- `CHANGELOG.md`: update for consumer-visible behavior changes; historical entries may describe removed features.
- `LICENSE`: retain the MIT notice. Repository guidance lives here; do not recreate `README.md`.

## Runtime/Tooling Preferences

Use Bun for tests and local probes; Magpie runs the plugin in its Bun host. Tests require `bun:test` and `Bun.serve`; production also uses Node built-ins and modern Fetch/Abort/WebCrypto APIs. No dependencies, lockfile, package-manager pin, or minimum runtime version is declared. Source is packaged directly without transpilation.

API origin precedence is `options.apiBaseUrl` → `ASIDE_API_URL` → Aside's default API (`https://api.asidehq.com`). Use a loopback origin for isolated QA. Base URLs cannot contain credentials/query/fragment, and requests cannot leave their configured origin or follow redirects.

Grok native X search is available without plugin configuration: clients enable it by explicitly declaring an `x_search` tool in a Responses request. It may consume Aside allowance. The plugin does not inject hosted web/X search tools or expose search switches.

## Testing & QA

Add behavior regressions to the corresponding `tests/*.test.mjs`: boundaries, errors, account transitions/races, cancellation, bytes, and monetary precision—not incidental wording or source snapshots. Create fresh fixtures and auth stores; coordinate races with entry/release promises and injected clocks/delays, not arbitrary sleeps.

Use real loopback servers where transport matters, generally on port `0`; release gates and close servers/receivers in `finally`. Run affected files during iteration and the full suite before hand-off. Tests require local socket access, not live Aside credentials.

For hook/UI changes, smoke-test actual Magpie with an isolated account/backend. Google requires the browser to reach plugin-side `127.0.0.1:21420`, expires after ten minutes, and fails safely on occupied ports; callback port overrides are internal test support, not alternate OAuth redirects. Keep secrets and recovered application bundles out of repository files and fixtures.
