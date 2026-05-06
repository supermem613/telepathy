// One-shot join token: bundles IP + port + secret so the dialer can
// connect with a single paste and no out-of-band discovery.
//
// Wire layout (14 bytes):
//   bytes 0..3   IPv4 address (big-endian octets)
//   bytes 4..5   TCP port (big-endian uint16)
//   bytes 6..13  8-byte random secret (used as PSK seed)
//
// Encoding: RFC 4648 base32 (no padding) prefixed with "TLP1." and
// grouped with dashes for legibility:
//
//   TLP1.AAAAA-BBBBB-CCCCC-DDDDD-EE
//
// The "TLP1." prefix is a recognizable marker and a version stamp; if
// the wire layout ever changes we'll bump to TLP2 and refuse old tokens
// with a helpful error.

import { networkInterfaces } from "node:os";
import { randomBytes } from "node:crypto";

const PREFIX = "TLP1.";

// RFC 4648 base32 alphabet.
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const B32_INDEX = new Map(Array.from(B32, (c, i) => [c, i] as const));

export type TokenPayload = {
  host: string;          // dotted-quad IPv4
  port: number;
  secret: Buffer;        // 8 bytes
};

export function encodeToken(payload: TokenPayload): string {
  const ip = parseIPv4(payload.host);
  if (!ip) {
    throw new Error(`encodeToken: not an IPv4 address: "${payload.host}"`);
  }
  if (payload.port <= 0 || payload.port > 65535) {
    throw new Error(`encodeToken: invalid port ${payload.port}`);
  }
  if (payload.secret.length !== 8) {
    throw new Error(`encodeToken: secret must be 8 bytes, got ${payload.secret.length}`);
  }
  const buf = Buffer.alloc(14);
  ip.copy(buf, 0);
  buf.writeUInt16BE(payload.port, 4);
  payload.secret.copy(buf, 6);
  const b32 = base32Encode(buf);
  return `${PREFIX}${groupDashes(b32, 5)}`;
}

export function decodeToken(token: string): TokenPayload {
  const cleaned = token.trim().replace(/[\s_]/g, "");
  if (!cleaned.toUpperCase().startsWith(PREFIX)) {
    throw new Error(`decodeToken: missing "${PREFIX}" prefix — did you copy the whole token?`);
  }
  const body = cleaned.slice(PREFIX.length).replace(/-/g, "").toUpperCase();
  const buf = base32Decode(body);
  if (buf.length !== 14) {
    throw new Error(`decodeToken: token decodes to ${buf.length} bytes, expected 14`);
  }
  const host = `${buf[0]}.${buf[1]}.${buf[2]}.${buf[3]}`;
  const port = buf.readUInt16BE(4);
  const secret = Buffer.from(buf.subarray(6, 14));
  return { host, port, secret };
}

export function pickLocalIPv4(): string {
  // Pick the first non-internal, non-virtual IPv4 interface. Prefer
  // interfaces whose name doesn't start with the usual virtual prefixes.
  const ifaces = networkInterfaces();
  type Candidate = { addr: string; iface: string; score: number };
  const candidates: Candidate[] = [];
  for (const [name, addrs] of Object.entries(ifaces)) {
    if (!addrs) {
      continue;
    }
    for (const a of addrs) {
      if (a.family !== "IPv4" || a.internal) {
        continue;
      }
      let score = 0;
      const lower = name.toLowerCase();
      // Penalize obviously-virtual NICs.
      if (/(vethernet|vmware|virtualbox|hyper-?v|docker|wsl|loopback)/.test(lower)) {
        score -= 10;
      }
      // Prefer common physical NIC names.
      if (/^(eth|en|wlan|wi-?fi|ethernet)/.test(lower)) {
        score += 5;
      }
      // Slight preference for non-link-local.
      if (a.address.startsWith("169.254.")) {
        score -= 5;
      }
      candidates.push({ addr: a.address, iface: name, score });
    }
  }
  if (candidates.length === 0) {
    return "127.0.0.1"; // Last resort; the dialer must be on the same machine.
  }
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0]!.addr;
}

export function generateSecret(): Buffer {
  return randomBytes(8);
}

// --- internals --------------------------------------------------------------

function parseIPv4(s: string): Buffer | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) {
    return null;
  }
  const buf = Buffer.alloc(4);
  for (let i = 0; i < 4; i++) {
    const n = parseInt(m[i + 1]!, 10);
    if (n < 0 || n > 255) {
      return null;
    }
    buf[i] = n;
  }
  return buf;
}

function base32Encode(buf: Buffer): string {
  let out = "";
  let bits = 0;
  let value = 0;
  for (let i = 0; i < buf.length; i++) {
    value = (value << 8) | buf[i]!;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += B32[(value >>> bits) & 0b11111];
    }
  }
  if (bits > 0) {
    out += B32[(value << (5 - bits)) & 0b11111];
  }
  return out;
}

function base32Decode(s: string): Buffer {
  const bytes: number[] = [];
  let bits = 0;
  let value = 0;
  for (const ch of s) {
    const v = B32_INDEX.get(ch);
    if (v === undefined) {
      throw new Error(`decodeToken: unexpected character "${ch}" — token contains base32 letters A-Z and digits 2-7 only`);
    }
    value = (value << 5) | v;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >>> bits) & 0xff);
    }
  }
  return Buffer.from(bytes);
}

function groupDashes(s: string, group: number): string {
  const parts: string[] = [];
  for (let i = 0; i < s.length; i += group) {
    parts.push(s.slice(i, i + group));
  }
  return parts.join("-");
}
