import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import {
  buildPipePath,
  startIpcServer,
  connectIpcClient,
  sendIpc,
  readIpc,
  type WrapperToExtension,
  type ExtensionToWrapper,
} from "../../src/core/ipc.js";

describe("ipc round-trip", () => {
  it("wrapper-side sends frame; extension-side reads it", async () => {
    const pipe = buildPipePath();
    const messages: WrapperToExtension[] = [];
    const inputs: ExtensionToWrapper[] = [];
    const server = startIpcServer({
      pipePath: pipe,
      onClient: (sock) => {
        sendIpc(sock, { type: "hello", cols: 80, rows: 24, replayBase64: "" });
        sendIpc(sock, { type: "frame", dataBase64: Buffer.from("hello", "utf8").toString("base64") });
        readIpc<ExtensionToWrapper>(sock, (msg) => inputs.push(msg));
      },
    });
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
    try {
      const client = await connectIpcClient(pipe);
      readIpc<WrapperToExtension>(client, (msg) => messages.push(msg));
      sendIpc(client, { type: "input", dataBase64: Buffer.from("ping", "utf8").toString("base64") });
      // Allow the server to read.
      await new Promise((r) => setTimeout(r, 100));
      assert.equal(messages.length >= 2, true, "client should have received hello + frame");
      assert.equal(messages[0]!.type, "hello");
      assert.equal(messages[1]!.type, "frame");
      assert.equal(inputs.length, 1);
      assert.equal(inputs[0]!.type, "input");
      client.end();
    } finally {
      server.close();
    }
  });

  it("buildPipePath returns a unique path each call", () => {
    const a = buildPipePath();
    const b = buildPipePath();
    assert.notEqual(a, b);
    if (process.platform === "win32") {
      assert.match(a, /^\\\\\.\\pipe\\telepathy-/);
    } else {
      assert.match(a, /telepathy-.*\.sock$/);
    }
  });
});
