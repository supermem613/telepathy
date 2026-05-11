import { describe, it, before, after } from "node:test";
import { strict as assert } from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const COPILOT_TRACE_BOT = resolve(dirname(fileURLToPath(import.meta.url)), "copilot-trace-bot.mjs");

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
  const port = 22000 + Math.floor(Math.random() * 2000);

  host = spawn(process.execPath, [
    resolve(ROOT, "dist/cli.js"),
    "host",
    "-p", String(port),
    "--",
    process.execPath,
    COPILOT_TRACE_BOT,
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
  // Guards the Windows runner viewport: Electron can be height-constrained
  // there, and replay-only TUI traces must still show prompt/status rows.
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].setSize(1280, 600);
  });
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

describe("electron e2e: recorded Copilot CLI trace visual replay", () => {
  it("renders the real Copilot CLI trace in the wall xterm without falling out of alt-screen layout", async (t) => {
    if (!ptyAvailable) {
      t.skip("node-pty not available");
      return;
    }
    assert.ok(page, "Electron page should have loaded");

    await page.waitForSelector(".term-host.active .xterm", { timeout: 10_000 });
    try {
      await waitForAsync(async () => {
        const text = await page!.evaluate(() => document.body.innerText);
        return text.includes("Environment loaded") && text.includes("/ commands · ? help");
      }, { timeout: 10_000, what: "recorded Copilot CLI trace visible in xterm" });
    } catch (err) {
      const diag = await page.evaluate(() => ({
        bodyText: document.body.innerText,
        rows: Array.from(document.querySelectorAll(".term-host.active .xterm-rows > div")).map((row) => row.textContent ?? ""),
      }));
      throw new Error(`${err instanceof Error ? err.message : String(err)}; diag=${JSON.stringify(diag)}`);
    }

    const state = await page.evaluate(() => {
      const host = document.querySelector(".term-host.active");
      const xterm = document.querySelector(".term-host.active .xterm");
      const rows = Array.from(document.querySelectorAll(".term-host.active .xterm-rows > div"));
      const nonEmptyRows = rows
        .map((row, index) => ({ index, text: row.textContent ?? "", rect: row.getBoundingClientRect() }))
        .filter((row) => row.text.trim().length > 0);
      const hostRect = host?.getBoundingClientRect();
      const xtermRect = xterm?.getBoundingClientRect();
      const last = nonEmptyRows[nonEmptyRows.length - 1];
      return {
        rows: rows.length,
        nonEmptyRowCount: nonEmptyRows.length,
        hasEnvironmentLoaded: nonEmptyRows.some((row) => row.text.includes("Environment loaded")),
        hasPromptStatus: nonEmptyRows.some((row) => row.text.includes("/ commands · ? help")),
        bottomGap: hostRect && last ? hostRect.bottom - last.rect.bottom : null,
        xtermBottomGap: hostRect && xtermRect ? hostRect.bottom - xtermRect.bottom : null,
        lastText: last?.text ?? null,
      };
    });

    assert.equal(state.hasEnvironmentLoaded, true, `Copilot environment status should render: ${JSON.stringify(state)}`);
    assert.equal(state.hasPromptStatus, true, `Copilot prompt status should render: ${JSON.stringify(state)}`);
    assert.ok(state.nonEmptyRowCount >= 5, `trace should render multiple visible rows: ${JSON.stringify(state)}`);
    assert.ok(state.xtermBottomGap !== null && state.xtermBottomGap < 2,
      `xterm grid should be bottom-aligned in the host: ${JSON.stringify(state)}`);
  });
});
