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

  it("Enter (CR) starts the shell", () => {
    assert.equal(classifyHoldInput(Buffer.from([0x0d])), "key");
  });

  it("Enter (LF) starts the shell", () => {
    assert.equal(classifyHoldInput(Buffer.from([0x0a])), "key");
  });

  it("Space starts the shell", () => {
    assert.equal(classifyHoldInput(Buffer.from([0x20])), "key");
  });

  it("a regular letter is ignored (whitelist policy: only Enter/Space start)", () => {
    assert.equal(classifyHoldInput(Buffer.from("a")), "ignore");
  });

  it("focus-in escape sequence is ignored", () => {
    assert.equal(classifyHoldInput(Buffer.from([0x1b, 0x5b, 0x49])), "ignore");
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

  it("win32-input-mode noise that hung the host is ignored (regression)", () => {
    // The original 18-byte chunk on the user's terminal: ESC[44;55;...
    // Vk=44, Sc=55 — not Enter/Space/Ctrl-C, so ignored under whitelist.
    assert.equal(classifyHoldInput(Buffer.from("\x1b[44;55;0;1;0;1_")), "ignore");
  });

  it("win32-input-mode Enter keypress starts the shell", () => {
    // ESC[<Vk>;<Sc>;<Uc>;<Kd>;<Cs>;<Rc>_ where Uc=13 (Enter), Kd=1 (down).
    assert.equal(classifyHoldInput(Buffer.from("\x1b[13;28;13;1;0;1_")), "key");
  });

  it("win32-input-mode Space keypress starts the shell", () => {
    // Uc=32 (Space), Kd=1 (down).
    assert.equal(classifyHoldInput(Buffer.from("\x1b[32;57;32;1;0;1_")), "key");
  });

  it("win32-input-mode Enter key-UP event is ignored (only down counts)", () => {
    // Same key but Kd=0 (up). Treating both would double-fire on every press.
    assert.equal(classifyHoldInput(Buffer.from("\x1b[13;28;13;0;0;1_")), "ignore");
  });

  it("win32-input-mode Ctrl-C aborts (sequence contains 0x03)", () => {
    // Win32-input-mode encodes Ctrl-C with Uc=3 — the 0x03 byte appears
    // INSIDE the sequence. Our `chunk.includes(0x03)` covers this.
    assert.equal(classifyHoldInput(Buffer.from([0x1b, 0x5b, 0x33, 0x3b, 0x35, 0x3b, 0x03, 0x3b, 0x31, 0x3b, 0x38, 0x3b, 0x31, 0x5f])), "abort");
  });
});
