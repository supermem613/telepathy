import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { trackDecModes, buildModePrelude, buildReplayWithModes } from "../../src/core/dec-modes.js";

describe("dec-modes tracker", () => {
  it("captures a single ?Nh enable", () => {
    const modes = new Map<string, boolean>();
    trackDecModes(Buffer.from("\x1b[?1049h"), modes);
    assert.deepEqual([...modes], [["1049", true]]);
  });

  it("removes a mode on ?Nl reset", () => {
    const modes = new Map<string, boolean>([["1049", true]]);
    trackDecModes(Buffer.from("\x1b[?1049l"), modes);
    assert.equal(modes.get("1049"), false);
  });

  it("handles `;`-separated multi-mode set", () => {
    const modes = new Map<string, boolean>();
    trackDecModes(Buffer.from("\x1b[?1049;25;1004h"), modes);
    assert.equal(modes.get("1049"), true);
    assert.equal(modes.get("25"), true);
    assert.equal(modes.get("1004"), true);
  });

  it("applies multiple sequences in one chunk", () => {
    const modes = new Map<string, boolean>();
    trackDecModes(Buffer.from("\x1b[?1049h\x1b[?25l\x1b[?2004h"), modes);
    assert.equal(modes.get("1049"), true);
    assert.equal(modes.get("25"), false);
    assert.equal(modes.get("2004"), true);
  });

  it("threads state across multiple chunks (the late-joiner case)", () => {
    const modes = new Map<string, boolean>();
    trackDecModes(Buffer.from("startup output\x1b[?1049h\x1b[?25lhello"), modes);
    trackDecModes(Buffer.from("more output\x1b[?2004h"), modes);
    assert.equal(modes.get("1049"), true);
    assert.equal(modes.get("25"), false);
    assert.equal(modes.get("2004"), true);
  });

  it("ignores SGR / cursor-position / other CSI sequences", () => {
    const modes = new Map<string, boolean>();
    trackDecModes(Buffer.from("\x1b[31m\x1b[1;1H\x1b[2K"), modes);
    assert.equal(modes.size, 0);
  });

  it("tolerates real Copilot-CLI-style mixed output", () => {
    const modes = new Map<string, boolean>();
    trackDecModes(Buffer.from(
      "\x1b[?1049h" +
      "\x1b[?25l" +
      "\x1b[?1004h" +
      "\x1b[2J\x1b[H" +
      "Welcome to Copilot CLI\r\n" +
      "\x1b[?2004h",
    ), modes);
    assert.equal(modes.get("1049"), true);
    assert.equal(modes.get("25"), false, "cursor explicitly hidden");
    assert.equal(modes.get("1004"), true);
    assert.equal(modes.get("2004"), true);
  });

  it("buildModePrelude emits ?Nh for set and ?Nl for reset", () => {
    const prelude = buildModePrelude(new Map([["1049", true], ["25", false], ["1004", true]]));
    const text = prelude.toString("latin1");
    assert.ok(text.includes("\x1b[?1049h"));
    assert.ok(text.includes("\x1b[?25l"));
    assert.ok(text.includes("\x1b[?1004h"));
  });

  it("buildModePrelude returns empty buffer when no modes seen", () => {
    const prelude = buildModePrelude(new Map());
    assert.equal(prelude.length, 0);
  });

  it("buildReplayWithModes prepends prelude before ring (regression: late-joiner alt-screen)", () => {
    const ring = Buffer.from("Investigating VERIFY_LOAD_SKILL_OOB_REGISTRY");
    const modes = new Map<string, boolean>([["1049", true], ["25", false]]);
    const replay = Buffer.from(buildReplayWithModes(ring, modes), "base64").toString("latin1");
    assert.ok(replay.startsWith("\x1b[?"), `expected ESC [ ? prefix, got ${JSON.stringify(replay.slice(0, 20))}`);
    assert.ok(replay.includes("\x1b[?1049h"), "expected ?1049h (alt-screen)");
    assert.ok(replay.includes("\x1b[?25l"), "expected ?25l (cursor hidden)");
    assert.ok(replay.endsWith("Investigating VERIFY_LOAD_SKILL_OOB_REGISTRY"), "ring content should follow prelude");
  });

  it("buildReplayWithModes returns just the ring when no modes seen", () => {
    const ring = Buffer.from("plain shell output");
    const replay = Buffer.from(buildReplayWithModes(ring, new Map()), "base64").toString("latin1");
    assert.equal(replay, "plain shell output");
  });
});
