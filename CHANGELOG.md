# Changelog

## 0.1.0 — 2026-10-21

- Add the `magpie-aside` package and `aside` provider with dynamic LLM/image catalog discovery; no bundled model IDs.
- Integrate passwordless email-code and server-issued Google OAuth sign-in.
- Mirror Aside's native request headers and P-256 device-registration format with isolated state per credential.
- Renew tokens only on authenticated demand, with per-credential single-flight and stale-result guards.
- Support native Chat/Responses/Anthropic streaming and standard image-generation/edit adapters.
- Keep model discovery read-only; preserve structured-output constraints, Fast intent during auth recovery, and progressing stream lifetimes.
- Add one `tests/` suite and document cloud-verification and Magpie image-picker limitations.
