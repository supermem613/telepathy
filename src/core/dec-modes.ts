// Tracks DEC private mode state from a stream of PTY bytes so we can
// rebuild a sane terminal state for late-joining replay subscribers.
//
// Why: TUIs (Copilot CLI, vim, htop, etc.) commonly enter alt-screen
// (`\x1b[?1049h`), enable focus reporting / bracketed paste / mouse
// tracking, hide the cursor (`\x1b[?25l`), etc. on startup. Those
// mode-set sequences scroll out of any bounded ring buffer over time.
// A new subscriber gets the tail of the byte stream and ends up with
// the wrong terminal state — most painfully, in main-buffer mode where
// every TUI redraw scrolls instead of overwriting (Copilot's spinner
// stacks vertically, vim/htop content scrolls past).
//
// Solution: parse `\x1b[?Nh` and `\x1b[?Nl` sequences out of every
// frame, maintain the explicit state of every mode we've seen, and
// prepend matching `?Nh` / `?Nl` sequences to the next replay so xterm
// matches the host's mode state BEFORE the ring playback.
//
// We track BOTH directions because some modes default to set
// (?25 cursor visible, ?7 autowrap) and an explicit `?Nl` matters
// after eviction. Modes we've never seen stay at xterm's default —
// correct because the host never touched them either.
//
// Limitation: we don't carry partial sequences across chunk boundaries.
// A `?1049h` split across two frames would be missed — in practice
// node-pty emits whole sequences per chunk because TUIs flush on
// boundaries, and even if we miss one, the live frame replay in normal
// operation re-establishes state.

// CSI ?N(;N)*[hl] — single mode or `;`-separated. h=set, l=reset.
// ESC (0x1b) expressed via String.fromCharCode + RegExp constructor to
// avoid a literal control char in a regex literal (no-control-regex).
const DEC_MODE_RE = new RegExp(`${String.fromCharCode(0x1b)}\\[\\?([\\d;]+)([hl])`, "g");

export type DecModeState = Map<string, boolean>;

export function trackDecModes(chunk: Buffer, modes: DecModeState): void {
  // Latin-1 round-trips bytes 1:1; mode codes are pure ASCII so this is
  // safe and avoids paying for UTF-8 decoding on every frame.
  const text = chunk.toString("latin1");
  DEC_MODE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = DEC_MODE_RE.exec(text)) !== null) {
    const set = m[2] === "h";
    for (const code of m[1].split(";")) {
      modes.set(code, set);
    }
  }
}

export function buildModePrelude(modes: DecModeState): Buffer {
  if (modes.size === 0) {
    return Buffer.alloc(0);
  }
  let text = "";
  for (const [code, set] of modes) {
    text += `\x1b[?${code}${set ? "h" : "l"}`;
  }
  return Buffer.from(text, "latin1");
}

export function buildReplayWithModes(ringBuffer: Buffer, modes: DecModeState): string {
  const prelude = buildModePrelude(modes);
  if (prelude.length === 0) {
    return ringBuffer.toString("base64");
  }
  return Buffer.concat([prelude, ringBuffer]).toString("base64");
}
