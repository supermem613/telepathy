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
import { startWrapper } from "../core/pty-wrapper.js";
import {
  acceptStart,
  setLocalPty,
  type AcceptOptions,
} from "../core/api.js";
import { onFirstPeerConnect } from "../core/orchestrator.js";
import { attachToWrapperIfPresent } from "./host-pty-shim.js";
import { buildPipePath } from "../core/ipc.js";
import chalk from "chalk";

export type HostOptions = AcceptOptions & {
  command?: string;
  args?: string[];
  noListen?: boolean;       // skip listener; just wrap the process locally
};

export async function runHost(opts: HostOptions): Promise<void> {
  const { command, args } = resolveCommand(opts);

  const pipePath = buildPipePath();
  const env: Record<string, string | undefined> = {
    ...process.env,
    TELEPATHY_SOCKET: pipePath,
    TELEPATHY_LOCAL_ALIAS: process.env.TELEPATHY_ALIAS ?? hostname().toLowerCase(),
  };

  if (!opts.noListen) {
    let expiresInSec: number | undefined;
    try {
      const result = await acceptStart(opts);
      printBanner(result);
      expiresInSec = result.expiresInSec;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(chalk.yellow(`telepathy host: peer listener failed (${msg}). Continuing without LAN exposure.\n`));
    }
    await holdForFirstPeerOrKeypress({ expiresInSec });
  }

  const wrapper = await startWrapper({
    pipePath,
    command,
    args,
    cwd: process.cwd(),
    env,
  });
  if (!wrapper) {
    process.stderr.write(
      chalk.red("telepathy host: node-pty unavailable. Run `npm install` in this package, then `telepathy doctor`.\n"),
    );
    process.exit(2);
  }

  const localPty = await attachToWrapperIfPresent(pipePath);
  setLocalPty(localPty);
}

// Race "first peer connects" against "user presses any key". Resolves on
// whichever happens first. Idempotent — both branches clean up the other.
// Decide whether a stdin chunk should count as a deliberate user keypress
// when we're holding before spawning the shell. Exported so tests can pin
// the policy: terminal-generated escape sequences (focus events, mouse
// events, arrow keys, bracketed paste, cursor reports) must NOT count,
// because in raw mode terminals emit them constantly (e.g. on every
// alt-tab) and the user would never get a chance to actually wait.
//
// A standalone ESC press (single 0x1b byte) IS treated as a key.
//
// Returns "abort" for Ctrl-C (caller should exit 130), "key" for a real
// keypress, or "ignore" for anything we should not treat as user intent.
export type KeyClass = "key" | "abort" | "ignore";

export function classifyHoldInput(chunk: Buffer): KeyClass {
  if (chunk.length === 0) {
    return "ignore";
  }
  if (chunk[0] === 0x03) {
    return "abort";
  }
  if (chunk[0] === 0x1b && chunk.length > 1) {
    return "ignore";
  }
  return "key";
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
    // still holding, abort cleanly rather than spawn the shell into a
    // session no peer can ever reach.
    let expiryTimer: NodeJS.Timeout | undefined;
    if (opts.expiresInSec && opts.expiresInSec > 0) {
      expiryTimer = setTimeout(() => {
        settle("expired", chalk.yellow(`⏰ token expired (${Math.round(opts.expiresInSec! / 60)} min). Aborting host.`));
        process.exit(0);
      }, opts.expiresInSec * 1000);
    }

    const wasRaw = process.stdin.isTTY ? process.stdin.isRaw : false;
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }
    process.stdin.resume();
    process.stdin.on("data", onKey);

    process.stderr.write(chalk.dim(`   waiting for a peer to connect, or press any key to start the shell now...\n`));
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
    `   valid: ${Math.round(r.expiresInSec / 60)} min`,
    chalk.dim("   share the token with the other box; they run `telepathy connect <token>`"),
    "",
  ];
  process.stderr.write(`${lines.join("\n")}\n`);
}
