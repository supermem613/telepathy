// Wall-input round-trip tests: every byte sequence the wall might send
// (keystrokes, Ctrl-keys, paste, function keys, etc.) must reach the
// wrapped child PTY UNMOLESTED. This is the regression suite for any
// future "byte X got eaten somewhere in the wire path" bug.
//
// Path tested:
//   pty_input IPC frame → wrapper.write → ConPTY → child stdin
//
// We use the shared echo-bot fixture from test/integration/echo-bot.cjs
// — it echoes each line back as `echo:<line>`. We send specific bytes,
// then check the output stream (via wrapper IPC frames) for the echo.
//
// This intentionally lives in test/unit/ (not integration/) because it
// only exercises wrapper IPC + node-pty — no Electron, no Playwright,
// no browser. It runs in a few seconds.

import { describe, it, after } from "node:test";
import { startWrapper } from "../../src/core/pty-wrapper.js";
import { connectIpcClient, sendIpc, readIpc, buildPipePath, type WrapperToExtension, type ExtensionToWrapper } from "../../src/core/ipc.js";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Socket } from "node:net";

const RAW_BOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "integration", "raw-echo.cjs");

let ptyAvailable = true;
try {
  await import("node-pty");
} catch {
  ptyAvailable = false;
}

// Shared wrapper across the suite — spinning one up per test would
// triple the runtime. echo-bot accumulates; tests are independent
// because we look for unique echo sentinels.
let socket: Socket | undefined;
let stop: (() => void) | undefined;
let collected = "";
const subs: Array<(text: string) => void> = [];

after(() => {
  try {
    stop?.();
  } catch { /* ignore */ }
  try {
    socket?.destroy();
  } catch { /* ignore */ }
  setTimeout(() => process.exit(0), 300).unref();
});

async function ensureWrapper(): Promise<void> {
  if (socket) {
    return;
  }
  const pipePath = buildPipePath();
  const wrapper = await startWrapper({
    pipePath,
    command: process.execPath,
    args: [RAW_BOT],
    cwd: process.cwd(),
    env: process.env as Record<string, string | undefined>,
    attachStdio: false,
    onChildExit: () => undefined,
  });
  if (!wrapper) {
    throw new Error("startWrapper returned null (node-pty unavailable)");
  }
  stop = () => wrapper.server.close();
  await new Promise((r) => setTimeout(r, 100));
  socket = await connectIpcClient(pipePath);
  readIpc<WrapperToExtension>(socket, (msg) => {
    if (msg.type === "frame") {
      collected += Buffer.from(msg.dataBase64, "base64").toString("utf8");
      for (const fn of subs) {
        fn(collected);
      }
    } else if (msg.type === "hello") {
      // The hello carries the replay buffer (with mode prelude). Apply
      // it the same way a real subscriber would so the bot's READY
      // banner is in `collected` from the start.
      collected += Buffer.from(msg.replayBase64, "base64").toString("utf8");
      for (const fn of subs) {
        fn(collected);
      }
    }
  });
  await waitFor(() => collected.includes("RAW_ECHO_READY"), 5000, "RAW_ECHO_READY");
}

function send(bytes: Buffer | string): void {
  const buf = typeof bytes === "string" ? Buffer.from(bytes, "utf8") : bytes;
  const msg: ExtensionToWrapper = { type: "input", dataBase64: buf.toString("base64") };
  sendIpc(socket!, msg);
}

async function waitFor(predicate: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const giveUp = Date.now() + timeoutMs;
  let resolveFn!: () => void;
  const done = new Promise<void>((r) => {
    resolveFn = r;
  });
  const checker = () => {
    if (predicate()) {
      resolveFn();
    }
  };
  subs.push(checker);
  checker();
  // Also poll, in case no frames arrive but stale state already matches.
  const pollTimer = setInterval(checker, 50);
  try {
    await Promise.race([
      done,
      new Promise<void>((_, reject) =>
        setTimeout(() => reject(new Error(`waitFor timed out: ${what}`)), Math.max(0, giveUp - Date.now()))),
    ]);
  } finally {
    clearInterval(pollTimer);
    const i = subs.indexOf(checker);
    if (i >= 0) {
      subs.splice(i, 1);
    }
  }
}

// Helper: assert a specific byte sequence appears in `collected` as
// an `RX:<hex>` line emitted by raw-echo.cjs. Polls for up to 4s.
async function assertReceived(bytes: Buffer | string, what: string): Promise<void> {
  const buf = typeof bytes === "string" ? Buffer.from(bytes, "utf8") : bytes;
  const hex = buf.toString("hex");
  // raw-echo emits one RX line per chunk; bytes may be split across
  // multiple chunks, so accept the hex appearing as a substring across
  // concatenated RX bodies.
  await waitFor(
    () => stripRxLines(collected).includes(hex),
    4000,
    `${what} (expected hex ${hex})`,
  );
}

function stripRxLines(text: string): string {
  // Concatenate every `RX:<hex>\n` body so multi-chunk receives match
  // against a single contiguous hex string.
  return [...text.matchAll(/RX:([0-9a-f]*)/g)].map((m) => m[1]).join("");
}

function skipIfNoPty(t: { skip: (reason?: string) => void }): boolean {
  if (ptyAvailable) {
    return false;
  }
  t.skip("node-pty not available");
  return true;
}

describe("wall input → PTY child round-trip (wrapper IPC)", () => {
  it("plain ASCII text reaches the child as raw bytes", async (t) => {
    if (skipIfNoPty(t)) {
      return;
    }
    await ensureWrapper();
    send("hello");
    await assertReceived("hello", "ASCII");
  });

  it("Ctrl-C (0x03) reaches the child as raw byte (NOT a host signal)", async (t) => {
    if (skipIfNoPty(t)) {
      return;
    }
    await ensureWrapper();
    // Bot is in raw mode — line discipline OFF, so 0x03 doesn't
    // generate SIGINT. The byte arrives intact, proving the wire path
    // never intercepts it. (Custom rules require this so TUIs like
    // Copilot CLI can use Ctrl-C to cancel an in-progress agent action
    // without killing the wrapped shell.)
    send(Buffer.from([0x03]));
    await assertReceived(Buffer.from([0x03]), "Ctrl-C byte");
  });

  it("UTF-8 multi-byte characters survive the wire (powerline glyphs, emoji)", async (t) => {
    if (skipIfNoPty(t)) {
      return;
    }
    await ensureWrapper();
    send("café-🚀");
    await assertReceived("café-🚀", "UTF-8");
  });

  it("bracketed-paste sequence is forwarded byte-for-byte", async (t) => {
    if (skipIfNoPty(t)) {
      return;
    }
    await ensureWrapper();
    // Real xterm bracketed-paste: \x1b[200~ + content + \x1b[201~
    const paste = "\x1b[200~TLP1ABC123\x1b[201~";
    send(paste);
    await assertReceived(paste, "bracketed paste with start/end markers");
  });

  it("arrow keys forward as CSI sequences (xterm idiom)", async (t) => {
    if (skipIfNoPty(t)) {
      return;
    }
    await ensureWrapper();
    send("\x1b[A"); // Up arrow
    await assertReceived("\x1b[A", "Up arrow ESC[A");
    send("\x1b[B"); // Down arrow
    await assertReceived("\x1b[B", "Down arrow ESC[B");
  });

  it("function keys forward as their CSI/SS3 sequences", async (t) => {
    if (skipIfNoPty(t)) {
      return;
    }
    await ensureWrapper();
    send("\x1bOP");   // F1 (SS3)
    await assertReceived("\x1bOP", "F1 SS3");
    send("\x1b[15~"); // F5 (CSI)
    await assertReceived("\x1b[15~", "F5 CSI");
  });

  it("Ctrl-V byte (0x16) is delivered as raw input (xterm-side paste handling is upstream)", async (t) => {
    if (skipIfNoPty(t)) {
      return;
    }
    await ensureWrapper();
    // Browsers handle Ctrl-V at the xterm layer — xterm fires its
    // own `paste` event and writes clipboard contents as bracketed
    // paste. At the IPC layer below, bare 0x16 is just a byte.
    send(Buffer.from([0x16]));
    await assertReceived(Buffer.from([0x16]), "Ctrl-V byte");
  });

  it("Ctrl-D (0x04) passes through (TUIs may bind it; raw-echo only exits on 0x05)", async (t) => {
    if (skipIfNoPty(t)) {
      return;
    }
    await ensureWrapper();
    send(Buffer.from([0x04]));
    await assertReceived(Buffer.from([0x04]), "Ctrl-D byte");
  });

  it("rapid-fire 1-byte writes all arrive (no input dropped under burst)", async (t) => {
    if (skipIfNoPty(t)) {
      return;
    }
    await ensureWrapper();
    const chars = "rapidfire-X1234567890";
    for (const ch of chars) {
      send(ch);
    }
    await assertReceived(chars, "20-char rapid burst");
  });

  it("a paste-sized chunk (1KB) is delivered intact", async (t) => {
    if (skipIfNoPty(t)) {
      return;
    }
    await ensureWrapper();
    // 1KB is a realistic single-paste size (long token, code snippet,
    // a wall-of-text URL). Larger pastes (>4KB) get chunked by xterm
    // when bracketed-paste is enabled, so testing 1KB covers the
    // single-frame path that matters most.
    const sentinel = "BIG-PASTE-SENTINEL-9f3a2b";
    const filler = "X".repeat(1000);
    send(filler + sentinel);
    await assertReceived(filler + sentinel, "1KB paste");
  });

  it("Enter (CR) and LF both pass through as raw bytes", async (t) => {
    if (skipIfNoPty(t)) {
      return;
    }
    await ensureWrapper();
    send(Buffer.from([0x0d, 0x0a]));
    await assertReceived(Buffer.from([0x0d, 0x0a]), "CR + LF");
  });

  it("ESC by itself (used by Vim, menu cancel, etc.) passes through", async (t) => {
    if (skipIfNoPty(t)) {
      return;
    }
    await ensureWrapper();
    send(Buffer.from([0x1b]));
    await assertReceived(Buffer.from([0x1b]), "bare ESC");
  });
});
