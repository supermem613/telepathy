// End-to-end Electron + wall-viewer test: resizes the BrowserWindow,
// observes that the host's PTY (ConPTY on Windows, openpty elsewhere)
// receives a matching resize call.
//
// This is the regression for the "Copilot CLI prompt bar drawn off-screen"
// bug — the wall xterm fits to its own viewport but the host PTY stayed
// stuck at the wrapper's startup size. Bidirectional resize forwarding
// (browser → ws → orchestrator → IPC → wrapper → pty.resize) syncs them.
//
// Oracle: we read the wrapper's `--debug` stderr trace
// `[telepathy/wrapper] resize CxR`. That log is emitted from the line
// immediately above `pty.resize(cols, rows)` and is the authoritative
// size for ConPTY (TUI children like Copilot CLI inherit it via the
// console). We DON'T probe `process.stdout.columns` from a Node child,
// because Node-on-Windows under ConPTY doesn't always re-query its
// console size for non-TTY-aware code paths.

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
    "--debug",
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
  const token = /token: (TLP1[A-Z2-7]+)/.exec(hostStderr)![1]!;

  // Release the hold so the wrapper actually spawns echo-bot.
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

describe("electron e2e: window resize → host PTY resize", () => {
  it("OS window resize forwards to the host's ConPTY/PTY size", async (t) => {
    if (!ptyAvailable) {
      t.skip("node-pty not available");
      return;
    }
    assert.ok(page, "Electron page should have loaded");

    await page.waitForSelector(".tab", { timeout: 10_000 });
    await page.waitForSelector(".term-host.active", { timeout: 10_000 });

    const wrapperRe = /\[telepathy\/wrapper\] resize (\d+)x(\d+)/g;
    const resizeEvents = (): Array<{ cols: number; rows: number }> =>
      [...hostStderr.matchAll(wrapperRe)].map((m) => ({ cols: Number(m[1]), rows: Number(m[2]) }));

    const beforeFirstResize = resizeEvents().length;
    // Resize the OS window small enough to differ from the wrapper startup
    // default (132×42), big enough to be a plausible terminal.
    await app!.evaluate(({ BrowserWindow }, args) => {
      BrowserWindow.getAllWindows()[0].setSize(args.w, args.h);
    }, { w: 900, h: 600 });

    // The chain: window resize → xterm fit → ws → orchestrator → IPC
    // → pty.resize → wrapper logs `[telepathy/wrapper] resize CxR`.
    // Wait for a resize emitted after this test's explicit OS-window change;
    // earlier startup/activation fits may already have non-default sizes.
    await waitFor(
      () => resizeEvents().length > beforeFirstResize,
      { timeout: 10_000, what: "wrapper resize log line after first OS resize" },
    );

    const first = resizeEvents()[resizeEvents().length - 1]!;
    const firstCols = first.cols;
    const firstRows = first.rows;
    assert.ok(firstCols >= 40 && firstCols <= 200, `cols ${firstCols} not in [40,200]`);
    assert.ok(firstRows >= 10 && firstRows <= 80, `rows ${firstRows} not in [10,80]`);

    const beforeSecondResize = resizeEvents().length;
    // Resize again, larger this time. Confirm a second resize lands after
    // this explicit change (rules out "only initial size negotiated").
    await app!.evaluate(({ BrowserWindow }, args) => {
      BrowserWindow.getAllWindows()[0].setSize(args.w, args.h);
    }, { w: 1300, h: 850 });

    await waitFor(
      () => resizeEvents().length > beforeSecondResize,
      { timeout: 10_000, what: "wrapper resize log line after second OS resize" },
    );

    const second = resizeEvents()[resizeEvents().length - 1]!;
    const secondCols = second.cols;
    const secondRows = second.rows;
    assert.ok(secondCols >= 40 && secondCols <= 200, `cols ${secondCols} not in [40,200]`);
    assert.ok(secondRows >= 10 && secondRows <= 80, `rows ${secondRows} not in [10,80]`);
    assert.ok(
      secondCols !== firstCols || secondRows !== firstRows,
      `second resize should change PTY size (was ${firstCols}x${firstRows}, now ${secondCols}x${secondRows})`,
    );
  });
});
