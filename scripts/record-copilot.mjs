#!/usr/bin/env node
// Records a real Copilot CLI byte stream into test/fixtures/copilot-cli-trace.bin.
//
// Drives copilot through scripted phases via node-pty.write() and saves
// every byte chunk it emits with a timestamp + phase label so the test
// suite can reason about what happened when.
//
// Phases (each separated by a delay so the trace shows distinct
// bursts):
//   boot       — startup + welcome banner
//   type-text  — type "hello"
//   slash      — type "/" to trigger commands menu
//   esc        — Esc to cancel menu
//   arrow      — Up arrow (menu nav / history)
//   ctrl-c     — Ctrl-C
//   exit       — type "exit" + Enter (clean shutdown)
//
// The recorder dumps:
//   test/fixtures/copilot-cli-trace.bin   raw byte stream
//   test/fixtures/copilot-cli-trace.json  per-chunk metadata (phase, timestamp, byteLength)
//
// Usage: node scripts/record-copilot.mjs [--cols 132] [--rows 40]

import * as pty from "node-pty";
import { writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE_DIR = resolve(ROOT, "test/fixtures");
mkdirSync(FIXTURE_DIR, { recursive: true });
const BIN_PATH = resolve(FIXTURE_DIR, "copilot-cli-trace.bin");
const META_PATH = resolve(FIXTURE_DIR, "copilot-cli-trace.json");

const args = process.argv.slice(2);
function flag(name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}
const cols = Number(flag("--cols", "132"));
const rows = Number(flag("--rows", "40"));

const phases = [];
let currentPhase = "boot";
let totalBytes = 0;

writeFileSync(BIN_PATH, Buffer.alloc(0));

const start = Date.now();
function ts() { return Date.now() - start; }

function setPhase(name) {
  currentPhase = name;
  phases.push({ phase: name, atMs: ts(), totalBytesBefore: totalBytes });
  process.stderr.write(`[record] → phase=${name} t=${ts()}ms bytes=${totalBytes}\n`);
}

setPhase("boot");

const child = pty.spawn(process.env.COMSPEC ?? "cmd.exe", ["/c", "copilot"], {
  name: "xterm-256color",
  cols,
  rows,
  cwd: ROOT,
  env: { ...process.env, FORCE_COLOR: "1", TERM: "xterm-256color" },
});

child.onData((data) => {
  const buf = Buffer.from(data, "utf8");
  totalBytes += buf.length;
  appendFileSync(BIN_PATH, buf);
});

child.onExit(({ exitCode, signal }) => {
  process.stderr.write(`[record] copilot exited code=${exitCode} signal=${signal} totalBytes=${totalBytes}\n`);
  writeFileSync(META_PATH, JSON.stringify({
    cols, rows,
    durationMs: ts(),
    totalBytes,
    phases,
    exitCode,
  }, null, 2));
  process.stderr.write(`[record] wrote ${BIN_PATH} (${totalBytes}B) + ${META_PATH}\n`);
  process.exit(0);
});

// Polling-based scheduler — each phase waits for a brief idle window
// (~600ms with no new bytes) before triggering its input. Caps each
// phase at 8s so we don't hang if copilot misbehaves.
async function waitIdle(maxMs = 8000, idleMs = 600) {
  const startBytes = totalBytes;
  let lastSeen = totalBytes;
  let idleStart = Date.now();
  const giveUpAt = Date.now() + maxMs;
  while (Date.now() < giveUpAt) {
    await new Promise((r) => setTimeout(r, 100));
    if (totalBytes !== lastSeen) {
      lastSeen = totalBytes;
      idleStart = Date.now();
    } else if (Date.now() - idleStart >= idleMs) {
      return totalBytes - startBytes;
    }
  }
  return totalBytes - startBytes;
}

(async () => {
  // Boot — wait for copilot to settle.
  await waitIdle(15000, 800);

  setPhase("type-text");
  child.write("hello");
  await waitIdle();

  setPhase("slash");
  // Backspace out "hello" then type "/"
  child.write("\x7f\x7f\x7f\x7f\x7f/");
  await waitIdle();

  setPhase("arrow");
  child.write("\x1b[A");
  await waitIdle();

  setPhase("esc");
  child.write("\x1b");
  await waitIdle();

  setPhase("ctrl-c");
  child.write("\x03");
  await waitIdle();

  setPhase("exit");
  // Try sending "/exit\n" first — copilot CLI may have a /exit command.
  // Fall back to Ctrl-D and Ctrl-C if it doesn't quit.
  child.write("/exit\r");
  await waitIdle(5000, 400);
  child.write("\x04");          // Ctrl-D
  await waitIdle(2000, 300);
  child.write("\x03\x03");      // Double Ctrl-C
  await waitIdle(2000, 300);

  // Hard-kill if still alive.
  try { child.kill(); } catch { /* ignore */ }
})();
