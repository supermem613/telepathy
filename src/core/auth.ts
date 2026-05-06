// PSK derivation. The bootstrap secret is now bundled into a join token
// (see token.ts); this module turns that 8-byte secret into the 32-byte
// PSK used by tls-psk on both ends.

import { createHash } from "node:crypto";

export function secretToPsk(secret: Buffer): Buffer {
  return createHash("sha256").update("telepathy-psk-v1:").update(secret).digest();
}

export const PSK_IDENTITY = "telepathy";
export const PSK_CIPHERS = "PSK-CHACHA20-POLY1305:PSK-AES256-GCM-SHA384:PSK-AES128-GCM-SHA256";
