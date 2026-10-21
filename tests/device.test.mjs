import { expect, test } from "bun:test"
import { createHash, webcrypto } from "node:crypto"
import { createCredentialIdentity } from "../src/device.mjs"
import { accountSessionId } from "../src/wire.mjs"

test("separate credentials have valid distinct installation keys and fingerprints", async () => {
  const a = await createCredentialIdentity(), b = await createCredentialIdentity()
  expect(a.credentialId).not.toBe(b.credentialId)
  expect(a.asideDevice.ikSigKeyFingerprint).not.toBe(b.asideDevice.ikSigKeyFingerprint)
  for (const identity of [a, b]) {
    const device = identity.asideDevice
    const key = await webcrypto.subtle.importKey("jwk", device.ikSigPublicKeyJwk,
      { name: "ECDSA", namedCurve: "P-256" }, true, ["verify"])
    const raw = Buffer.from(await webcrypto.subtle.exportKey("raw", key))
    expect(raw[0]).toBe(4)
    expect(raw.byteLength).toBe(65)
    expect(device.ikSigKeyFingerprint).toBe(`sha256:${createHash("sha256").update(raw).digest("hex")}`)
    expect(device).not.toHaveProperty("privateKey")
    expect(device.ikSigPublicKeyJwk).not.toHaveProperty("d")
  }
})

test("conversation identities are stable within a credential and cannot collide across accounts", async () => {
  const a = await createCredentialIdentity(), b = await createCredentialIdentity()
  const hint = "same-gateway-conversation"
  const id = accountSessionId(a, hint)
  expect(accountSessionId(structuredClone(a), hint)).toBe(id)
  expect(accountSessionId(b, hint)).not.toBe(id)
  expect(accountSessionId(a, "another-conversation")).not.toBe(id)
})
