import { createHash, randomUUID, webcrypto } from "node:crypto"
import os from "node:os"

export const ASIDE_VERSION = "1.26.928.1922"

// Aside's software installation branch uses P-256; PQ requires a macOS 26 Secure Enclave.
export async function createDeviceRegistration() {
  const keys = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])
  const raw = Buffer.from(await webcrypto.subtle.exportKey("raw", keys.publicKey))
  return {
    appVersion: ASIDE_VERSION,
    ...(os.hostname() ? { deviceName: os.hostname() } : {}),
    platform: process.platform === "win32" ? "windows" : "macos",
    installationScheme: "p256_v1",
    ikSigPublicKeyJwk: {
      kty: "EC", crv: "P-256",
      x: raw.subarray(1, 33).toString("base64url"),
      y: raw.subarray(33, 65).toString("base64url"),
      ext: true, key_ops: ["verify"],
    },
    ikSigKeyFingerprint: `sha256:${createHash("sha256").update(raw).digest("hex")}`,
  }
}

export async function createCredentialIdentity() {
  return {
    credentialId: randomUUID(),
    // Each credential is an isolated installation's first local account, not the server user id.
    asideAccountId: 0,
    asideDevice: await createDeviceRegistration(),
  }
}
