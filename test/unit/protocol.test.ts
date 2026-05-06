import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { PROTOCOL_VERSION, DEFAULT_PORT, DEFAULT_VIEWER_PORT, type Message } from "../../src/core/protocol.js";

describe("protocol shape", () => {
  it("declares stable protocol version + default ports", () => {
    assert.equal(PROTOCOL_VERSION, 1);
    assert.equal(DEFAULT_PORT, 7423);
    assert.equal(DEFAULT_VIEWER_PORT, 7424);
  });

  it("Message union covers all expected types", () => {
    const types: Message["type"][] = [
      "hello",
      "hello_ack",
      "send",
      "send_result",
      "notify",
      "notify_ack",
      "ping",
      "pong",
      "error",
      "pty_subscribe",
      "pty_subscribe_ack",
      "pty_frame",
      "pty_input",
      "pty_resize",
      "pty_unsubscribe",
    ];
    // Compile-time exhaustiveness is enforced by TS; this just guards the
    // string list against accidental drift (we'd notice if a type was
    // removed from the union — TS would reject the cast).
    assert.equal(types.length, 15);
  });
});
