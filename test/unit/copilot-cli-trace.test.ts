// Real-world fixture: Copilot CLI byte trace captured via
// scripts/record-copilot.mjs. Verifies the dec-modes tracker against
// actual production output, not synthetic test cases.
//
// What Copilot CLI does (per recorded trace, verified by manual
// analysis):
//   ?1049 alt-screen      set ONCE, never reset
//   ?25   cursor visible  toggles (hide during render, show at prompt)
//   ?2026 synchronized    toggles per-frame (atomic redraws)
//   ?1002 mouse buttons   toggles (enabled in some modes)
//   ?1006 SGR mouse       paired with ?1002
//   ?1004 focus report    enabled then reset
//   ?2004 bracketed paste enabled then reset
//   ?9001 win32-input     enabled then reset

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { trackDecModes, buildReplayWithModes, type DecModeState } from "../../src/core/dec-modes.js";

const FIXTURE = resolve(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "copilot-cli-trace.bin");

function loadTrace(): Buffer {
  return readFileSync(FIXTURE);
}

describe("copilot-cli real trace fixture", () => {
  it("fixture exists and is non-trivial", () => {
    const trace = loadTrace();
    assert.ok(trace.length > 1000, `expected > 1000B, got ${trace.length}`);
  });

  it("captures alt-screen (?1049) — the canary mode for the late-joiner bug", () => {
    const modes: DecModeState = new Map();
    trackDecModes(loadTrace(), modes);
    assert.equal(modes.get("1049"), true,
      "Copilot CLI enters alt-screen on startup; tracker MUST see ?1049h");
  });

  it("captures the full set of modes Copilot CLI touches", () => {
    const modes: DecModeState = new Map();
    trackDecModes(loadTrace(), modes);
    // These are the modes Copilot CLI manipulates per the recorded trace.
    // If Copilot adds a new mode in the future, this test will start
    // missing it (still pass) — extend the assertions when that happens.
    const expected = ["1049", "25", "2026", "1002", "1006", "1004", "2004", "9001"];
    for (const code of expected) {
      assert.ok(modes.has(code), `expected to track mode ?${code}; got modes=${[...modes.keys()].sort().join(",")}`);
    }
  });

  it("preserves FINAL state for toggling modes (e.g. ?2026 toggles per-frame)", () => {
    const modes: DecModeState = new Map();
    trackDecModes(loadTrace(), modes);
    // ?2026 (synchronized output) toggles dozens of times. The tracker
    // must store the LAST state — the prelude is meaningless if it
    // emits an intermediate value.
    const sync2026 = modes.get("2026");
    assert.equal(typeof sync2026, "boolean");
    // Whatever the trace's final state is, the tracker MUST match it.
    // (Don't hard-code the value here — it depends on where copilot
    // stopped during recording. We check the value matches the last
    // ?2026 seen in the bytes directly.)
    const text = loadTrace().toString("latin1");
    const all2026 = [...text.matchAll(/\x1b\[\?2026([hl])/g)];
    if (all2026.length > 0) {
      const last = all2026[all2026.length - 1][1];
      assert.equal(sync2026, last === "h",
        `?2026 final state mismatch: tracker=${sync2026 ? "h" : "l"}, trace last=${last}`);
    }
  });

  it("buildReplayWithModes prepends prelude that round-trips through tracker", () => {
    // Take the real trace, build a replay (modes prelude + ring), then
    // re-track from the replay → resulting modes MUST match the original.
    const original: DecModeState = new Map();
    trackDecModes(loadTrace(), original);
    const replay = Buffer.from(buildReplayWithModes(loadTrace(), original), "base64");
    const roundTripped: DecModeState = new Map();
    trackDecModes(replay, roundTripped);
    assert.equal(roundTripped.size, original.size, "mode count after round-trip mismatch");
    for (const [code, set] of original) {
      assert.equal(roundTripped.get(code), set, `mode ?${code} mismatch after round-trip`);
    }
  });

  it("late-joiner scenario: ring evicts the prelude, replay restores it", () => {
    // Simulate the actual bug: the wall connects after the ring buffer
    // has rolled past Copilot CLI's startup mode-set sequences.
    const trace = loadTrace();
    const original: DecModeState = new Map();
    trackDecModes(trace, original);

    // Drop the first 4KB — that's where Copilot's startup ?1049h lives.
    const evictedRing = trace.subarray(4000);
    const evictedRingModes: DecModeState = new Map();
    trackDecModes(evictedRing, evictedRingModes);
    // Sanity: the evicted ring on its own MIGHT be missing some modes
    // (especially ?1049 which is set once at startup).
    // The test contract: even if evictedRingModes is missing ?1049,
    // a late joiner using buildReplayWithModes(evictedRing, original)
    // — i.e. the host's tracked modes from BEFORE eviction — recovers.

    const replay = Buffer.from(buildReplayWithModes(evictedRing, original), "base64");
    const recovered: DecModeState = new Map();
    trackDecModes(replay, recovered);
    assert.equal(recovered.get("1049"), true,
      "late joiner MUST end up with ?1049h after replay even when evicted from ring");
  });
});

describe("dec-modes hardening (synthetic edge cases)", () => {
  it("does not treat DECRQM mode-query as a set/reset", () => {
    // `\x1b[?1049$p` is a mode-query (DECRQM), terminator is `$p`.
    // Our regex is `?Nh`/`?Nl` only — `$p` shouldn't match. (Verifies
    // the regex is anchored to literal h/l and not loose suffix matching.)
    const modes: DecModeState = new Map();
    trackDecModes(Buffer.from("\x1b[?1049$p"), modes);
    assert.equal(modes.size, 0, "DECRQM should be ignored");
  });

  it("does not treat SGR mouse events as DEC mode sets", () => {
    // SGR mouse: `\x1b[<0;5;10M` — leading `<` distinguishes from `?`.
    const modes: DecModeState = new Map();
    trackDecModes(Buffer.from("\x1b[<0;5;10M\x1b[<0;5;10m"), modes);
    assert.equal(modes.size, 0, "SGR mouse events should be ignored");
  });

  it("does not match cursor-position reports", () => {
    // CPR reply: `\x1b[42;10R` — no `?` prefix.
    const modes: DecModeState = new Map();
    trackDecModes(Buffer.from("\x1b[42;10R"), modes);
    assert.equal(modes.size, 0);
  });

  it("ignores OSC sequences (window title, etc.)", () => {
    // Copilot CLI sets the window title via OSC 0: `\x1b]0;GitHub Copilot\x07`.
    // That's a different escape family — must not pollute mode state.
    const modes: DecModeState = new Map();
    trackDecModes(Buffer.from("\x1b]0;GitHub Copilot\x07"), modes);
    assert.equal(modes.size, 0);
  });

  it("ignores window-manipulation CSI (xterm 22;2t)", () => {
    // Copilot uses `\x1b[22;2t` (push window title to icon-title stack).
    // Numeric semicolon-separated CSI without `?` prefix and `t` suffix.
    const modes: DecModeState = new Map();
    trackDecModes(Buffer.from("\x1b[22;2t"), modes);
    assert.equal(modes.size, 0);
  });

  it("interleaves correctly with non-mode CSI noise", () => {
    // Real-world chunk: SGR + cursor moves + a mode set, all in one buffer.
    const modes: DecModeState = new Map();
    trackDecModes(Buffer.from(
      "\x1b[35m" +           // SGR magenta
      "\x1b[1;1H" +          // cursor home
      "\x1b[?1049h" +        // alt-screen set ← only this should track
      "\x1b[2K" +            // clear line
      "\x1b[?25l" +          // cursor hide ← and this
      "Hello",
    ), modes);
    assert.equal(modes.get("1049"), true);
    assert.equal(modes.get("25"), false);
    assert.equal(modes.size, 2);
  });
});
