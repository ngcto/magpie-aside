# magpie-aside

Unofficial [Magpie provider plugin](https://usemagpie.ai/docs/plugins) for Aside's language and image-generation models. Email-code and Google sign-in; source-derived request headers; isolated credentials/devices; on-demand token renewal. No runtime dependencies beyond Magpie's Bun host.

## Install

From this checkout:

```sh
magpie plugin add .
magpie plugin login aside
magpie plugin --json
magpie provider models aside
```

The package/plugin name is **`magpie-aside`**. The provider ID is **`aside`**; clients select `aside/<model-id>`. Choose current IDs from Magpie's model list rather than a fixed list in this README.

This checkout is loaded in place. After editing it, restart Magpie's plugin host (disable/re-enable the plugin in the app, or start a new CLI command).

## Sign-in

- **Email code:** enter your email, then the six-digit verification code. Use the code, not the emailed link. No password or dummy API key is required.
- **Google:** complete the server-issued Google/Supabase flow in your browser. Aside's hosted page calls the plugin's receiver on **`127.0.0.1:21420`**. Allow the browser's local-network permission if prompted. Quit Aside or another process occupying that port before starting Google sign-in. The attempt expires after ten minutes; the listener closes after completion, failure, or expiry.

Magpie stores each account in its `plugin-auth.json` (mode `0600` on POSIX). The saved record contains access/refresh tokens, expiry, account identity, the credential's device registration, and its last known plan. OTPs, Supabase callback tokens, and opaque OAuth attempt tickets are not saved.

Each sign-in gets a new credential UUID and a fresh **P-256** software-installation public key. Device registration uses Aside's `p256_v1` format: an uncompressed 65-byte public key, its P-256 JWK, and `sha256:<hex>` over those raw public-key bytes. Only public registration data is retained; no native Aside keys or credentials are imported. The supplied client's macOS registration format is used on non-Windows hosts; Windows uses its Windows registration value. Conversations are namespaced by credential so accounts do not share upstream session/cache identities.

## Dynamic models

There is **no bundled model list**. Discovery reads Aside's public `/ai/catalog/v1`; only a `404`/`405` switches to the app's `/ai/models/v2` endpoint. Every model-discovery call revalidates the live catalog. New LLM and image IDs need no package release.

The catalog supplies names, API families, context/output limits, reasoning levels, image IDs, and minimum plans. LLMs retain their native Chat Completions, OpenAI Responses, or Anthropic Messages API; Magpie handles cross-protocol translation. Available models are filtered by the account's plan, not by hardcoded model-name prefixes.

Generation reuses the app's twelve-hour public-catalog cache. An outage can reuse only a previously fetched catalog; a cold failure is an error, not a fabricated fallback list. Model discovery is read-only: it does not refresh or rewrite credentials. When the access token is due, discovery uses that credential's cached plan until an authenticated request can renew the token.

## Requests and token renewal

Upstream headers are rebuilt from the shipped app's API and SDK code. Caller cookies, API keys, organization/project headers, and unrecognized headers are not forwarded. The native SDK version/detection fields and `pi (...)` User-Agent algorithm are mirrored; no plugin-specific backend header is added. Anthropic requests use the app's `x-api-key` token convention and beta path; OpenAI requests use Bearer authorization.

There is no `auth.refresh` hook, periodic renewal, or startup token-refresh timer. An authenticated request renews when fewer than **60 seconds** remain, or once after a `401` carrying `ACCESS_TOKEN_EXPIRED`, `ACCESS_TOKEN_INVALID`, or `ACCESS_TOKEN_STALE_CLAIMS`. Other `401` responses are not blindly retried.

Renewal is single-flight per credential and preserves the same device registration. It mirrors the app's three attempts, transient delays, forced-renewal reuse window, and on-demand cooldown. Removed or replaced credentials are not overwritten by an old renewal. LLM deadlines end when response headers arrive; caller cancellation remains active throughout the stream. Image generation retains its separate full-operation deadline.

## Images

Use Magpie's standard endpoints with an explicit `aside/<image-model-id>`:

- `POST /v1/images/generations`: JSON prompt and optional references.
- `POST /v1/images/edits`: JSON references or multipart image files.

The plugin maps both to Aside's single JSON `/ai/images/generations` request. Supported references are inline data URLs, `{data, mimeType}` objects, and multipart image files. Actual bytes determine MIME type. Limits: a trimmed prompt of 1–32,000 UTF-16 code units, at most 16 PNG/JPEG/WebP references, and at most 20 MiB of decoded reference data.

`n > 1` makes repeated native generations; every returned image is preserved. Responses use base64 or inline data URLs. No speculative upload endpoint, image-task polling, hosted URL, or billing metadata is invented.

Aside exposes no size, quality, background, output-format, or mask controls in this API. Explicit unsupported controls are rejected; `auto` values are accepted where applicable. The plugin does not download remote reference URLs. Chat-based drawing is supported without streaming; use the Images endpoints for image generation.

**Magpie limits:** arbitrary plugin subscriptions are currently absent from its automatic image-provider picker; explicit provider/model requests work. Its dedicated Images endpoints return completed JSON rather than partial-image SSE. This plugin does not expose a credit/quota hook.

## Verification

```sh
bun test
```

98 regression tests cover credential/refresh races, read-only model discovery, new catalog IDs, OAuth callback boundaries, MIME/size limits, cancellation, structured output, Fast-mode recovery, and timeout lifetimes.

Also exercised with real **Magpie 0.1.1307** and a strict local protocol emulator: email and Google CLI sign-in, native and translated LLM JSON/SSE, tool history, image generation and multipart editing, and lazy forced renewal. The live public catalog and default Google OAuth-start endpoint were observed separately. **Authenticated cloud generation, device acceptance, and token refresh were not exercised against a live Aside account.**

## Source provenance

Recovered without running the supplied macOS application:

- `Aside-1.0.928.1.dmg` SHA-256: `c6997299dc1ea7c0b15e3efbc6ebca104f331205c9bb83fb2b424c2c5500258c`.
- x64 `aside-daemon` SHA-256: `eb75fcc1becefb12ef9d09d1c720a59829facc61621d823e293d1735f8d6a6e4`.
- Its Node SEA JavaScript starts at file byte `104673386`, length `11790267`, SHA-256 `9012caa45761482f936ef5d3994fc39444eb9a96202cdb65e931c10d5faf0439`.

The native installation selector also confirms the P-256 software branch when Secure Enclave is unavailable. Only this implementation is shipped here, not Aside's recovered bundle.

For an explicitly configured Aside-compatible test/backend origin, the plugin accepts the `apiBaseUrl` option or the app's `ASIDE_API_URL` environment variable. Arbitrary upstream-header overrides are deliberately unsupported.
