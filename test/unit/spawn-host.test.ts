// Unit tests for the spawn-host token-handoff primitive. We don't spawn
// a real `telepathy host` here (that's the integration smoke test) — we
// drive the named-pipe server directly and pretend a child wrote to it.
// Covers: happy path, malformed JSON, missing token field, child closes
// without writing, timeout.

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { connect as netConnect } from "node:net";
import { buildPipePath } from "../../src/core/ipc.js";
import { awaitTokenOnPipe } from "../../src/core/spawn-host.js";

function writeLine(pipePath: string, line: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = netConnect(pipePath);
    socket.once("error", reject);
    socket.once("connect", () => {
      socket.write(line, (err) => {
        if (err) {
          reject(err);
          return;
        }
        socket.end();
        resolve();
      });
    });
  });
}

describe("spawn-host: awaitTokenOnPipe", () => {
  it("returns the token when the child writes a valid JSON line", async () => {
    const pipe = buildPipePath();
    const { promise } = awaitTokenOnPipe(pipe, 5_000);
    // The pipe server is created synchronously inside awaitTokenOnPipe;
    // give the listener a tick to bind before we connect.
    await new Promise((r) => setTimeout(r, 20));
    await writeLine(pipe, '{"token":"TLP1ABCDEFG"}\n');
    const token = await promise;
    assert.equal(token, "TLP1ABCDEFG");
  });

  it("rejects with a malformed-JSON error when the child writes garbage", async () => {
    const pipe = buildPipePath();
    const { promise } = awaitTokenOnPipe(pipe, 5_000);
    await new Promise((r) => setTimeout(r, 20));
    await writeLine(pipe, "not json at all\n");
    await assert.rejects(promise, /malformed JSON/);
  });

  it("rejects when the child writes JSON without a token field", async () => {
    const pipe = buildPipePath();
    const { promise } = awaitTokenOnPipe(pipe, 5_000);
    await new Promise((r) => setTimeout(r, 20));
    await writeLine(pipe, '{"something":"else"}\n');
    await assert.rejects(promise, /missing 'token'/);
  });

  it("rejects when the child connects then closes without writing", async () => {
    const pipe = buildPipePath();
    const { promise } = awaitTokenOnPipe(pipe, 5_000);
    await new Promise((r) => setTimeout(r, 20));
    await new Promise<void>((resolve, reject) => {
      const socket = netConnect(pipe);
      socket.once("error", reject);
      socket.once("connect", () => {
        socket.end();
        resolve();
      });
    });
    await assert.rejects(promise, /closed handoff pipe without sending a token/);
  });

  it("rejects with a timeout error when no child ever connects", async () => {
    const pipe = buildPipePath();
    const { promise } = awaitTokenOnPipe(pipe, 100);
    await assert.rejects(promise, /timed out/);
  });

  it("close() tears down the server before resolution", async () => {
    const pipe = buildPipePath();
    const { promise, close } = awaitTokenOnPipe(pipe, 5_000);
    close();
    // After close, the promise should remain unresolved (we settled before
    // the timeout). Validate by racing against a short timer.
    const racer = new Promise<string>((r) => setTimeout(() => r("__timeout__"), 100));
    const winner = await Promise.race([promise.catch(() => "__rejected__"), racer]);
    assert.equal(winner, "__timeout__", "promise should not have settled after close()");
  });
});
