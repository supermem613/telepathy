import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { secretToPsk } from "../../src/core/auth.js";
import { generateSecret } from "../../src/core/token.js";

describe("auth.PSK_CIPHERS — Electron/BoringSSL compatibility", () => {
  it("only contains ciphers in the Node-OpenSSL ↔ Electron-BoringSSL intersection", async () => {
    const { PSK_CIPHERS } = await import("../../src/core/auth.js");
    const tls = await import("node:tls");
    const nodeCiphers = new Set(tls.getCiphers());
    // Known to be in Electron 42 BoringSSL (verified empirically in this commit).
    const electronCiphers = new Set([
      "ecdhe-psk-aes128-cbc-sha",
      "ecdhe-psk-aes256-cbc-sha",
      "ecdhe-psk-chacha20-poly1305",
      "psk-aes128-cbc-sha",
      "psk-aes256-cbc-sha",
    ]);
    for (const cipher of PSK_CIPHERS.split(":")) {
      const lower = cipher.toLowerCase();
      assert.ok(nodeCiphers.has(lower), `Node OpenSSL doesn't have ${cipher}`);
      assert.ok(electronCiphers.has(lower), `Electron BoringSSL doesn't have ${cipher} — would cause NO_CIPHER_MATCH`);
    }
  });
});

describe("auth.secretToPsk", () => {
  it("returns a 32-byte PSK", () => {
    const psk = secretToPsk(generateSecret());
    assert.equal(psk.length, 32);
  });

  it("is deterministic for the same secret", () => {
    const s = generateSecret();
    assert.deepEqual(secretToPsk(s), secretToPsk(s));
  });

  it("differs for different secrets", () => {
    const a = secretToPsk(generateSecret());
    const b = secretToPsk(generateSecret());
    assert.notDeepEqual(a, b);
  });
});
