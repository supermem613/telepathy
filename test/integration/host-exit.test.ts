// Regression: `telepathy host -- <child>` must exit cleanly when the
// wrapped child terminates — no "Unhandled 'error' event on Socket",
// no EAGAIN, no Node fatal-error stack trace dumped to the user.
//
// The bug this protects against: pty.onExit fans out an "exit" frame
// to all IPC subscribers (the in-process attachToWrapperIfPresent
// client is always one of them; with a peer attached, every TLS peer
// socket also gets pumped one last frame) and then calls process.exit.
// If a socket.write completes asynchronously with EAGAIN after the
// 'error' handler is gone (or was never attached), Node prints the
// "Unhandled 'error' event" trace and exits with code 1 instead of
// the child's exit code.
//
// We exercise BOTH the no-peer path (just the in-process IPC
// subscriber) and the with-peer path (Electron wall connected as a
// real TLS peer) — the with-peer path is where the user originally
// hit the crash.

import { describe, it, after } from "node:test";
import { strict as assert } from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { _electron as electron, type ElectronApplication } from "playwright";
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

const livePieces: { host?: ChildProcess; app?: ElectronApplication } = {};

after(async () => {
  if (livePieces.app) {
    await livePieces.app.close().catch(() => undefined);
  }
  if (livePieces.host && livePieces.host.exitCode === null && !livePieces.host.killed) {
    try {
      livePieces.host.kill("SIGKILL");
    } catch { /* ignore */ }
  }
  setTimeout(() => process.exit(0), 500).unref();
});

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

async function runHostUntilChildExits(opts: { withPeer: boolean }): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  const port = 18000 + Math.floor(Math.random() * 2000);

  const host = spawn(process.execPath, [
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
  livePieces.host = host;

  let stdout = "";
  let stderr = "";
  host.stdout!.on("data", (c: Buffer) => {
    stdout += c.toString("utf8");
  });
  host.stderr!.on("data", (c: Buffer) => {
    stderr += c.toString("utf8");
  });

  await waitFor(() => /token: TLP1[A-Z2-7]+/.test(stderr), { timeout: 10_000, what: "host token banner" });
  const token = /token: (TLP1[A-Z2-7]+)/.exec(stderr)![1]!;

  if (opts.withPeer) {
    // Launch Electron pre-linked to the host. A connecting peer
    // releases the hold automatically (no keypress needed) and gives
    // us the full subscriber path the user has when the crash hits.
    livePieces.app = await electron.launch({
      args: [resolve(ROOT, "electron/main.cjs"), `--token=${token}`],
      cwd: ROOT,
      env: { ...process.env, ELECTRON_DISABLE_SANDBOX: "1" },
    });
    const page = await livePieces.app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await page.waitForSelector(".tab", { timeout: 10_000 });
  } else {
    // No peer — release the hold with a lone Enter byte. classifyHoldInput
    // only treats a single-byte 0x0a/0x0d/0x20 chunk as a "key", so we
    // must NOT coalesce with another character.
    host.stdin!.write("\n");
  }

  await waitFor(() => /ECHO_BOT_READY/.test(stdout), { timeout: 15_000, what: "ECHO_BOT_READY in host stdout" });

  // Tell echo-bot to exit cleanly (the wrapped PTY input path is
  // host.stdin → wrapper → PTY → child stdin).
  host.stdin!.write("QUIT\r");

  const exitCode = await Promise.race<number | null>([
    new Promise<number | null>((res) => {
      host.once("exit", (code) => res(code));
    }),
    new Promise<number | null>((_, rej) => setTimeout(
      () => rej(new Error(`host did not exit within 10s. stderr so far:\n${stderr}\nstdout so far:\n${stdout}`)),
      10_000,
    )),
  ]);

  // Drop references so the next sub-test starts from a clean slate.
  livePieces.host = undefined;
  if (livePieces.app) {
    await livePieces.app.close().catch(() => undefined);
    livePieces.app = undefined;
  }

  return { stdout, stderr, exitCode };
}

function assertCleanExit(label: string, r: { stdout: string; stderr: string; exitCode: number | null }): void {
  assert.equal(r.stderr.includes("EAGAIN"), false, `[${label}] host stderr should not mention EAGAIN, got:\n${r.stderr}`);
  assert.equal(r.stderr.includes("Unhandled 'error' event"), false, `[${label}] host stderr should not contain "Unhandled 'error' event", got:\n${r.stderr}`);
  assert.equal(r.stderr.includes("Error: write "), false, `[${label}] host stderr should not contain a write-error stack, got:\n${r.stderr}`);
  assert.equal(r.exitCode, 0, `[${label}] host should exit 0 on clean child exit, got ${r.exitCode}`);
}

describe("host exits cleanly when the wrapped child terminates", () => {
  it("no EAGAIN / Unhandled 'error' event when no peer is attached", async (t) => {
    if (!ptyAvailable) {
      t.skip("node-pty not available");
      return;
    }
    const r = await runHostUntilChildExits({ withPeer: false });
    assertCleanExit("no-peer", r);
  });

  it("no EAGAIN / Unhandled 'error' event when an Electron wall peer is attached", async (t) => {
    if (!ptyAvailable) {
      t.skip("node-pty not available");
      return;
    }
    const r = await runHostUntilChildExits({ withPeer: true });
    assertCleanExit("with-peer", r);
  });
});
