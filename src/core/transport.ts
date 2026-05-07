// TLS-PSK transport with line-delimited JSON framing. Both the listener
// (accept side) and dialer (connect side) speak the same wire format.
//
// We use TLS-PSK (RFC 4279 / TLS 1.2 PSK ciphers) so the bootstrap code
// doubles as the encryption key — no certificate generation, no PKI, and
// no native dependencies. Phase 3 will add Entra device-cert mTLS as an
// optional upgrade path.

import { connect as tlsConnect, createServer as createTlsServer, type TLSSocket } from "node:tls";
import type { Server as TlsServer } from "node:tls";
import { createInterface } from "node:readline";
import { secretToPsk, PSK_CIPHERS, PSK_IDENTITY } from "./auth.js";
import type { Message } from "./protocol.js";

export type Frame = Message;

export type FrameHandler = (frame: Frame, socket: TLSSocket) => void | Promise<void>;

// A live listener whose accepted PSK can be hot-swapped without dropping
// any currently-connected sockets. TLS-PSK derives session keys at
// handshake time, so changing the PSK only affects FUTURE handshakes —
// the live sockets continue with the keys they already negotiated. This
// is what lets host-terminal re-pair invalidate the old token instantly
// while keeping any still-connected app/viewer alive.
//
// The optional `getExpiresAt` callback gates handshakes on TTL: if it
// returns a timestamp in the past, pskCallback returns null and the
// handshake fails. Pass undefined for "no TTL" (used by tests / future
// transports). The host wires this to acceptState.expiresAt.
export type TelepathyServer = TlsServer & {
  setSecret(secret: Buffer): void;
};

export function startListener(opts: {
  port: number;
  bindHost?: string;     // default: all interfaces
  secret: Buffer;
  onFrame: FrameHandler;
  onConnect?: (socket: TLSSocket) => void;
  onDisconnect?: (socket: TLSSocket, err?: Error) => void;
  // Returns the current absolute expiry timestamp (ms since epoch). When
  // Date.now() exceeds it, pskCallback returns null (handshake fails).
  // Omit for an always-valid listener (tests, future transports).
  getExpiresAt?: () => number;
  // Called synchronously the moment pskCallback commits to handing out
  // the PSK to a handshake (after identity + TTL checks pass, before
  // returning). The implementation should mutate the source-of-truth
  // expiry (e.g. flip expiresAt to 0) so the NEXT pskCallback hits the
  // TTL gate and returns null. This is what gives "single-use" semantics:
  // exactly one handshake can succeed per minted token. Concurrent dials
  // race; the loser sees the burnt token. The handshake-fails-after-PSK
  // case (rare: cipher mismatch / mid-handshake RST) burns the token
  // anyway — tradeoff for atomic single-use. Recovery = restart host or
  // rotate.
  onConsume?: () => void;
}): TelepathyServer {
  // Mutable PSK holder — `setSecret` swaps it in place. Closing over a
  // const Buffer would freeze the listener at startup PSK and force a
  // re-bind to rotate (which would drop live sockets). The closure here
  // stays the same; we just point it at a new Buffer.
  let psk = secretToPsk(opts.secret);
  const server = createTlsServer({
    pskCallback: (_socket, identity) => {
      // Server pskCallback returns the raw PSK (Buffer) or null. We accept
      // any non-empty identity — the secret is the only thing that matters.
      if (typeof identity !== "string" || identity.length === 0) {
        return null;
      }
      // Hard TTL gate: if the listener's current token has expired,
      // refuse the handshake. Live sockets stay up because their session
      // keys were derived at their own handshake; only NEW dials fail.
      if (opts.getExpiresAt && Date.now() > opts.getExpiresAt()) {
        return null;
      }
      // Single-use burn: commit to consuming the token NOW (synchronously,
      // before returning the PSK). Any concurrent or subsequent handshake
      // that re-enters pskCallback will see expiresAt flipped to 0 by
      // onConsume and fall through the TTL gate above.
      opts.onConsume?.();
      return psk;
    },
    ciphers: PSK_CIPHERS,
    minVersion: "TLSv1.2",
    maxVersion: "TLSv1.2",
  }, (socket) => {
    opts.onConnect?.(socket);
    attachFrameReader(socket, opts.onFrame);
    socket.on("close", () => opts.onDisconnect?.(socket));
    socket.on("error", (err) => opts.onDisconnect?.(socket, err));
  });
  if (opts.bindHost) {
    server.listen(opts.port, opts.bindHost);
  } else {
    server.listen(opts.port);
  }
  // Attach setSecret to the returned server so the host module can rotate
  // without reaching into transport internals. Cast: createTlsServer
  // returns a TlsServer; we extend it with one method, keeping the type
  // tight via the TelepathyServer alias.
  return Object.assign(server, {
    setSecret(newSecret: Buffer): void {
      psk = secretToPsk(newSecret);
    },
  }) as TelepathyServer;
}

export function dial(opts: {
  host: string;
  port: number;
  secret: Buffer;
  onFrame: FrameHandler;
  onClose?: (err?: Error) => void;
}): Promise<TLSSocket> {
  const psk = secretToPsk(opts.secret);
  return new Promise((resolve, reject) => {
    let settled = false;
    const socket = tlsConnect({
      host: opts.host,
      port: opts.port,
      pskCallback: () => ({ psk, identity: PSK_IDENTITY }),
      ciphers: PSK_CIPHERS,
      minVersion: "TLSv1.2",
      maxVersion: "TLSv1.2",
      checkServerIdentity: () => undefined, // PSK-authenticated; cert check N/A
      rejectUnauthorized: false,
    }, () => {
      if (!settled) {
        settled = true;
        attachFrameReader(socket, opts.onFrame);
        resolve(socket);
      }
    });
    socket.on("error", (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      } else {
        opts.onClose?.(err);
      }
    });
    socket.on("close", () => {
      if (settled) {
        opts.onClose?.();
      }
    });
  });
}

export function send(socket: TLSSocket, frame: Frame): void {
  socket.write(`${JSON.stringify(frame)}\n`);
}

function attachFrameReader(socket: TLSSocket, onFrame: FrameHandler): void {
  // Use readline — line-delimited JSON gives us a simple, robust frame
  // boundary without writing our own buffer-splitter. Each frame is a
  // single JSON object on its own line.
  //
  // SAFETY: readline.Interface re-emits source-stream errors. If the
  // underlying TLS socket dies (peer RST, handshake abort, etc.) and we
  // don't attach a handler here, Node treats it as an unhandled 'error'
  // event and crashes the process. Swallow it — the socket layer above
  // already surfaces the error via `onClose`/orchestrator hooks.
  const rl = createInterface({ input: socket, crlfDelay: Infinity });
  rl.on("error", () => undefined);
  socket.on("error", () => undefined);
  rl.on("line", (line) => {
    if (line.length === 0) {
      return;
    }
    let parsed: Frame;
    try {
      parsed = JSON.parse(line) as Frame;
    } catch {
      // Drop malformed lines silently — peer is misbehaving.
      return;
    }
    Promise.resolve(onFrame(parsed, socket)).catch(() => {
      // Handler errors don't kill the socket.
    });
  });
}
