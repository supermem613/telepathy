// End-to-end Electron + wall-viewer test: drives the real BrowserWindow
// via Playwright, asserts that user keystrokes round-trip from xterm to
// the wrapped subprocess and back as PTY frames.
//
// This is the regression for the 'can't type into the wall' bug —
// wall.html had `if (peer.hasPty)` gating term.onData, but a peer that
// connected DURING the host's hold-for-keypress phase saw hasPty=false
// (because setLocalPty hadn't fired yet), so input wiring was never set
// up. The fix: always wire input; let the server-side gate.
//
// What this test exercises:
//   1. Spawn `telepathy host -- node echo-bot.cjs` (real CLI subprocess
//      with the ConPTY wrapper).
//   2. Capture the join token from its stderr.
//   3. Launch Electron via Playwright pointing at telepathy's wall URL
//      passing the token via the same --token=… arg the CLI uses.
//   4. Wait for the wall to load and for the auto-linked peer's tab.
//   5. Type "ping<Enter>" into the focused terminal.
//   6. Assert "echo:ping" appears in the page's xterm content.

import { describe, it, before, after } from "node:test";
import { strict as assert } from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ECHO_BOT = resolve(dirname(fileURLToPath(import.meta.url)), "echo-bot.cjs");

let ptyAvailable = true;
try {
  await import("node-pty");
} catch {
  ptyAvailable = false;
}

async function waitForAsync(predicate: () => Promise<boolean>, opts: { timeout?: number; interval?: number; what?: string } = {}): Promise<void> {
  const timeout = opts.timeout ?? 30_000;
  const interval = opts.interval ?? 100;
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await predicate()) {
      return;
    }
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(`waitForAsync timed out after ${timeout}ms${opts.what ? `: ${opts.what}` : ""}`);
}

async function waitFor(predicate: () => boolean, opts: { timeout?: number; interval?: number; what?: string } = {}): Promise<void> {
  const timeout = opts.timeout ?? 30_000;
  const interval = opts.interval ?? 100;
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (predicate()) {
      return;
    }
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(`waitFor timed out after ${timeout}ms${opts.what ? `: ${opts.what}` : ""}`);
}

let host: ChildProcess | undefined;
let app: ElectronApplication | undefined;
let page: Page | undefined;
let hostStderr = "";

before(async () => {
  if (!ptyAvailable) {
    return;
  }
  // Random high port to avoid collisions with the user's running telepathy.
  const port = 18000 + Math.floor(Math.random() * 2000);

  // 1. Start `telepathy host -p <port> -- node echo-bot.cjs`.
  host = spawn(process.execPath, [
    resolve(ROOT, "dist/cli.js"),
    "host",
    "-p", String(port),
    "--",
    process.execPath,
    ECHO_BOT,
  ], {
    cwd: ROOT,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, FORCE_COLOR: "0" },
  });
  host.stderr!.on("data", (chunk: Buffer) => {
    hostStderr += chunk.toString("utf8");
  });
  host.stdout!.on("data", () => undefined);

  // 2. Capture the token.
  await waitFor(() => /token: (TLP1[A-Z2-7]+)/.test(hostStderr), { timeout: 10_000, what: "host token banner" });
  const m = /token: (TLP1[A-Z2-7]+)/.exec(hostStderr)!;
  const token = m[1]!;

  // Trigger keypress to release the hold and spawn echo-bot. (We send
  // 'a\n' which the hold treats as a key and ignores the body.)
  host.stdin!.write("a\n");
  // Give the wrapper a moment to start the child.
  await new Promise((r) => setTimeout(r, 500));

  // 3. Launch Electron with the token.
  app = await electron.launch({
    args: [resolve(ROOT, "electron/main.cjs"), `--token=${token}`],
    cwd: ROOT,
    env: { ...process.env, ELECTRON_DISABLE_SANDBOX: "1" },
  });
  page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
});

after(async () => {
  if (app) {
    await app.close().catch(() => undefined);
  }
  if (host && !host.killed) {
    host.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 200));
    if (!host.killed) {
      host.kill("SIGKILL");
    }
  }
  // node-pty + Electron native handles can keep the event loop alive
  // even after both child trees are killed. Schedule a forced exit
  // shortly after the after-hook returns; node:test will have flushed
  // its TAP report by then.
  setTimeout(() => process.exit(0), 500).unref();
});

describe("electron e2e: type into wall terminal, see echo back", () => {
  it("xterm.onData → ws → host PTY → echo → frame → xterm.write", async (t) => {
    if (!ptyAvailable) {
      t.skip("node-pty not available");
      return;
    }
    assert.ok(page, "Electron page should have loaded");

    // 4. Wait for the auto-linked peer's tab to appear in the tab strip.
    await page.waitForSelector(".tab", { timeout: 10_000 });
    const tabAliases = await page.$$eval(".tab .label", (els) => els.map((e) => (e.textContent || "").trim()));
    assert.ok(tabAliases.length > 0, `expected at least one tab, got ${JSON.stringify(tabAliases)}`);
    const alias = tabAliases[0]!.split(" ")[0]!;

    // Wait for the echo bot's READY banner to be in the screen buffer
    // — proves the PTY is live and frames are flowing.
    await waitForAsync(async () => {
      const text = await page!.evaluate(() => document.body.innerText);
      return text.includes("ECHO_BOT_READY");
    }, { timeout: 10_000, what: "ECHO_BOT_READY banner in xterm" });

    // 5. Click into the term host to ensure focus, then type.
    await page.click(".term-host.active");
    await page.keyboard.type("ping");
    await page.keyboard.press("Enter");

    // 6. Assert the echo round-tripped.
    await waitForAsync(async () => {
      const text = await page!.evaluate(() => document.body.innerText);
      return text.includes("echo:ping");
    }, { timeout: 10_000, what: `'echo:ping' in xterm output for tab ${alias}` });
  });
});

// node-pty / electron native handles can keep the loop alive after
// node:test finishes. The `after` hook installs a forced exit after
// TAP has flushed.
