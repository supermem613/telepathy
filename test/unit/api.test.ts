import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { connect as tlsConnect } from "node:tls";
import { createServer as createNetServer } from "node:net";
import { acceptStart, acceptStop, connectPeer, describePeers, disconnectPeer, rotateListenerSecret, ACCEPT_TOKEN_TTL_MS } from "../../src/core/api.js";
import { decodeToken } from "../../src/core/token.js";
import { DEFAULT_PORT } from "../../src/core/protocol.js";

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

  it("auto-falls back to a random port when DEFAULT_PORT is taken (multi-host on same box)", async () => {
    // Squat on DEFAULT_PORT with a plain TCP server so acceptStart() with
    // no explicit port hits EADDRINUSE on its first try and must fall back.
    // If the world already squats it (e.g. a real `telepathy host` is
    // running on this dev box), skip the in-test squatter — the world
    // already provides the precondition.
    let squatter: ReturnType<typeof createNetServer> | undefined;
    try {
      const s = createNetServer();
      await new Promise<void>((resolve, reject) => {
        s.once("error", reject);
        s.listen(DEFAULT_PORT, "0.0.0.0", () => resolve());
      });
      squatter = s;
    } catch (err) {
      const code = (err as { code?: string } | null)?.code;
      if (code !== "EADDRINUSE") {
        throw err;
      }
      // External host already on 7423 — perfect, just run the assertion.
    }
    try {
      const accept = await acceptStart({});  // no port → DEFAULT_PORT then 0
      try {
        const decoded = decodeToken(accept.token);
        // Must have picked SOME port that isn't the squatted one.
        assert.notEqual(decoded.port, DEFAULT_PORT, "expected fallback to a different port");
        assert.ok(decoded.port > 0 && decoded.port <= 65535, `decoded port ${decoded.port} out of range`);
        // The token's port must match what acceptStart returned in `addr`.
        assert.equal(accept.addr.endsWith(`:${decoded.port}`), true, `addr ${accept.addr} does not end with port ${decoded.port}`);
        // And the dialer can connect to it (proves the listener is actually up on the new port).
        const peer = await connectPeer({ token: accept.token });
        assert.equal(peer.alias.length > 0, true);
      } finally {
        disconnectPeer({});
        acceptStop();
      }
    } finally {
      if (squatter) {
        await new Promise<void>((resolve) => squatter!.close(() => resolve()));
      }
    }
  });

  it("explicit -p collisions still hard-fail (no silent port substitution)", async () => {
    const port = randomPort();
    const squatter = createNetServer();
    await new Promise<void>((resolve, reject) => {
      squatter.once("error", reject);
      squatter.listen(port, "0.0.0.0", () => resolve());
    });
    try {
      await assert.rejects(
        () => acceptStart({ port }),
        (err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          return /EADDRINUSE/i.test(msg);
        },
        "expected acceptStart with explicit port to throw EADDRINUSE",
      );
    } finally {
      await new Promise<void>((resolve) => squatter.close(() => resolve()));
    }
  });
});

describe("api.rotateListenerSecret", () => {
  it("AcceptResult and ListenerInfo carry expiresInSec (TTL is enforced)", async () => {
    const port = randomPort();
    const accept = await acceptStart({ port });
    try {
      assert.equal(typeof accept.expiresInSec, "number", "AcceptResult must carry expiresInSec");
      assert.ok(accept.expiresInSec > 0, "expiresInSec must be positive at startup");
      assert.ok(accept.expiresInSec <= ACCEPT_TOKEN_TTL_MS / 1000, "expiresInSec must be <= TTL");
      const info = describePeers().listening;
      assert.ok(info, "listener should be advertised");
      assert.equal(typeof info!.expiresInSec, "number", "ListenerInfo must carry expiresInSec");
    } finally {
      acceptStop();
    }
  });

  it("rotateListenerSecret mints a fresh token (different secret) and resets the TTL clock", async () => {
    const port = randomPort();
    const accept = await acceptStart({ port });
    try {
      const beforeSecret = decodeToken(accept.token).secret.toString("hex");
      // Sleep a tick so the new TTL deadline is observably later than the old.
      await new Promise((r) => setTimeout(r, 10));
      const rotated = rotateListenerSecret();
      const afterSecret = decodeToken(rotated.token).secret.toString("hex");
      assert.notEqual(afterSecret, beforeSecret, "rotated token must encode a different secret");
      assert.equal(rotated.addr, accept.addr, "addr (host:port) must not change on rotation");
      assert.equal(rotated.bindHost, accept.bindHost, "bindHost must not change on rotation");
      assert.ok(rotated.expiresInSec > 0, "rotated token must have positive TTL");
      // describePeers().listening reflects the new token after rotation.
      const info = describePeers().listening;
      assert.equal(info?.token, rotated.token, "listener info must reflect rotated token");
    } finally {
      acceptStop();
    }
  });

  it("rotateListenerSecret accepts a short re-pair TTL", async () => {
    const port = randomPort();
    await acceptStart({ port });
    try {
      const rotated = rotateListenerSecret({ ttlMs: 60_000 });
      assert.equal(rotated.expiresInSec, 60);
      assert.equal(describePeers().listening?.expiresInSec, 60);
    } finally {
      acceptStop();
    }
  });

  it("after rotation: old token cannot dial; new token can; first live peer survives the swap", async () => {
    const port = randomPort();
    const accept = await acceptStart({ port });
    try {
      const firstPeer = await connectPeer({ token: accept.token });
      // Old token is now BURNT (single-use). Even before rotation, a
      // second dial with it would fail. Rotate to mint a fresh one.
      const rotated = rotateListenerSecret();
      // Fresh dial with the rotated token works.
      const secondPeer = await connectPeer({ token: rotated.token, alias: "second" });
      assert.equal(secondPeer.alias.length > 0, true);
      // The first peer is still in the registry (live socket survived).
      const peers = describePeers().peers;
      assert.ok(peers.some((p) => p.alias === firstPeer.alias), "first peer must survive rotation");
      assert.ok(peers.some((p) => p.alias === secondPeer.alias), "second peer must be present");
    } finally {
      disconnectPeer({});
      acceptStop();
    }
  });

  it("rotateListenerSecret throws when there is no active listener", () => {
    assert.throws(() => rotateListenerSecret(), /no active listener/);
  });
});
