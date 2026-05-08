import { describe, it, before, after } from "node:test";
import { strict as assert } from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PROMPT_ROW_BOT = resolve(dirname(fileURLToPath(import.meta.url)), "prompt-row-bot.cjs");

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
  const port = 24000 + Math.floor(Math.random() * 2000);

  host = spawn(process.execPath, [
    resolve(ROOT, "dist/cli.js"),
    "host",
    "-p", String(port),
    "--",
    process.execPath,
    PROMPT_ROW_BOT,
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

async function screenshotTextBottomGap(hostSelector: string): Promise<{ bottomGap: number; rowHeight: number | null }> {
  assert.ok(page, "Electron page should have loaded");
  const rowHeight = await page.evaluate((selector) => {
    const row = document.querySelector(`${selector} .xterm-rows > div`);
    return row?.getBoundingClientRect().height ?? null;
  }, hostSelector);
  const png = await page.screenshot({ type: "png" });
  const dataUrl = `data:image/png;base64,${png.toString("base64")}`;
  const bottomGap = await page.evaluate(async ({ selector, dataUrl: url }) => {
    const host = document.querySelector(selector);
    if (!host) {
      throw new Error(`host not found: ${selector}`);
    }
    const rect = host.getBoundingClientRect();
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("screenshot image failed to load"));
      img.src = url;
    });
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      throw new Error("2d canvas context unavailable");
    }
    ctx.drawImage(img, 0, 0);
    const scaleX = canvas.width / window.innerWidth;
    const scaleY = canvas.height / window.innerHeight;
    const left = Math.max(0, Math.floor(rect.left * scaleX));
    const right = Math.min(canvas.width, Math.ceil(rect.right * scaleX));
    const top = Math.max(0, Math.floor(rect.top * scaleY));
    const bottom = Math.min(canvas.height, Math.ceil(rect.bottom * scaleY));
    const pixels = ctx.getImageData(left, top, right - left, bottom - top).data;
    let bottomMostInk = -1;
    const width = right - left;
    for (let y = 0; y < bottom - top; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const offset = (y * width + x) * 4;
        if (pixels[offset]! + pixels[offset + 1]! + pixels[offset + 2]! > 120) {
          bottomMostInk = y;
        }
      }
    }
    if (bottomMostInk < 0) {
      throw new Error("no visible terminal ink found in screenshot");
    }
    return ((bottom - top) - bottomMostInk - 1) / scaleY;
  }, { selector: hostSelector, dataUrl });
  return { bottomGap, rowHeight };
}

describe("electron e2e: peer.html prompt row visual layout", () => {
  it("keeps late-connect prompt typing visually bottom-aligned", async (t) => {
    if (!ptyAvailable) {
      t.skip("node-pty not available");
      return;
    }
    assert.ok(page, "Electron page should have loaded");

    await page.waitForSelector(".tab", { timeout: 10_000 });
    await waitForAsync(async () => (await page!.evaluate(() => document.body.innerText)).includes("host>"),
      { timeout: 10_000, what: "host prompt in wall xterm before peer navigation" });

    const { origin, token, alias } = await page.evaluate(() => {
      const params = new URLSearchParams(location.search);
      const tab = document.querySelector(".tab") as HTMLElement | null;
      return {
        origin: location.origin,
        token: params.get("t"),
        alias: tab?.dataset.alias ?? null,
      };
    });
    assert.ok(token, "wall URL should include viewer token");
    assert.ok(alias, "wall should expose peer alias on the active tab");

    const peerUrl = `${origin}/peer/${encodeURIComponent(alias)}?t=${encodeURIComponent(token)}`;
    const peerWindow = app!.waitForEvent("window");
    await app!.evaluate(({ BrowserWindow }, url) => {
      const win = new BrowserWindow({
        width: 1280,
        height: 800,
        show: true,
        backgroundColor: "#000000",
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      });
      void win.loadURL(url);
    }, peerUrl);
    page = await peerWindow;
    await page.waitForLoadState("domcontentloaded");
    await page.waitForSelector("#term-host .xterm", { timeout: 10_000 });
    try {
      await waitForAsync(async () => (await page!.evaluate(() => document.body.innerText)).includes("host>"),
        { timeout: 10_000, what: "host prompt in peer xterm" });
    } catch (err) {
      const diag = await page.evaluate(() => ({
        href: location.href,
        bodyText: document.body.innerText,
        rows: Array.from(document.querySelectorAll("#term-host .xterm-rows > div")).map((row) => row.textContent ?? ""),
      }));
      throw new Error(`${err instanceof Error ? err.message : String(err)}; diag=${JSON.stringify(diag)}`);
    }

    await page.click("#term-host");
    await page.keyboard.type("abc");
    await waitForAsync(async () => (await page!.evaluate(() => document.body.innerText)).includes("abc"),
      { timeout: 5_000, what: "typed input echoed in peer xterm" });

    const state = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll("#term-host .xterm-rows > div"));
      const rowTexts = rows.map((row) => row.textContent ?? "");
      const typedRowEl = rows.find((row) => (row.textContent ?? "").includes("abc"));
      const host = document.querySelector("#term-host");
      const typedRect = typedRowEl?.getBoundingClientRect();
      const hostRect = host?.getBoundingClientRect();
      return {
        rowCount: rowTexts.length,
        promptRow: rowTexts.findIndex((row) => row.includes("host>")),
        typedRow: rowTexts.findIndex((row) => row.includes("abc")),
        bottomGap: typedRect && hostRect ? hostRect.bottom - typedRect.bottom : null,
        rowHeight: typedRect?.height ?? null,
        rowTexts,
      };
    });
    assert.equal(state.promptRow, state.rowCount - 1, `prompt should be on bottom row: ${JSON.stringify(state)}`);
    assert.equal(state.typedRow, state.promptRow, `typed input should land on prompt row: ${JSON.stringify(state)}`);
    assert.ok(state.bottomGap !== null && state.rowHeight !== null && state.bottomGap < state.rowHeight / 2,
      `typed row should sit at the visual bottom of peer terminal: ${JSON.stringify(state)}`);

    const pixelState = await screenshotTextBottomGap("#term-host");
    assert.ok(pixelState.rowHeight !== null && pixelState.bottomGap < pixelState.rowHeight / 2,
      `screenshot ink should reach peer terminal bottom: ${JSON.stringify(pixelState)}`);
  });
});
