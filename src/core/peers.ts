// In-memory peer registry. Lost on /clear (extension reload), which is
// acceptable for Phase 1 — the user explicitly accepts/connects each time.
//
// A "peer" is a live, authenticated link to another telepathy instance.
// Either side of a link looks the same in the registry — once the TLS
// handshake completes and hellos are exchanged, the link is symmetric.

import type { TLSSocket } from "node:tls";
import { send, type Frame } from "./transport.js";

export type PeerStatus = "connected" | "disconnected";

export type PendingRequest = {
  resolve: (frame: Frame) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
};

export type Peer = {
  alias: string;            // Display name (e.g., "box-B")
  remoteAlias: string;      // Alias the remote announced
  socket: TLSSocket;
  status: PeerStatus;
  origin: "accepted" | "connected";
  remoteAddr: string;       // host:port of the peer (best-effort)
  connectedAt: number;
  pending: Map<string, PendingRequest>;
  remoteCapabilities?: { pty?: boolean };
};

const peers = new Map<string, Peer>();

export function listPeers(): Peer[] {
  return Array.from(peers.values());
}

export function getPeer(alias: string): Peer | undefined {
  return peers.get(alias);
}

export function addPeer(peer: Peer): void {
  peers.set(peer.alias, peer);
}

export function removePeer(alias: string): Peer | undefined {
  const peer = peers.get(alias);
  if (peer) {
    peers.delete(alias);
    for (const pending of peer.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`Peer "${alias}" disconnected`));
    }
    peer.pending.clear();
    try {
      peer.socket.end();
    } catch {
      // Already closed — ignore.
    }
  }
  return peer;
}

export function pickAlias(requested: string | undefined, fallback: string): string {
  const base = (requested ?? fallback).trim() || fallback;
  if (!peers.has(base)) {
    return base;
  }
  // Disambiguate on collision: box-B → box-B-2 → box-B-3 ...
  let n = 2;
  while (peers.has(`${base}-${n}`)) {
    n += 1;
  }
  return `${base}-${n}`;
}

export function sendRequest<T extends Frame>(
  peer: Peer,
  frame: Frame & { id: string },
  timeoutMs: number,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      peer.pending.delete(frame.id);
      reject(new Error(`Request "${frame.type}" timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    peer.pending.set(frame.id, {
      resolve: (response) => resolve(response as T),
      reject,
      timer,
    });
    try {
      send(peer.socket, frame);
    } catch (err) {
      clearTimeout(timer);
      peer.pending.delete(frame.id);
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}
