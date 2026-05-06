import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { acceptStart, acceptStop, connectPeer, disconnectPeer, setLocalPty } from "../../src/core/api.js";
import { onFirstPeerConnect, type LocalPty } from "../../src/core/orchestrator.js";

function randomPort(): number {
  return 25000 + Math.floor(Math.random() * 2000);
}

// Build a fake LocalPty whose subscribers Set we can inspect.
function fakeLocalPty(): LocalPty & { _frames: Set<{ dataBase64: string }> } {
  const subscribers = new Set<(f: { dataBase64: string }) => void>();
  const resizeSubscribers = new Set<(s: { cols: number; rows: number }) => void>();
  const framesSeen = new Set<{ dataBase64: string }>();
  const localPty = {
    state: {
      cols: 80,
      rows: 24,
      ringBuffer: Buffer.from("hello world"),
      subscribers,
      resizeSubscribers,
    },
    injectInput: () => undefined,
    requestResize: () => undefined,
    close: () => undefined,
    _frames: framesSeen,
  };
  return localPty;
}

describe("orchestrator: deferred pty_subscribe", () => {
  it("queues subscribe when no localPty, drains on setLocalPty", async () => {
    const port = randomPort();
    const accept = await acceptStart({ port });
    setLocalPty(null); // explicit: no PTY yet
    try {
      const dialer = await connectPeer({ token: accept.token });
      assert.equal(dialer.alias.length > 0, true);
      // Dialer hasn't subscribed yet — orchestrator's pendingPtySubscribes
      // is per-process; subscribing now would land on the host side which
      // is the same process here. Use the orchestrator's subscribeRemotePty.
      const { subscribeRemotePty } = await import("../../src/core/orchestrator.js");
      const { listPeers } = await import("../../src/core/peers.js");
      const hostSidePeer = listPeers().find((p) => p.alias !== dialer.alias);
      assert.ok(hostSidePeer, "host-side peer should be in registry");
      // Dialer's-side subscribe (we send pty_subscribe over the link)
      const dialerPeer = listPeers().find((p) => p.alias === dialer.alias)!;
      subscribeRemotePty(dialerPeer, "test-sub-1");
      // Give the orchestrator a tick to receive on the host side.
      await new Promise((r) => setTimeout(r, 100));
      // Now drop a fake PTY in. The drain should fire and serve the queued sub.
      const pty = fakeLocalPty();
      setLocalPty(pty);
      // Wait a tick for servePtySubscribe to register the subscriber.
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(pty.state.subscribers.size, 1, "served subscribe should register a frame subscriber");
    } finally {
      setLocalPty(null);
      disconnectPeer({});
      acceptStop();
    }
  });
});

describe("orchestrator: onFirstPeerConnect hook", () => {
  it("fires once on the first peer to connect, not on subsequent peers", async () => {
    const port = randomPort();
    const accept = await acceptStart({ port });
    let fireCount = 0;
    onFirstPeerConnect(() => {
      fireCount++; 
    });
    try {
      await connectPeer({ token: accept.token });
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(fireCount, 1, "first connect should fire");
      // A second connect should not fire the hook again (it's one-shot).
      await connectPeer({ token: accept.token, alias: "second" });
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(fireCount, 1, "second connect should not fire (one-shot)");
    } finally {
      disconnectPeer({});
      acceptStop();
    }
  });
});
