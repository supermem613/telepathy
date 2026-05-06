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
});
