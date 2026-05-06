import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { ensureCertBundle, fingerprintFromPem, loadKnownPeers, recordKnownPeer, verifyKnownPeer } from "../../src/core/mtls.js";

describe("mtls scaffold", () => {
  it("generates a cert bundle with a stable fingerprint", () => {
    const bundle = ensureCertBundle("test-host-" + Math.random().toString(36).slice(2, 8));
    assert.match(bundle.cert, /^-----BEGIN CERTIFICATE-----/);
    assert.match(bundle.key, /^-----BEGIN (RSA )?PRIVATE KEY-----/);
    assert.match(bundle.fingerprint, /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
  });

  it("fingerprintFromPem is deterministic", () => {
    const pem = `-----BEGIN CERTIFICATE-----\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA\n-----END CERTIFICATE-----\n`;
    assert.equal(fingerprintFromPem(pem), fingerprintFromPem(pem));
  });

  it("known-peer TOFU: first sight is trusted, mismatch is rejected", () => {
    const alias = "tofu-test-" + Math.random().toString(36).slice(2, 8);
    assert.equal(verifyKnownPeer(alias, "AA:BB").ok, true);
    recordKnownPeer(alias, "AA:BB");
    const same = verifyKnownPeer(alias, "AA:BB");
    assert.equal(same.ok, true);
    const diff = verifyKnownPeer(alias, "CC:DD");
    assert.equal(diff.ok, false);
    assert.match(diff.reason!, /presented fingerprint/);
  });

  it("loadKnownPeers returns the recorded entries", () => {
    const peers = loadKnownPeers();
    assert.equal(typeof peers, "object");
  });
});
