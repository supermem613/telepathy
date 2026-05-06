// End-to-end Electron + wall-viewer test for tab renaming.
//
// Reproduces the user-visible flow: double-click a tab label, type a new
// name, press Enter, then verify the label shows the new text and that
// the renamed label is itself dblclick-renamable (regression for the
// case where the swapped-in <span> never re-binds the dblclick listener).
//
// Path tested:
//   wall.html → label.dblclick → startRename → input → Enter → commit
//   → new <span> with dblclick listener.

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
  const port = 18000 + Math.floor(Math.random() * 2000);

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

  await waitFor(() => /token: (TLP1[A-Z2-7]+)/.test(hostStderr), { timeout: 10_000, what: "host token banner" });
  const m = /token: (TLP1[A-Z2-7]+)/.exec(hostStderr)!;
  const token = m[1]!;

  // Release the hold so the wrapper spawns the child.
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

describe("electron e2e: tab rename via double-click + type + Enter", () => {
  it("renames the tab label and keeps it dblclick-renamable", async (t) => {
    if (!ptyAvailable) {
      t.skip("node-pty not available");
      return;
    }
    assert.ok(page, "Electron page should have loaded");

    await page.waitForSelector(".tab .label", { timeout: 10_000 });

    // Capture the original label text — wall.html composes it as
    // `peer.alias[(remoteAlias)]`, so the rename input prefills with
    // exactly this string.
    const originalText = (await page.$eval(".tab .label", (el) => (el.textContent || "").trim()));
    assert.ok(originalText.length > 0, "expected a non-empty original label");

    // 1. Double-click the label → rename input should appear in its place.
    await page.dblclick(".tab .label");
    await page.waitForSelector(".tab input.rename-input", { timeout: 2_000 });

    // 2. Input must be focused so the user's keystrokes go into it
    //    rather than being eaten by the term that activate() focused.
    const focusedTag = await page.evaluate(() => document.activeElement?.tagName ?? "");
    assert.equal(focusedTag, "INPUT", `rename input should have focus, but document.activeElement was <${focusedTag}>`);

    // 3. Input value must match the original text so the user is editing
    //    the current name, not an empty field.
    const prefill = await page.$eval(".tab input.rename-input", (el) => (el as HTMLInputElement).value);
    assert.equal(prefill, originalText, "rename input should prefill with the current label text");

    // 4. Selection should cover the prefilled text so typing immediately
    //    overwrites instead of appending.
    const selection = await page.$eval(".tab input.rename-input", (el) => {
      const i = el as HTMLInputElement;
      return { start: i.selectionStart, end: i.selectionEnd, len: i.value.length };
    });
    assert.equal(selection.start, 0, "rename input selection should start at 0");
    assert.equal(selection.end, selection.len, "rename input selection should cover the full prefill");

    // 5. Type a new name and press Enter — the input must be replaced
    //    by a <span class="label"> showing the new text.
    const newName = "renamed-tab-xyz";
    await page.keyboard.type(newName);
    await page.keyboard.press("Enter");

    await waitForAsync(async () => {
      const txt = await page!.$eval(".tab .label", (el) => (el.textContent || "").trim());
      return txt === newName;
    }, { timeout: 3_000, what: `label to read "${newName}"` });

    // The rename-input must be gone (no leftover <input> in the DOM).
    const inputCount = await page.$$eval(".tab input.rename-input", (els) => els.length);
    assert.equal(inputCount, 0, "rename input should be removed after commit");

    // 6. The new <span> must itself be dblclick-renamable — regression
    //    for the case where commit() forgets to wire the listener.
    await page.dblclick(".tab .label");
    await page.waitForSelector(".tab input.rename-input", { timeout: 2_000 });
    const reprefill = await page.$eval(".tab input.rename-input", (el) => (el as HTMLInputElement).value);
    assert.equal(reprefill, newName, "second rename should prefill with the renamed label, not the original");

    // 7. Escape cancels — label should revert to the renamed text.
    await page.keyboard.press("Escape");
    await waitForAsync(async () => {
      const txt = await page!.$eval(".tab .label", (el) => (el.textContent || "").trim());
      return txt === newName;
    }, { timeout: 2_000, what: `label to remain "${newName}" after Escape` });
  });
});
