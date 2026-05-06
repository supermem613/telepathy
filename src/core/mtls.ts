// Phase 3 scaffold: Trust-on-First-Use (TOFU) mTLS option.
//
// The `selfsigned` dependency is installed and the cert/keypair generation
// API is wired up here, but the orchestrator's TLS server/client still use
// PSK by default. This keeps the wire format frozen for Phase 1 + 2 while
// leaving a clean place to layer mTLS on later (set TELEPATHY_AUTH=mtls).
//
// When enabled (a future code path):
//   1. On first start, generate a 4096-bit self-signed cert under
//      ~/.copilot/extensions/telepathy/certs/<machine>.{crt,key}.
//   2. The accept side advertises its cert fingerprint via the host code.
//   3. On connect, the client pins the fingerprint to a known-peers JSON
//      file (~/.copilot/extensions/telepathy/known_peers.json).
//   4. Subsequent connections fail loudly if the fingerprint changes.
//
// Until enabled, this module exists as a typed scaffold so the rest of
// the codebase doesn't need refactoring when we flip the switch.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export type CertBundle = {
  cert: string; // PEM
  key: string;  // PEM
  fingerprint: string; // SHA-256 of DER, hex with colons
};

const CERTS_DIR = join(homedir(), ".copilot", "extensions", "telepathy", "certs");
const KNOWN_PEERS_PATH = join(homedir(), ".copilot", "extensions", "telepathy", "known_peers.json");

export function ensureCertBundle(name: string): CertBundle {
  if (!existsSync(CERTS_DIR)) {
    mkdirSync(CERTS_DIR, { recursive: true });
  }
  const certPath = join(CERTS_DIR, `${name}.crt`);
  const keyPath  = join(CERTS_DIR, `${name}.key`);
  if (existsSync(certPath) && existsSync(keyPath)) {
    const cert = readFileSync(certPath, "utf8");
    const key = readFileSync(keyPath, "utf8");
    return { cert, key, fingerprint: fingerprintFromPem(cert) };
  }
  // Lazy-load selfsigned via createRequire so this module stays ESM-safe
  // and importable on builds where the dep didn't install (defense in depth).
  const selfsigned = require("selfsigned") as {
    generate(attrs: Array<{ name: string; value: string }>, opts: { keySize: number; days: number; algorithm: string }): { cert: string; private: string };
  };
  const result = selfsigned.generate(
    [{ name: "commonName", value: name }],
    { keySize: 2048, days: 365 * 5, algorithm: "sha256" },
  );
  writeFileSync(certPath, result.cert, { mode: 0o600 });
  writeFileSync(keyPath, result.private, { mode: 0o600 });
  return { cert: result.cert, key: result.private, fingerprint: fingerprintFromPem(result.cert) };
}

export function fingerprintFromPem(pem: string): string {
  const b64 = pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const der = Buffer.from(b64, "base64");
  const hash = createHash("sha256").update(der).digest("hex");
  return hash.match(/.{2}/g)!.join(":").toUpperCase();
}

export type KnownPeers = Record<string, { fingerprint: string; firstSeen: string }>;

export function loadKnownPeers(): KnownPeers {
  if (!existsSync(KNOWN_PEERS_PATH)) {
    return {};
  }
  try {
    return JSON.parse(readFileSync(KNOWN_PEERS_PATH, "utf8")) as KnownPeers;
  } catch {
    return {};
  }
}

export function recordKnownPeer(alias: string, fingerprint: string): void {
  const peers = loadKnownPeers();
  if (!peers[alias]) {
    peers[alias] = { fingerprint, firstSeen: new Date().toISOString() };
    writeFileSync(KNOWN_PEERS_PATH, JSON.stringify(peers, null, 2), { mode: 0o600 });
  }
}

export function verifyKnownPeer(alias: string, fingerprint: string): { ok: boolean; reason?: string } {
  const peers = loadKnownPeers();
  const known = peers[alias];
  if (!known) {
    return { ok: true }; // TOFU — first sight is trusted
  }
  if (known.fingerprint !== fingerprint) {
    return {
      ok: false,
      reason: `peer "${alias}" presented fingerprint ${fingerprint}, but we previously trusted ${known.fingerprint} (since ${known.firstSeen}). Either the peer regenerated its cert, or this is a different machine. To accept the new fingerprint, delete this entry from ${KNOWN_PEERS_PATH}.`,
    };
  }
  return { ok: true };
}
