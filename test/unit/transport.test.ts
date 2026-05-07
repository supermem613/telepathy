import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { startListener, dial, send } from "../../src/core/transport.js";
import { generateSecret } from "../../src/core/token.js";
import type { Frame } from "../../src/core/transport.js";

describe("transport TLS-PSK round-trip", () => {
  it("listener and dialer with the same secret can exchange a frame", async () => {
    const secret = generateSecret();
    const port = 17000 + Math.floor(Math.random() * 1000);
    const received: Frame[] = [];
    const server = startListener({
      port,
      secret,
      onFrame: () => undefined,
      onConnect: (socket) => {
        socket.on("data", (chunk) => {
          const lines = chunk.toString("utf8").split("\n").filter(Boolean);
          for (const line of lines) {
            try {
              received.push(JSON.parse(line));
            } catch {
              // ignore partial frame edges
            }
          }
        });
      },
    });
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
    try {
      const socket = await dial({
        host: "127.0.0.1",
        port,
        secret,
        onFrame: () => undefined,
      });
      send(socket, { type: "ping", id: "abc" });
      await new Promise((r) => setTimeout(r, 50));
      socket.end();
      const found = received.find((f) => f.type === "ping" && (f as { id: string }).id === "abc");
      assert.ok(found, `expected ping frame, got ${JSON.stringify(received)}`);
    } finally {
      server.close();
    }
  });

  it("dialer with the wrong secret fails the handshake", async () => {
    const serverSecret = generateSecret();
    const dialerSecret = generateSecret();
    const port = 18000 + Math.floor(Math.random() * 1000);
    const server = startListener({
      port,
      secret: serverSecret,
      onFrame: () => undefined,
    });
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
    try {
      await assert.rejects(
        dial({
          host: "127.0.0.1",
          port,
          secret: dialerSecret,
          onFrame: () => undefined,
        }),
      );
    } finally {
      server.close();
    }
  });

  it("hard TTL: dial post-expiry fails (pskCallback returns null past getExpiresAt())", async () => {
    const secret = generateSecret();
    const port = 19000 + Math.floor(Math.random() * 1000);
    const expiresAt = Date.now() - 1; // already expired
    const server = startListener({
      port,
      secret,
      onFrame: () => undefined,
      getExpiresAt: () => expiresAt,
    });
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
    try {
      await assert.rejects(
        dial({ host: "127.0.0.1", port, secret, onFrame: () => undefined }),
        "dial after expiry must reject — TTL gate is the whole point",
      );
    } finally {
      server.close();
    }
  });

  it("single-use: a second dial with the same secret fails after the first consumed it", async () => {
    const secret = generateSecret();
    const port = 19500 + Math.floor(Math.random() * 500);
    let expiresAt = Date.now() + 60_000; // plenty of TTL headroom
    const server = startListener({
      port,
      secret,
      onFrame: () => undefined,
      getExpiresAt: () => expiresAt,
      // Burn the token immediately on PSK handout — this is exactly what
      // api.ts wires for single-use. Simulating it directly here keeps
      // the transport-level test self-contained.
      onConsume: () => {
        expiresAt = 0;
      },
    });
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
    try {
      const first = await dial({ host: "127.0.0.1", port, secret, onFrame: () => undefined });
      // First dial succeeded — token is now burnt. Second dial must fail.
      await assert.rejects(
        dial({ host: "127.0.0.1", port, secret, onFrame: () => undefined }),
        "second dial with the same single-use token must fail",
      );
      // The first connection must STILL be alive — TLS-PSK does not
      // rekey live sockets on PSK swap or expiry.
      assert.equal(first.destroyed, false, "first (live) socket must survive token consumption");
      first.end();
    } finally {
      server.close();
    }
  });

  it("setSecret swaps the PSK in place: old secret stops authenticating new dials, new secret works", async () => {
    const oldSecret = generateSecret();
    const newSecret = generateSecret();
    const port = 20000 + Math.floor(Math.random() * 500);
    const server = startListener({
      port,
      secret: oldSecret,
      onFrame: () => undefined,
    });
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
    try {
      // First dial with old secret works.
      const first = await dial({ host: "127.0.0.1", port, secret: oldSecret, onFrame: () => undefined });
      // Rotate the listener's PSK in place.
      server.setSecret(newSecret);
      // Old secret no longer authenticates new dials.
      await assert.rejects(
        dial({ host: "127.0.0.1", port, secret: oldSecret, onFrame: () => undefined }),
        "old secret must fail after setSecret",
      );
      // New secret authenticates new dials.
      const second = await dial({ host: "127.0.0.1", port, secret: newSecret, onFrame: () => undefined });
      // The original live socket survives the swap.
      assert.equal(first.destroyed, false, "live socket must survive PSK swap");
      first.end();
      second.end();
    } finally {
      server.close();
    }
  });
});
