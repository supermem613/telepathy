import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { connect as tlsConnect } from "node:tls";
import { acceptStart, acceptStop, connectPeer, describePeers, disconnectPeer } from "../../src/core/api.js";

// Pick a high random port per test so parallel runs don't collide.
function randomPort(): number {
  return 21000 + Math.floor(Math.random() * 2000);
}

describe("api.acceptStart / connectPeer round-trip", () => {
  it("loopback can dial the LAN-IP token (regression: ECONNREFUSED when bind was LAN-only)", async () => {
    const port = randomPort();
    const accept = await acceptStart({ port });
    try {
      // Same-box dialer: the host AND dialer adoptions both run in this
      // process, so we end up with 2 entries in the registry (one for each
      // side of the link). Just confirm the dial succeeded.
      const peer = await connectPeer({ token: accept.token });
      assert.equal(peer.alias.length > 0, true);
      const peers = describePeers();
      assert.ok(peers.peers.some((p) => p.alias === peer.alias), `expected dialer's alias "${peer.alias}" in peer list`);
    } finally {
      disconnectPeer({});
      acceptStop();
    }
  });

  it("abrupt TLS RST does not crash the host (regression: unhandled readline error)", async () => {
    const port = randomPort();
    await acceptStart({ port });
    try {
      // Open a raw TLS connection that abandons the handshake mid-flight.
      // The server-side socket will read ECONNRESET; the host must NOT crash.
      const sock = tlsConnect({
        host: "127.0.0.1",
        port,
        rejectUnauthorized: false,
        ALPNProtocols: ["telepathy-bogus"],   // no PSK, will fail
      });
      // Destroy after a tick so the server has registered the connection.
      await new Promise<void>((resolve) => {
        sock.on("error", () => resolve()); // expected
        sock.on("secureConnect", () => {
          sock.destroy();
          resolve();
        });
        setTimeout(() => {
          sock.destroy();
          resolve();
        }, 200);
      });
      // Give the server a tick to process the RST.
      await new Promise((r) => setTimeout(r, 100));
      // If the host crashed, we never reach here. The test runner will fail
      // with the process exiting non-zero. Otherwise, the listener is still up.
      assert.equal(describePeers().listening !== undefined, true);
    } finally {
      acceptStop();
    }
  });
});
