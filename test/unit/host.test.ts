import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { classifyHoldInput } from "../../src/commands/host.js";

describe("classifyHoldInput — host hold-loop policy", () => {
  it("Ctrl-C aborts", () => {
    assert.equal(classifyHoldInput(Buffer.from([0x03])), "abort");
  });

  it("empty chunk is ignored", () => {
    assert.equal(classifyHoldInput(Buffer.from([])), "ignore");
  });

  it("focus-in escape sequence is ignored (regression: alt-tab spawned shell)", () => {
    assert.equal(classifyHoldInput(Buffer.from([0x1b, 0x5b, 0x49])), "ignore");
  });

  it("focus-out escape sequence is ignored", () => {
    assert.equal(classifyHoldInput(Buffer.from([0x1b, 0x5b, 0x4f])), "ignore");
  });

  it("arrow-up escape sequence is ignored", () => {
    assert.equal(classifyHoldInput(Buffer.from([0x1b, 0x5b, 0x41])), "ignore");
  });

  it("mouse event SGR sequence is ignored", () => {
    assert.equal(classifyHoldInput(Buffer.from("\x1b[<0;10;20M")), "ignore");
  });

  it("bracketed-paste start marker is ignored", () => {
    assert.equal(classifyHoldInput(Buffer.from("\x1b[200~")), "ignore");
  });

  it("cursor position report is ignored", () => {
    assert.equal(classifyHoldInput(Buffer.from("\x1b[42;10R")), "ignore");
  });

  it("bare ESC press counts as a key", () => {
    assert.equal(classifyHoldInput(Buffer.from([0x1b])), "key");
  });

  it("Enter (CR) counts as a key", () => {
    assert.equal(classifyHoldInput(Buffer.from([0x0d])), "key");
  });

  it("Space counts as a key", () => {
    assert.equal(classifyHoldInput(Buffer.from([0x20])), "key");
  });

  it("a regular letter counts as a key", () => {
    assert.equal(classifyHoldInput(Buffer.from("a")), "key");
  });

  it("a UTF-8 multi-byte letter counts as a key", () => {
    assert.equal(classifyHoldInput(Buffer.from("é")), "key");
  });
});
