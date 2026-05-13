// End-to-end Electron test: pressing Escape in the wall terminal must
// deliver the ESC byte (0x1b) to the wrapped child's stdin. This is the
// regression test for the "Escape does nothing in the app" bug — vim
// mode-switch, TUI menu cancel, etc. all depend on ESC arriving.
//
// Uses raw-echo.cjs (raw-mode bot that emits `RX:<hex>` for every stdin
// chunk) so we can assert the exact byte that reached the child.

import { describe, it, before, after } from "node:test";
import { strict as assert } from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const RAW_BOT = resolve(dirname(fileURLToPath(import.meta.url)), "raw-echo.cjs");

let ptyAvailable = true;
try {
  await import("node-pty");
} catch {
  ptyAvailable = false;
}

async function waitForAsync(
  predicate: () => Promise<boolean>,
  opts: { timeout?: number; interval?: number; what?: string } = {},
): Promise<void> {
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

async function waitFor(
  predicate: () => boolean,
  opts: { timeout?: number; interval?: number; what?: string } = {},
): Promise<void> {
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

function countEscBytes(text: string): number {
  return [...text.matchAll(/RX:([0-9a-f]*)/g)]
    .reduce((count, match) => count + ((match[1]?.match(/1b/g) || []).length), 0);
}

before(async () => {
  if (!ptyAvailable) {
    return;
  }
  const port = 18000 + Math.floor(Math.random() * 2000);

  host = spawn(process.execPath, [
    resolve(ROOT, "dist/cli.js"),
    "host",
    "-p", String(port),
    "--",
    process.execPath,
    RAW_BOT,
  ], {
    cwd: ROOT,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, FORCE_COLOR: "0" },
  });
  host.stderr!.on("data", (chunk: Buffer) => {
    hostStderr += chunk.toString("utf8");
  });
  host.stdout!.on("data", () => undefined);

  await waitFor(() => /token: (TLP1[A-Z2-7]+)/.test(hostStderr), { timeout: 10_000, what: "host token banner" });
  const m = /token: (TLP1[A-Z2-7]+)/.exec(hostStderr)!;
  const token = m[1]!;

  // Release the hold-for-keypress phase.
  host.stdin!.write("a\n");
  await new Promise((r) => setTimeout(r, 500));

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
  setTimeout(() => process.exit(0), 500).unref();
});

describe("electron e2e: Escape key reaches wrapped child as ESC byte", () => {
  it("pressing Escape in the wall sends 0x1b to the PTY child", async (t) => {
    if (!ptyAvailable) {
      t.skip("node-pty not available");
      return;
    }
    assert.ok(page, "Electron page should have loaded");

    // Wait for the auto-linked peer's tab.
    await page.waitForSelector(".tab", { timeout: 10_000 });

    // Wait for the raw-echo bot's READY banner.
    await waitForAsync(async () => {
      const text = await page!.evaluate(() => document.body.innerText);
      return text.includes("RAW_ECHO_READY");
    }, { timeout: 10_000, what: "RAW_ECHO_READY banner in xterm" });

    // Focus the terminal.
    await page.click(".term-host.active");
    // Small settle time for xterm focus.
    await new Promise((r) => setTimeout(r, 200));

    // Press Escape.
    await page.keyboard.press("Escape");

    // Assert the ESC byte (0x1b = hex "1b") arrived at the child.
    await waitForAsync(async () => {
      const text = await page!.evaluate(() => document.body.innerText);
      return text.includes("RX:1b");
    }, { timeout: 5_000, what: "RX:1b in xterm output (ESC byte reached child)" });
  });

  it("Escape after clicking the tab bar still reaches the PTY child", async (t) => {
    if (!ptyAvailable) {
      t.skip("node-pty not available");
      return;
    }
    assert.ok(page, "Electron page should have loaded");

    // Baseline: terminal is already connected from previous test.
    // Click the TAB BAR (not the terminal) to defocus xterm's textarea.
    // This simulates the real user scenario: click a tab, then press
    // Escape — the capture-phase focus-restoration handler fires but
    // must also forward the Escape keystroke into xterm.
    await page.click("#tabbar");
    await new Promise((r) => setTimeout(r, 200));

    // Verify xterm lost focus — activeElement should NOT be the textarea.
    const focusedBefore = await page.evaluate(() => document.activeElement?.tagName);
    assert.notEqual(focusedBefore, "TEXTAREA", "xterm should have lost focus after clicking tabbar");

    // Snapshot current output so we can detect NEW RX:1b lines.
    const beforeText = await page.evaluate(() => document.body.innerText);
    const beforeCount = countEscBytes(beforeText);

    // Press Escape — this is the key that was getting lost.
    await page.keyboard.press("Escape");

    // Assert a NEW RX:1b appeared (not just the one from the previous test).
    await waitForAsync(async () => {
      const text = await page!.evaluate(() => document.body.innerText);
      const afterCount = countEscBytes(text);
      return afterCount > beforeCount;
    }, { timeout: 5_000, what: "new RX:1b after Escape-from-tabbar (ESC byte forwarded after focus restoration)" });
  });

  it("repeated Escape presses each send a new ESC byte", async (t) => {
    if (!ptyAvailable) {
      t.skip("node-pty not available");
      return;
    }
    assert.ok(page, "Electron page should have loaded");

    await page.waitForSelector(".tab", { timeout: 10_000 });
    await waitForAsync(async () => {
      const text = await page!.evaluate(() => document.body.innerText);
      return text.includes("RAW_ECHO_READY");
    }, { timeout: 10_000, what: "RAW_ECHO_READY banner in xterm" });

    await page.click(".term-host.active");
    const beforeText = await page.evaluate(() => document.body.innerText);
    const beforeCount = countEscBytes(beforeText);

    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");

    await waitForAsync(async () => {
      const text = await page!.evaluate(() => document.body.innerText);
      const afterCount = countEscBytes(text);
      return afterCount >= beforeCount + 3;
    }, { timeout: 5_000, what: "three new RX:1b lines after repeated Escape presses" });
  });

  it("held Escape key repeat sends each repeated ESC byte", async (t) => {
    if (!ptyAvailable) {
      t.skip("node-pty not available");
      return;
    }
    assert.ok(page, "Electron page should have loaded");

    await page.waitForSelector(".tab", { timeout: 10_000 });
    await waitForAsync(async () => {
      const text = await page!.evaluate(() => document.body.innerText);
      return text.includes("RAW_ECHO_READY");
    }, { timeout: 10_000, what: "RAW_ECHO_READY banner in xterm" });

    await page.click(".term-host.active");
    const beforeText = await page.evaluate(() => document.body.innerText);
    const beforeCount = countEscBytes(beforeText);

    await page.keyboard.down("Escape");
    await page.keyboard.down("Escape");
    await page.keyboard.down("Escape");
    await page.keyboard.up("Escape");

    await waitForAsync(async () => {
      const text = await page!.evaluate(() => document.body.innerText);
      const afterCount = countEscBytes(text);
      return afterCount >= beforeCount + 3;
    }, { timeout: 5_000, what: "three new RX:1b lines after held Escape key repeat" });
  });

  it("repeated Escape presses after tab focus each send a new ESC byte", async (t) => {
    if (!ptyAvailable) {
      t.skip("node-pty not available");
      return;
    }
    assert.ok(page, "Electron page should have loaded");

    await page.waitForSelector(".tab", { timeout: 10_000 });
    await waitForAsync(async () => {
      const text = await page!.evaluate(() => document.body.innerText);
      return text.includes("RAW_ECHO_READY");
    }, { timeout: 10_000, what: "RAW_ECHO_READY banner in xterm" });

    await page.click("#tabbar");
    const focusedBefore = await page.evaluate(() => document.activeElement?.tagName);
    assert.notEqual(focusedBefore, "TEXTAREA", "xterm should have lost focus after clicking tabbar");

    const beforeText = await page.evaluate(() => document.body.innerText);
    const beforeCount = countEscBytes(beforeText);

    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");

    await waitForAsync(async () => {
      const text = await page!.evaluate(() => document.body.innerText);
      const afterCount = countEscBytes(text);
      return afterCount >= beforeCount + 3;
    }, { timeout: 5_000, what: "three new RX:1b lines after repeated Escape-from-tabbar" });
  });
});
