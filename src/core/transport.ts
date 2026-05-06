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

export function startListener(opts: {
  port: number;
  bindHost?: string;     // default: all interfaces
  secret: Buffer;
  onFrame: FrameHandler;
  onConnect?: (socket: TLSSocket) => void;
  onDisconnect?: (socket: TLSSocket, err?: Error) => void;
}): TlsServer {
  const psk = secretToPsk(opts.secret);
  const server = createTlsServer({
    pskCallback: (_socket, identity) => {
      // Server pskCallback returns the raw PSK (Buffer) or null. We accept
      // any non-empty identity — the secret is the only thing that matters.
      if (typeof identity !== "string" || identity.length === 0) {
        return null;
      }
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
  return server;
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
