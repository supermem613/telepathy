// PSK derivation. The bootstrap secret is now bundled into a join token
// (see token.ts); this module turns that 8-byte secret into the 32-byte
// PSK used by tls-psk on both ends.

import { createHash } from "node:crypto";

export function secretToPsk(secret: Buffer): Buffer {
  return createHash("sha256").update("telepathy-psk-v1:").update(secret).digest();
}

export const PSK_IDENTITY = "telepathy";
// Intersection of Node 24 OpenSSL and Electron 42 BoringSSL PSK ciphers.
// We DON'T use the GCM variants (PSK-AES{128,256}-GCM-SHA*) because
// BoringSSL omits them — including them caused NO_CIPHER_MATCH when
// the dialer ran inside Electron and the listener inside Node.
//
// Order = preference. ECDHE-PSK-CHACHA20-POLY1305 is the modern AEAD
// option both stacks support; the CBC entries are universally available
// fallbacks for environments where ECDHE-PSK is disabled.
export const PSK_CIPHERS = "ECDHE-PSK-CHACHA20-POLY1305:ECDHE-PSK-AES256-CBC-SHA:ECDHE-PSK-AES128-CBC-SHA:PSK-AES256-CBC-SHA:PSK-AES128-CBC-SHA";
