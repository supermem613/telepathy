// End-to-end Electron + wall-viewer clipboard tests. These drive the real
// BrowserWindow so failures identify the browser/xterm clipboard seam, not
// the lower-level telepathy PTY transport.

import { describe, it, before, after } from "node:test";
import { strict as assert } from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const RAW_ECHO = resolve(dirname(fileURLToPath(import.meta.url)), "raw-echo.cjs");

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
  const port = 20000 + Math.floor(Math.random() * 2000);

  host = spawn(process.execPath, [
    resolve(ROOT, "dist/cli.js"),
    "host",
    "-p", String(port),
    "--",
    process.execPath,
    RAW_ECHO,
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
  const token = /token: (TLP1[A-Z2-7]+)/.exec(hostStderr)![1]!;

  host.stdin!.write("a\n");
  await new Promise((r) => setTimeout(r, 500));

  app = await electron.launch({
    args: [resolve(ROOT, "electron/main.cjs"), `--token=${token}`],
    cwd: ROOT,
    env: { ...process.env, ELECTRON_DISABLE_SANDBOX: "1" },
  });
  page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await page.waitForSelector(".term-host.active .xterm", { timeout: 10_000 });
  await waitForTerminalText("RAW_ECHO_READY", "raw echo ready banner");
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

async function waitForTerminalText(text: string, what: string): Promise<void> {
  await waitForAsync(async () => {
    assert.ok(page, "Electron page should have loaded");
    return (await page.evaluate(() => document.body.innerText)).includes(text);
  }, { timeout: 10_000, what });
}

async function electronClipboardText(): Promise<string> {
  assert.ok(app, "Electron app should have loaded");
  return app.evaluate(({ clipboard }) => clipboard.readText());
}

async function setElectronClipboardText(text: string): Promise<void> {
  assert.ok(app, "Electron app should have loaded");
  await app.evaluate(({ clipboard }, value) => clipboard.writeText(value), text);
}

async function pressTerminalShortcut(key: "c" | "v"): Promise<void> {
  assert.ok(page, "Electron page should have loaded");
  await page.evaluate((shortcutKey) => {
    const textarea = document.querySelector(".term-host.active textarea") as HTMLTextAreaElement | null;
    if (!textarea) {
      throw new Error("active terminal textarea not found");
    }
    textarea.focus();
    textarea.dispatchEvent(new KeyboardEvent("keydown", {
      key: shortcutKey,
      code: `Key${shortcutKey.toUpperCase()}`,
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    }));
  }, key);
}

async function selectVisibleText(text: string): Promise<void> {
  assert.ok(page, "Electron page should have loaded");
  const selected = await page.evaluate((needle) => {
    const spans = Array.from(document.querySelectorAll(".term-host.active .xterm-rows > div span"));
    const span = spans.find((el) => (el.textContent || "").includes(needle));
    if (!span) {
      return false;
    }
    const textarea = document.querySelector(".term-host.active textarea") as HTMLTextAreaElement | null;
    if (!textarea) {
      return false;
    }
    textarea.value = needle;
    textarea.focus();
    textarea.select();
    return true;
  }, text);
  assert.equal(selected, true, `expected visible terminal text containing ${JSON.stringify(text)}`);
  await waitForAsync(async () => {
    const state = await activeTermDebugState() as { selectedText: string; textareaValue: string | null };
    return state.selectedText.includes(text) || (state.textareaValue ?? "").includes(text);
  }, { timeout: 2_000, what: `xterm selection containing ${JSON.stringify(text)}` });
}

async function activeTermDebugState(): Promise<unknown> {
  assert.ok(page, "Electron page should have loaded");
  return page.evaluate(() => {
    const textarea = document.querySelector(".term-host.active textarea") as HTMLTextAreaElement | null;
    const selection = window.getSelection();
    return {
      activeTag: document.activeElement?.tagName ?? null,
      activeClass: (document.activeElement as HTMLElement | null)?.className ?? null,
      selectedText: selection?.toString() ?? "",
      textareaValue: textarea?.value ?? null,
      textareaSelectionStart: textarea?.selectionStart ?? null,
      textareaSelectionEnd: textarea?.selectionEnd ?? null,
      textareaFocused: textarea === document.activeElement,
    };
  });
}

describe("electron e2e: wall clipboard gestures", () => {
  it("Ctrl+C copies selected terminal text instead of sending ETX to the PTY", async (t) => {
    if (!ptyAvailable) {
      t.skip("node-pty not available");
      return;
    }
    assert.ok(page, "Electron page should have loaded");

    await selectVisibleText("RAW_ECHO_READY");
    await setElectronClipboardText("");
    await pressTerminalShortcut("c");

    const copied = await electronClipboardText();
    assert.match(copied, /RAW_ECHO_READY/, `Ctrl+C did not copy the xterm selection; state=${JSON.stringify(await activeTermDebugState())}`);
    const screen = await page.evaluate(() => document.body.innerText);
    assert.doesNotMatch(screen, /RX:03/, "Ctrl+C while text is selected should not send ETX to the remote PTY");
  });

  it("Ctrl+V pastes clipboard text into the connected terminal", async (t) => {
    if (!ptyAvailable) {
      t.skip("node-pty not available");
      return;
    }
    assert.ok(page, "Electron page should have loaded");

    await page.click(".term-host.active");
    await setElectronClipboardText("PASTE_CTRL_V");
    await pressTerminalShortcut("v");

    await waitForTerminalText("RX:50415354455f4354524c5f56", "Ctrl+V pasted bytes");
  });

  it("right-click copies selected terminal text", async (t) => {
    if (!ptyAvailable) {
      t.skip("node-pty not available");
      return;
    }
    assert.ok(page, "Electron page should have loaded");

    await selectVisibleText("RAW_ECHO_READY");
    await setElectronClipboardText("");
    await page.click(".term-host.active .xterm", { button: "right" });

    const copied = await electronClipboardText();
    assert.match(copied, /RAW_ECHO_READY/, `right-click did not copy the xterm selection; state=${JSON.stringify(await activeTermDebugState())}`);
  });

  it("right-click paste sends clipboard text into the connected terminal", async (t) => {
    if (!ptyAvailable) {
      t.skip("node-pty not available");
      return;
    }
    assert.ok(page, "Electron page should have loaded");

    await setElectronClipboardText("PASTE_RIGHT_CLICK");
    await page.click(".term-host.active .xterm");
    await page.click(".term-host.active .xterm", { button: "right" });

    await waitForTerminalText("RX:50415354455f52494748545f434c49434b", "right-click paste bytes");
  });
});
