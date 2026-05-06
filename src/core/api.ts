// Public API surface used by src/commands/*. Each command module is a
// thin commander dispatcher; the real work lives here so it stays unit-
// testable and reusable.

import type { Server as TlsServer } from "node:tls";
import { createServer as createNetServer } from "node:net";
import { encodeToken, decodeToken, generateSecret, pickLocalIPv4 } from "./token.js";
import { dial, startListener } from "./transport.js";
import {
  adoptIncoming,
  adoptOutgoing,
  getLocalAlias,
  hasLocalPty,
  setLocalPty,
  type LocalPty,
} from "./orchestrator.js";
import {
  getPeer,
  listPeers,
  removePeer,
  type Peer,
} from "./peers.js";
import { DEFAULT_PORT } from "./protocol.js";

const ACCEPT_TOKEN_TTL_MS = 10 * 60 * 1000;

type AcceptState = {
  server: TlsServer;
  port: number;
  bindHost: string;
  advertisedHost: string;
  secret: Buffer;
  token: string;
  expiresAt: number;
};

let acceptState: AcceptState | undefined;

export type AcceptOptions = {
  port?: number;
  bind?: string;        // interface to bind to (e.g. "0.0.0.0", "127.0.0.1", "192.168.1.5")
  advertise?: string;   // IP to encode into the token (default: pickLocalIPv4)
};

export type AcceptResult = {
  token: string;
  addr: string;         // <advertisedHost>:<port>, what peers will dial
  bindHost: string;     // what we actually listen on
  expiresInSec: number;
};

export async function acceptStart(opts: AcceptOptions = {}): Promise<AcceptResult> {
  if (acceptState && acceptState.expiresAt > Date.now()) {
    return {
      token: acceptState.token,
      addr: `${acceptState.advertisedHost}:${acceptState.port}`,
      bindHost: acceptState.bindHost,
      expiresInSec: Math.round((acceptState.expiresAt - Date.now()) / 1000),
    };
  }
  if (acceptState) {
    acceptState.server.close();
    acceptState = undefined;
  }
  const advertisedHost = opts.advertise ?? pickLocalIPv4();
  // Bind on all interfaces by default. Advertising a specific IPv4 in the
  // token still tells peers where to dial, but binding to 0.0.0.0 lets
  // loopback + alternate NICs reach the listener too — which matters for
  // same-box testing and Windows Firewall edge cases. Override with --bind.
  const bindHost = opts.bind ?? "0.0.0.0";
  const secret = generateSecret();
  const fallbackAlias = getLocalAlias();
  // Default port strategy: try DEFAULT_PORT first (memorable, firewall-
  // friendly, predictable for `telepathy doctor`). If it's taken and the
  // user did NOT pass `-p`, fall back to OS-assigned (port 0) so a second
  // `telepathy host` on the same box "just works" — the token already
  // encodes the port (token.ts:42-44), so the dialer needs no extra
  // information. If `-p` was passed explicitly, do NOT auto-fall back:
  // the user asked for that port for a reason (firewall rule, dev setup),
  // so let EADDRINUSE bubble up to the caller for a loud error.
  let chosenPort: number;
  if (opts.port !== undefined) {
    chosenPort = opts.port;
  } else if (await isPortFree(DEFAULT_PORT, bindHost)) {
    chosenPort = DEFAULT_PORT;
  } else {
    chosenPort = 0;
  }
  const server = startListener({
    port: chosenPort,
    bindHost,
    secret,
    onFrame: () => undefined,
    onConnect: (socket) => adoptIncoming(socket, fallbackAlias),
  });
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const addr = server.address();
  if (!addr || typeof addr === "string") {
    throw new Error(`acceptStart: listener reported unexpected address ${JSON.stringify(addr)}`);
  }
  const port = addr.port;
  const token = encodeToken({ host: advertisedHost, port, secret });
  acceptState = {
    server,
    port,
    bindHost,
    advertisedHost,
    secret,
    token,
    expiresAt: Date.now() + ACCEPT_TOKEN_TTL_MS,
  };
  return {
    token,
    addr: `${advertisedHost}:${port}`,
    bindHost,
    expiresInSec: Math.round(ACCEPT_TOKEN_TTL_MS / 1000),
  };
}

function isPortFree(port: number, bindHost: string): Promise<boolean> {
  // Probe the same bindHost the real listener will use. Probing 127.0.0.1
  // when the real listener binds 0.0.0.0 would miss collisions where another
  // process bound to a specific NIC. Race-prone in theory (probe → real
  // listen window), but no concurrent telepathy starts realistically race
  // for the SAME default port.
  return new Promise((res) => {
    const probe = createNetServer();
    probe.once("error", () => res(false));
    probe.once("listening", () => probe.close(() => res(true)));
    probe.listen(port, bindHost);
  });
}

export function acceptStop(): boolean {
  if (!acceptState) {
    return false;
  }
  acceptState.server.close();
  acceptState = undefined;
  return true;
}

export type ConnectOptions = {
  token: string;
  alias?: string;
};

export type ConnectResult = {
  alias: string;
  remoteAlias: string;
  remoteAddr: string;
  hasPty: boolean;
};

export async function connectPeer(opts: ConnectOptions): Promise<ConnectResult> {
  let payload;
  try {
    payload = decodeToken(opts.token);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`invalid join token: ${msg}`, { cause: err });
  }
  const socket = await dial({
    host: payload.host,
    port: payload.port,
    secret: payload.secret,
    onFrame: () => undefined,
  });
  const peer = await adoptOutgoing(socket, opts.alias);
  return {
    alias: peer.alias,
    remoteAlias: peer.remoteAlias,
    remoteAddr: peer.remoteAddr,
    hasPty: !!peer.remoteCapabilities?.pty,
  };
}

export type PeerInfo = {
  alias: string;
  remoteAlias: string;
  remoteAddr: string;
  origin: "accepted" | "connected";
  hasPty: boolean;
  connectedAtIso: string;
};

export type ListenerInfo = {
  token: string;
  addr: string;
  bindHost: string;
  expiresInSec: number;
};

export function describePeers(): { peers: PeerInfo[]; listening?: ListenerInfo } {
  const out: PeerInfo[] = listPeers().map((p: Peer) => ({
    alias: p.alias,
    remoteAlias: p.remoteAlias,
    remoteAddr: p.remoteAddr,
    origin: p.origin,
    hasPty: !!p.remoteCapabilities?.pty,
    connectedAtIso: new Date(p.connectedAt).toISOString(),
  }));
  const listening = acceptState
    ? {
      token: acceptState.token,
      addr: `${acceptState.advertisedHost}:${acceptState.port}`,
      bindHost: acceptState.bindHost,
      expiresInSec: Math.max(0, Math.round((acceptState.expiresAt - Date.now()) / 1000)),
    }
    : undefined;
  return { peers: out, listening };
}

export function disconnectPeer(opts: { peer?: string }): { disconnected: string[] } {
  const targets = opts.peer ? [opts.peer] : listPeers().map((p) => p.alias);
  const disconnected: string[] = [];
  for (const alias of targets) {
    if (removePeer(alias)) {
      disconnected.push(alias);
    }
  }
  return { disconnected };
}

export function getPeerOrThrow(alias: string): Peer {
  const peer = getPeer(alias);
  if (!peer) {
    throw new Error(`unknown peer "${alias}". Run \`telepathy peers\` to list active links.`);
  }
  return peer;
}

// Expose orchestrator helpers the host wrapper needs to register its PTY.
export { setLocalPty, hasLocalPty, type LocalPty };
