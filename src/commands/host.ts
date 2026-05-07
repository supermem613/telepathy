// `telepathy host` — wrap any process under a ConPTY and bind a LAN
// listener so peers can attach. The wrapper is the parent of the
// spawned program; it owns the pseudo-terminal and tees frames to the
// user's terminal AND to peer subscribers via the orchestrator.
//
// Flow:
//   1. acceptStart() binds the LAN listener immediately
//   2. Print the join token banner
//   3. Hold: race "first peer connects" vs "user presses any key"
//      (peers can connect during the hold; the orchestrator queues their
//      pty_subscribe until the local PTY appears)
//   4. Spawn the wrapped shell under ConPTY
//   5. Drain any queued pty_subscribes — peers see the shell from frame 0

import { hostname } from "node:os";
import { execSync } from "node:child_process";
import { connect as netConnect } from "node:net";
import { startWrapper } from "../core/pty-wrapper.js";
import {
  acceptStart,
  rotateListenerSecret,
  setLocalPty,
  type AcceptOptions,
} from "../core/api.js";
import { onFirstPeerConnect } from "../core/orchestrator.js";
import { attachToWrapperIfPresent } from "./host-pty-shim.js";
import { buildPipePath } from "../core/ipc.js";
import { isDebug } from "../core/debug.js";
import chalk from "chalk";

export type HostOptions = AcceptOptions & {
  command?: string;
  args?: string[];
  noListen?: boolean;       // skip listener; just wrap the process locally
  // Internal: write the join token as `{"token":"TLP1…"}\n` to this pipe
  // path right after acceptStart resolves, then close. Used by the
  // spawn-host RPC so a parent host can capture a child host's token
  // without scraping stdout. End-users don't set this directly.
  tokenHandoffPipe?: string;
};

const REPAIR_TOKEN_TTL_MS = 60 * 1000;

// Find what's holding a TCP port (Windows / Linux / macOS). Best-effort —
// returns a human-readable string like "node.exe (pid 12345)" or undefined
// if nothing matches or we can't probe (no permissions, missing tooling).
// Used purely for the EADDRINUSE error message; never throws.
function describePortHolder(port: number): string | undefined {
  try {
    if (process.platform === "win32") {
      const out = execSync(`powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty OwningProcess"`, { stdio: ["ignore", "pipe", "ignore"], timeout: 3000 }).toString().trim();
      const holderPid = Number(out);
      if (!Number.isFinite(holderPid) || holderPid <= 0) {
        return undefined;
      }
      const nameOut = execSync(`powershell -NoProfile -Command "(Get-Process -Id ${holderPid} -ErrorAction SilentlyContinue).ProcessName"`, { stdio: ["ignore", "pipe", "ignore"], timeout: 3000 }).toString().trim();
      return `${nameOut || "process"} (pid ${holderPid})`;
    }
    // POSIX: lsof -tiTCP:<port> -sTCP:LISTEN
    const out = execSync(`lsof -tiTCP:${port} -sTCP:LISTEN 2>/dev/null | head -n 1`, { stdio: ["ignore", "pipe", "ignore"], timeout: 3000, shell: "/bin/sh" }).toString().trim();
    const holderPid = Number(out);
    if (!Number.isFinite(holderPid) || holderPid <= 0) {
      return undefined;
    }
    const nameOut = execSync(`ps -o comm= -p ${holderPid} 2>/dev/null`, { stdio: ["ignore", "pipe", "ignore"], timeout: 3000, shell: "/bin/sh" }).toString().trim();
    return `${nameOut || "process"} (pid ${holderPid})`;
  } catch {
    return undefined;
  }
}

export async function runHost(opts: HostOptions): Promise<void> {
  const { command, args } = resolveCommand(opts);

  const pipePath = buildPipePath();
  const env: Record<string, string | undefined> = {
    ...process.env,
    TELEPATHY_SOCKET: pipePath,
    TELEPATHY_LOCAL_ALIAS: process.env.TELEPATHY_ALIAS ?? hostname().toLowerCase(),
  };

  if (!opts.noListen) {
    let acceptedToken: string | undefined;
    let expiresInSec: number | undefined;
    try {
      const result = await acceptStart(opts);
      printBanner(result);
      acceptedToken = result.token;
      expiresInSec = result.expiresInSec;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // EADDRINUSE here means the user passed `-p <port>` explicitly and
      // that port is taken. (Without `-p`, acceptStart auto-falls back from
      // DEFAULT_PORT to an OS-assigned port — see api.ts.) The user asked
      // for that specific port for a reason (firewall rule, dev setup), so
      // surface the conflict with a fix path instead of silently picking
      // a different one.
      if (/EADDRINUSE/i.test(msg)) {
        const port = opts.port!;
        const holder = describePortHolder(port);
        process.stderr.write(chalk.red(`telepathy host: port ${port} is already in use`));
        if (holder) {
          process.stderr.write(chalk.red(` by ${holder}`));
        }
        process.stderr.write(chalk.red(`.\n\n`));
        process.stderr.write(chalk.dim(`You explicitly requested port ${port} with \`-p\`. Fixes:\n`));
        if (holder) {
          const m = /pid (\d+)/.exec(holder);
          if (m) {
            process.stderr.write(chalk.dim(`  • kill the holder:  Stop-Process -Id ${m[1]} -Force        (Windows)\n`));
            process.stderr.write(chalk.dim(`                      kill ${m[1]}                                 (POSIX)\n`));
          }
        }
        process.stderr.write(chalk.dim(`  • drop \`-p\` to let telepathy auto-pick a free port\n`));
        process.exit(1);
      }
      // Other errors (e.g. permission denied on a privileged port) — same
      // story: a hold without a token is useless. Surface the real error.
      process.stderr.write(chalk.red(`telepathy host: failed to bind listener (${msg})\n`));
      process.exit(1);
    }
    if (opts.tokenHandoffPipe && acceptedToken) {
      try {
        await writeTokenToHandoffPipe(opts.tokenHandoffPipe, acceptedToken);
      } catch (err) {
        // Non-fatal: a parent that asked for handoff will time out and
        // surface its own error. The user still has the printed banner
        // and can connect manually.
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(chalk.yellow(`telepathy host: token handoff to ${opts.tokenHandoffPipe} failed (${msg}); proceeding without handoff\n`));
      }
    }
    await holdForFirstPeerOrKeypress({ expiresInSec });
  }

  const wrapper = await startWrapper({
    pipePath,
    command,
    args,
    cwd: process.cwd(),
    env,
    onReconnectRequest: () => formatRePairBanner(rotateListenerSecret({ ttlMs: REPAIR_TOKEN_TTL_MS })),
  });
  if (!wrapper) {
    process.stderr.write(
      chalk.red("telepathy host: node-pty unavailable. Run `npm install` in this package, then `telepathy doctor`.\n"),
    );
    process.exit(2);
  }

  const localPty = await attachToWrapperIfPresent(pipePath);
  setLocalPty(localPty);

  // Top-level SIGINT/SIGTERM — last-resort escape hatch. Once the shell
  // is spawned, raw-mode stdin delivers Ctrl-C bytes to the child rather
  // than as a SIGINT signal to us, so this rarely fires for user Ctrl-C.
  // It DOES fire when:
  //   - Parent terminal sends SIGTERM (taskkill /pid, kill, IDE close)
  //   - The wrapped shell hangs and the user runs `Stop-Process -Id` from
  //     elsewhere with the friendlier signal first
  // Without this handler, those signals would leave node's TLS server
  // and PTY pipes orphaned for ~seconds before the OS hard-killed us.
  const onSignal = (sig: NodeJS.Signals): void => {
    if (isDebug()) {
      process.stderr.write(`[telepathy/host] ${sig} received — exiting\n`);
    }
    try {
      localPty?.close(); 
    } catch { /* ignore */ }
    process.exit(sig === "SIGINT" ? 130 : 0);
  };
  process.once("SIGINT", () => onSignal("SIGINT"));
  process.once("SIGTERM", () => onSignal("SIGTERM"));
  process.once("SIGHUP", () => onSignal("SIGHUP"));
}

// Race "first peer connects" against "user presses any key". Resolves on
// whichever happens first. Idempotent — both branches clean up the other.
// Decide whether a stdin chunk should count as a deliberate user action
// during the hold. Whitelist-only — only specific keys count, everything
// else is silently dropped.
//
// This avoids the rabbit-hole of trying to filter terminal noise (focus
// events, mouse events, win32-input-mode, etc.) — modern terminals emit
// dozens of byte sequences for things the user didn't intend, and any
// blacklist will eventually be wrong. A whitelist is bulletproof.
//
// Whitelist:
//   • Ctrl-C (0x03) → abort
//   • Enter (CR 0x0D or LF 0x0A) → start
//   • Space (0x20) → start
//
// All other bytes / sequences → ignore.
//
// Returns "abort" for Ctrl-C (caller exits 130), "key" for Enter/Space
// (caller spawns shell), "ignore" for anything else.
export type KeyClass = "key" | "abort" | "ignore";

export function classifyHoldInput(chunk: Buffer): KeyClass {
  if (chunk.length === 0) {
    return "ignore";
  }
  // Ctrl-C anywhere in the chunk → abort. (win32-input-mode encodes
  // Ctrl-C as a longer escape sequence; cover both raw and encoded.)
  if (chunk.includes(0x03)) {
    return "abort";
  }
  // Single-byte Enter (CR or LF) or Space → start.
  if (chunk.length === 1) {
    const b = chunk[0]!;
    if (b === 0x0d || b === 0x0a || b === 0x20) {
      return "key";
    }
  }
  // Win32-input-mode wraps Enter and Space in a CSI sequence too. Detect
  // the unicode-codepoint field (3rd ;-separated number after `ESC[`):
  //   `ESC[<Vk>;<Sc>;<Uc>;<Kd>;<Cs>;<Rc>_`
  // Match key-DOWN (Kd=1) for Enter (Uc=13), LF (Uc=10), or Space (Uc=32).
  if (chunk.length >= 4 && chunk[0] === 0x1b && chunk[1] === 0x5b) {
    const text = chunk.toString("utf8");
    // ESC character (0x1b) expressed via String.fromCharCode to avoid a
    // literal control char in a regex literal (eslint no-control-regex).
    const m = new RegExp(`^${String.fromCharCode(0x1b)}\\[(\\d+);(\\d+);(\\d+);(\\d+);`).exec(text);
    if (m) {
      const uc = Number(m[3]);
      const kd = Number(m[4]);
      if (kd === 1 && (uc === 13 || uc === 10 || uc === 32)) {
        return "key";
      }
    }
  }
  return "ignore";
}

function holdForFirstPeerOrKeypress(opts: { expiresInSec?: number } = {}): Promise<"peer" | "key" | "expired"> {
  return new Promise((resolve) => {
    let done = false;
    const settle = (reason: "peer" | "key" | "expired", message: string): void => {
      if (done) {
        return;
      }
      done = true;
      cleanup();
      process.stderr.write(`${message}\n`);
      resolve(reason);
    };
    const abort = (message: string, code: number): void => {
      if (done) {
        return;
      }
      done = true;
      cleanup();
      process.stderr.write(`${message}\n`);
      process.exit(code);
    };

    const unsubscribePeer = onFirstPeerConnect((peer) => {
      settle("peer", chalk.green(`✔ peer connected: ${peer.alias} (${peer.remoteAddr}). Spawning shell...`));
    });

    const onKey = (chunk: Buffer): void => {
      const cls = classifyHoldInput(chunk);
      if (isDebug()) {
        process.stderr.write(chalk.dim(`[telepathy/hold] stdin ${chunk.length}B [${[...chunk].slice(0, 8).map((b) => b.toString(16).padStart(2, "0")).join(" ")}] → ${cls}\n`));
      }
      if (cls === "abort") {
        abort(chalk.dim("\n(aborted)"), 130);
        return;
      }
      if (cls === "ignore") {
        return;
      }
      settle("key", chalk.dim("✔ keypress detected. Spawning shell..."));
    };

    // SIGINT belt-and-suspenders. Raw-mode stdin SHOULD deliver Ctrl-C as
    // the 0x03 byte through onKey, but on some terminal/Node combos
    // (non-TTY stdin, setRawMode silently failing, etc.) Ctrl-C arrives
    // as a SIGINT signal instead. Either path now exits cleanly.
    const onSigint = (): void => {
      abort(chalk.dim("\n(aborted)"), 130);
    };
    process.once("SIGINT", onSigint);

    // Token expiry: if the listener's join token TTL elapses while we're
    // still holding (no peer connected yet), abort cleanly rather than
    // spawn the shell into a session no peer can ever reach. After this
    // point the listener's pskCallback would reject any new dial anyway
    // (see api.ts ACCEPT_TOKEN_TTL_MS / transport.ts getExpiresAt gate).
    let expiryTimer: NodeJS.Timeout | undefined;
    if (opts.expiresInSec && opts.expiresInSec > 0) {
      expiryTimer = setTimeout(() => {
        settle("expired", chalk.yellow(`⏰ token expired (${Math.round(opts.expiresInSec! / 60)} min). Aborting host.`));
        process.exit(0);
      }, opts.expiresInSec * 1000);
    }

    const wasRaw = process.stdin.isTTY ? process.stdin.isRaw : false;
    if (process.stdin.isTTY) {
      try {
        process.stdin.setRawMode(true);
        if (isDebug()) {
          process.stderr.write(chalk.dim(`[telepathy/hold] stdin: TTY=true, setRawMode(true) ok, isRaw=${process.stdin.isRaw}\n`));
        }
      } catch (err) {
        process.stderr.write(chalk.yellow(`[telepathy/hold] setRawMode failed: ${err instanceof Error ? err.message : String(err)} — keypress detection may not work\n`));
      }
    } else if (isDebug()) {
      process.stderr.write(chalk.dim(`[telepathy/hold] stdin: TTY=false (no raw mode)\n`));
    }
    process.stdin.resume();
    process.stdin.on("data", onKey);

    process.stderr.write(chalk.dim(`   waiting for a peer to connect, or press Enter / Space to start the shell now...\n`));
    process.stderr.write(chalk.dim(`   (Ctrl-C to abort)\n`));

    function cleanup(): void {
      unsubscribePeer();
      process.stdin.off("data", onKey);
      process.off("SIGINT", onSigint);
      if (expiryTimer) {
        clearTimeout(expiryTimer);
      }
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(wasRaw);
      }
      // Don't pause stdin — startWrapper is about to take it over.
    }
  });
}

function resolveCommand(opts: HostOptions): { command: string; args: string[] } {
  if (opts.command) {
    return { command: opts.command, args: opts.args ?? [] };
  }
  if (process.platform === "win32") {
    return { command: process.env.COMSPEC ?? "pwsh.exe", args: [] };
  }
  const sh = process.env.SHELL ?? "/bin/bash";
  return { command: sh, args: [] };
}

function printBanner(r: { token: string; addr: string; bindHost: string; expiresInSec: number }): void {
  const lines = [
    "",
    chalk.cyan("📡 telepathy host ready"),
    `   bound: ${r.bindHost}:${r.addr.split(":")[1]}`,
    `   addr:  ${r.addr}    (encoded into the token below)`,
    `   token: ${chalk.bold(r.token)}`,
    `   valid: ${Math.round(r.expiresInSec / 60)} min, single-use`,
    chalk.dim("   share the token with the other box; they run `telepathy connect <token>`"),
    chalk.dim("   if the app disconnects later, type `telepathy reconnect` here to re-pair"),
    "",
  ];
  process.stderr.write(`${lines.join("\n")}\n`);
}

function formatRePairBanner(r: { token: string; addr: string; bindHost: string; expiresInSec: number }): string {
  return [
    chalk.cyan("📡 telepathy re-pair token"),
    `   bound: ${r.bindHost}`,
    `   addr:  ${r.addr}`,
    `   token: ${chalk.bold(r.token)}`,
    `   valid: ${r.expiresInSec} sec, single-use`,
    chalk.dim("   share with the box that needs to reconnect; they run `telepathy app <token>` or `telepathy connect <token>`"),
  ].join("\n");
}

// Write `{"token":"TLP1…"}\n` to a host-local IPC pipe and close. Used
// by the spawn-host RPC: the parent `telepathy host` creates the pipe
// before launching this child; this child writes one JSON line and
// disconnects. ~5 s connect budget — the parent should already be
// listening before we ever ran.
function writeTokenToHandoffPipe(pipePath: string, token: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = netConnect(pipePath);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`handoff pipe ${pipePath} did not accept a connection within 5s`));
    }, 5_000);
    socket.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.write(`${JSON.stringify({ token })}\n`, (err) => {
        if (err) {
          reject(err);
          return;
        }
        socket.end();
        resolve();
      });
    });
  });
}
