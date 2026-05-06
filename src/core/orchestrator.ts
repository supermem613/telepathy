// Inbound frame dispatcher. Both accepted and connected peers feed frames
// here; the dispatcher decides what to do with each message type.
//
// Standalone build: there is no copilot extension, no ACP bridge, no
// notify/send agent layer. The orchestrator handles the hello handshake,
// PTY subscribe/frame routing, and connection lifecycle. The send/notify
// message types remain reserved in the protocol for a future agent layer.

import type { TLSSocket } from "node:tls";
import { send as sendFrame } from "./transport.js";
import {
  addPeer,
  getPeer,
  listPeers,
  removePeer,
  pickAlias,
  type Peer,
} from "./peers.js";
import type {
  HelloMessage,
  HelloAckMessage,
  Message,
} from "./protocol.js";
import type { Frame } from "./transport.js";
import { isDebug } from "./debug.js";
import { buildReplayWithModes } from "./dec-modes.js";
import { handleSpawnHostRequest } from "./spawn-host.js";

export type LocalPty = {
  state: {
    cols: number;
    rows: number;
    ringBuffer: Buffer;
    // Explicit DEC private mode state (CSI ?Nh / ?Nl) seen so far. Both
    // directions tracked because some modes default to set (?25 cursor,
    // ?7 wrap). Prepended to remote-peer replays so late joiners enter
    // the host's current mode state BEFORE the ring's playback —
    // without this, a wall connecting after the ring rolled past the
    // initial mode-set sequences ends up in main-buffer mode and every
    // TUI redraw scrolls instead of overwriting.
    enabledDecModes: Map<string, boolean>;
    subscribers: Set<(frame: { dataBase64: string }) => void>;
    resizeSubscribers: Set<(size: { cols: number; rows: number }) => void>;
  };
  injectInput: (dataBase64: string) => void;
  requestResize: (cols: number, rows: number) => void;
  close: () => void;
};

export type OrchestratorEvents = {
  onNotify?: (peer: Peer, message: string) => void;
  onPeerConnected?: (peer: Peer) => void;
  onPeerDisconnected?: (peer: Peer, reason?: string) => void;
  onRemoteFrame?: (peer: Peer, dataBase64: string) => void;
  onRemoteResize?: (peer: Peer, cols: number, rows: number) => void;
};

let listeners: OrchestratorEvents = {};
let localPty: LocalPty | null = null;

// Subscribers to a remote peer's PTY (we are the watcher).
const remotePtySubs = new Map<string, { id: string; cols: number; rows: number }>();

// Local PTY subscribers we serve to remote peers (we are the host).
const localPtyServingSubs = new Map<string, () => void>();

// Pending pty_subscribe requests received before the local PTY existed.
// Drained when setLocalPty(non-null) is called.
const pendingPtySubscribes: Array<{ peer: Peer; id: string }> = [];

// Hooks fired when the first peer connects (used by `telepathy host` to
// race "peer arrives" against "user presses any key" before spawning the
// shell). Cleared after first fire — only the first connection wakes them.
let onFirstPeerHooks: Array<(peer: Peer) => void> = [];

export function setOrchestratorEvents(events: OrchestratorEvents): void {
  listeners = events;
}

// Like setOrchestratorEvents, but merges into the existing listener set
// rather than replacing it. Useful when multiple subsystems (e.g. the
// viewer + the connect-command UI) want to observe the same events
// without stomping on each other's handlers. For each key, both the
// previous handler (if any) AND the new one fire.
export function addOrchestratorEvents(events: OrchestratorEvents): void {
  const prev = listeners;
  const next: OrchestratorEvents = { ...prev };
  for (const key of Object.keys(events) as (keyof OrchestratorEvents)[]) {
    const incoming = events[key];
    const existing = prev[key];
    if (!incoming) {
      continue;
    }
    if (!existing) {
      next[key] = incoming as never;
      continue;
    }
    // Both exist — chain them. Use a per-key wrapper that calls both.
    next[key] = ((...args: unknown[]) => {
      try {
        (existing as (...a: unknown[]) => void)(...args); 
      } catch { /* ignore */ }
      try {
        (incoming as (...a: unknown[]) => void)(...args); 
      } catch { /* ignore */ }
    }) as never;
  }
  listeners = next;
}

export function setLocalPty(pty: LocalPty | null): void {
  localPty = pty;
  if (pty && pendingPtySubscribes.length > 0) {
    const queue = pendingPtySubscribes.splice(0);
    for (const req of queue) {
      servePtySubscribe(req.peer, req.id);
    }
  }
}

export function hasLocalPty(): boolean {
  return localPty !== null;
}

export function onFirstPeerConnect(handler: (peer: Peer) => void): () => void {
  onFirstPeerHooks.push(handler);
  return () => {
    onFirstPeerHooks = onFirstPeerHooks.filter((h) => h !== handler);
  };
}

export function getRemotePtySize(alias: string): { cols: number; rows: number } | null {
  const sub = remotePtySubs.get(alias);
  return sub ? { cols: sub.cols, rows: sub.rows } : null;
}

export function getLocalAlias(): string {
  // Hostname is the natural identity. Override via env for test isolation.
  return (process.env.TELEPATHY_ALIAS ?? process.env.COMPUTERNAME ?? process.env.HOSTNAME ?? "host").toLowerCase();
}

// Called from transport.startListener after a fresh inbound TLS handshake.
// Performs the hello exchange, then registers the peer.
export function adoptIncoming(socket: TLSSocket, requestedAliasFallback: string): void {
  let helloHandled = false;
  let peer: Peer | undefined;
  socket.on("close", () => {
    if (peer) {
      removePeer(peer.alias);
      listeners.onPeerDisconnected?.(peer, "closed");
    }
  });
  socket.on("error", (err) => {
    if (peer) {
      removePeer(peer.alias);
      listeners.onPeerDisconnected?.(peer, err.message);
    }
  });
  // Wait for the hello frame from the dialer; promote to a Peer once seen.
  const onFirst = (frame: Frame): void => {
    if (helloHandled) {
      handleFrameForPeer(peer!, frame);
      return;
    }
    if (frame.type !== "hello") {
      sendFrame(socket, { type: "error", message: "expected hello frame" });
      socket.end();
      return;
    }
    helloHandled = true;
    const alias = pickAlias(undefined, frame.alias || requestedAliasFallback);
    peer = makePeer({
      alias,
      remoteAlias: frame.alias,
      socket,
      origin: "accepted",
      remoteAddr: `${socket.remoteAddress ?? "?"}:${socket.remotePort ?? "?"}`,
      remoteCapabilities: frame.capabilities,
    });
    addPeer(peer);
    const ack: HelloAckMessage = {
      type: "hello_ack",
      alias: getLocalAlias(),
      protocolVersion: 1,
      capabilities: { pty: hasLocalPty() },
    };
    sendFrame(socket, ack);
    listeners.onPeerConnected?.(peer);
    fireFirstPeerHooks(peer);
  };
  // Re-route subsequent frames through handleFrameForPeer once peer exists.
  // The transport layer attached its own readline reader; we override by
  // setting our own handler at the call site.
  attachReader(socket, onFirst, () => {
    if (peer) {
      // Subsequent frames forwarded.
      // (handleFrameForPeer is called inside the closure, which captures peer.)
    }
  });
}

// Called from cli/tools when user runs telepathy_connect.
export async function adoptOutgoing(socket: TLSSocket, requestedAlias?: string): Promise<Peer> {
  const remoteAddr = `${socket.remoteAddress ?? "?"}:${socket.remotePort ?? "?"}`;
  let adoptedPeer: Peer | undefined;
  // Wire close/error notifications EARLY so we surface a disconnect even if
  // it arrives after adoption (e.g. host's shell exits → host process exits
  // → TLS socket closes → dialer must clean up its term/browser viewer).
  socket.on("close", () => {
    if (adoptedPeer) {
      removePeer(adoptedPeer.alias);
      listeners.onPeerDisconnected?.(adoptedPeer, "closed");
    }
  });
  socket.on("error", (err) => {
    if (adoptedPeer) {
      removePeer(adoptedPeer.alias);
      listeners.onPeerDisconnected?.(adoptedPeer, err.message);
    }
  });
  return new Promise<Peer>((resolve, reject) => {
    const hello: HelloMessage = {
      type: "hello",
      alias: getLocalAlias(),
      protocolVersion: 1,
      capabilities: { pty: hasLocalPty() },
    };
    sendFrame(socket, hello);
    let resolved = false;
    const fail = (msg: string): void => {
      if (!resolved) {
        resolved = true;
        reject(new Error(msg));
        try {
          socket.end();
        } catch {
          /* ignore */
        }
      }
    };
    const onFrame = (frame: Frame): void => {
      if (!resolved) {
        if (frame.type !== "hello_ack") {
          fail(`expected hello_ack, got ${frame.type}`);
          return;
        }
        resolved = true;
        const alias = pickAlias(requestedAlias, frame.alias || "peer");
        const peer = makePeer({
          alias,
          remoteAlias: frame.alias,
          socket,
          origin: "connected",
          remoteAddr,
          remoteCapabilities: frame.capabilities,
        });
        addPeer(peer);
        adoptedPeer = peer;
        listeners.onPeerConnected?.(peer);
        fireFirstPeerHooks(peer);
        resolve(peer);
        return;
      }
      // Subsequent frames go through normal dispatch.
      const existing = getPeer((frame as { _peerHint?: string })._peerHint ?? "")
        ?? listPeers().find((p) => p.socket === socket);
      if (existing) {
        handleFrameForPeer(existing, frame);
      }
    };
    attachReader(socket, onFrame, () => fail("socket closed before hello_ack"));
    setTimeout(() => fail("hello_ack timeout"), 5000);
  });
}

// ---- Frame dispatch ---------------------------------------------------------

function handleFrameForPeer(peer: Peer, frame: Message): void {
  switch (frame.type) {
    case "send":
    case "notify": {
      // The standalone build doesn't run an agent. Reject so the dialer
      // surfaces a clear error instead of timing out.
      const id = "id" in frame && typeof frame.id === "string" ? frame.id : undefined;
      if (frame.type === "send") {
        sendFrame(peer.socket, {
          type: "send_result",
          id: id ?? "",
          ok: false,
          error: "this build of telepathy does not run a local agent (no copilot extension); use telepathy_attach for terminal mirroring instead",
          events: [],
        });
      } else {
        // notify: ack so the sender's request resolves; otherwise no surface.
        sendFrame(peer.socket, { type: "notify_ack", id: id ?? "" });
        listeners.onNotify?.(peer, frame.message);
      }
      return;
    }
    case "send_result":
    case "notify_ack":
    case "pong":
    case "error": {
      const id = "id" in frame ? frame.id : undefined;
      if (typeof id === "string") {
        const pending = peer.pending.get(id);
        if (pending) {
          peer.pending.delete(id);
          clearTimeout(pending.timer);
          pending.resolve(frame);
        }
      }
      return;
    }
    case "ping":
      sendFrame(peer.socket, { type: "pong", id: frame.id });
      return;
    case "pty_subscribe": {
      if (!localPty) {
        // Defer: queue this subscribe and answer it when setLocalPty(non-null) fires.
        pendingPtySubscribes.push({ peer, id: frame.id });
        return;
      }
      servePtySubscribe(peer, frame.id);
      return;
    }
    case "pty_unsubscribe":
      localPtyServingSubs.get(peer.alias)?.();
      localPtyServingSubs.delete(peer.alias);
      return;
    case "pty_input":
      // Remote peer sent keystrokes for our local PTY.
      if (localPty) {
        localPty.injectInput(frame.dataBase64);
      }
      return;
    case "pty_input_resize":
      // Remote peer (viewer) is telling us their xterm dimensions.
      // Resize our local PTY to match so TUIs render for the right
      // viewport. No-op when no localPty (rare race; next subscribe-ack
      // will report the still-stale size and the next resize fixes it).
      if (isDebug()) {
        process.stderr.write(`[telepathy/orch] pty_input_resize from ${peer.alias} ${frame.cols}x${frame.rows}\n`);
      }
      if (localPty) {
        localPty.requestResize(frame.cols, frame.rows);
      }
      return;
    case "pty_frame":
      // We are the watcher; the host is streaming frames to us.
      listeners.onRemoteFrame?.(peer, frame.dataBase64);
      return;
    case "pty_resize":
      if ("cols" in frame && "rows" in frame) {
        const sub = remotePtySubs.get(peer.alias);
        if (sub) {
          sub.cols = frame.cols;
          sub.rows = frame.rows;
        }
        listeners.onRemoteResize?.(peer, frame.cols, frame.rows);
      }
      return;
    case "pty_subscribe_ack": {
      // Reply to our outbound subscribe — surface size info to listeners.
      if (frame.ok && typeof frame.cols === "number" && typeof frame.rows === "number") {
        remotePtySubs.set(peer.alias, { id: frame.id, cols: frame.cols, rows: frame.rows });
        if (frame.replayBase64) {
          listeners.onRemoteFrame?.(peer, frame.replayBase64);
        }
        listeners.onRemoteResize?.(peer, frame.cols, frame.rows);
      }
      const pending = peer.pending.get(frame.id);
      if (pending) {
        peer.pending.delete(frame.id);
        clearTimeout(pending.timer);
        pending.resolve(frame);
      }
      return;
    }
    case "spawn_host": {
      // Remote peer asked us to spawn a sibling `telepathy host` here.
      // Fire-and-forget — handler sends spawn_host_ack itself (success
      // or failure path). Don't await: we don't want this dispatcher
      // to block on a 30 s named-pipe wait.
      void handleSpawnHostRequest(peer, frame.id);
      return;
    }
    case "spawn_host_ack": {
      const pending = peer.pending.get(frame.id);
      if (pending) {
        peer.pending.delete(frame.id);
        clearTimeout(pending.timer);
        pending.resolve(frame);
      }
      return;
    }
    case "hello":
    case "hello_ack":
      // Already handled in adopt*; ignore late arrivals.
      return;
  }
}

// Public helpers for tools.ts to drive PTY ops on a peer.
export function subscribeRemotePty(peer: Peer, requestId: string): void {
  sendFrame(peer.socket, { type: "pty_subscribe", id: requestId });
}

export function unsubscribeRemotePty(peer: Peer): void {
  remotePtySubs.delete(peer.alias);
  sendFrame(peer.socket, { type: "pty_unsubscribe" });
}

export function sendRemoteInput(peer: Peer, dataBase64: string): void {
  sendFrame(peer.socket, { type: "pty_input", dataBase64 });
}

export function sendRemoteResize(peer: Peer, cols: number, rows: number): void {
  sendFrame(peer.socket, { type: "pty_input_resize", cols, rows });
}

function fireFirstPeerHooks(peer: Peer): void {
  if (onFirstPeerHooks.length === 0) {
    return;
  }
  const hooks = onFirstPeerHooks;
  onFirstPeerHooks = [];
  for (const h of hooks) {
    try {
      h(peer);
    } catch {
      // ignore
    }
  }
}

function servePtySubscribe(peer: Peer, requestId: string): void {
  if (!localPty) {
    sendFrame(peer.socket, {
      type: "pty_subscribe_ack",
      id: requestId,
      ok: false,
      error: "no local PTY on this host",
    });
    return;
  }
  // If they already had a sub, drop it first.
  localPtyServingSubs.get(peer.alias)?.();
  const onFrame = (f: { dataBase64: string }): void => {
    sendFrame(peer.socket, { type: "pty_frame", dataBase64: f.dataBase64 });
  };
  const onResize = (s: { cols: number; rows: number }): void => {
    sendFrame(peer.socket, { type: "pty_resize", cols: s.cols, rows: s.rows });
  };
  localPty.state.subscribers.add(onFrame);
  localPty.state.resizeSubscribers.add(onResize);
  localPtyServingSubs.set(peer.alias, () => {
    localPty?.state.subscribers.delete(onFrame);
    localPty?.state.resizeSubscribers.delete(onResize);
  });
  sendFrame(peer.socket, {
    type: "pty_subscribe_ack",
    id: requestId,
    ok: true,
    cols: localPty.state.cols,
    rows: localPty.state.rows,
    replayBase64: buildReplayWithModes(localPty.state.ringBuffer, localPty.state.enabledDecModes),
  });
}

// (handleSendRequest removed in standalone build — no agent layer)

// ---- Helpers ---------------------------------------------------------------

function makePeer(p: Omit<Peer, "status" | "connectedAt" | "pending">): Peer {
  return {
    ...p,
    status: "connected",
    connectedAt: Date.now(),
    pending: new Map(),
  };
}

// Re-implement frame reading here so we control routing per-socket. Mirrors
// transport.attachFrameReader but exposes both first-frame and subsequent
// frames to a single callback the orchestrator owns.
import { createInterface } from "node:readline";

function attachReader(socket: TLSSocket, onFrame: (frame: Frame) => void, onClose: () => void): void {
  // SAFETY: see transport.ts attachFrameReader — readline re-emits its
  // source-stream errors and Node crashes if nobody handles them. Swallow.
  const rl = createInterface({ input: socket, crlfDelay: Infinity });
  rl.on("error", () => undefined);
  socket.on("error", () => undefined);
  rl.on("line", (line) => {
    if (!line) {
      return;
    }
    let parsed: Frame;
    try {
      parsed = JSON.parse(line) as Frame;
    } catch {
      return;
    }
    onFrame(parsed);
  });
  rl.on("close", onClose);
}
