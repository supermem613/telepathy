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
    try {
      const result = await acceptStart(opts);
      printBanner(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(chalk.yellow(`telepathy host: peer listener failed (${msg}). Continuing without LAN exposure.\n`));
    }
    await holdForFirstPeerOrKeypress();
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
function holdForFirstPeerOrKeypress(): Promise<"peer" | "key"> {
  return new Promise((resolve) => {
    let done = false;
    const settle = (reason: "peer" | "key", message: string): void => {
      if (done) {
        return;
      }
      done = true;
      cleanup();
      process.stderr.write(`${message}\n`);
      resolve(reason);
    };

    const unsubscribePeer = onFirstPeerConnect((peer) => {
      settle("peer", chalk.green(`✔ peer connected: ${peer.alias} (${peer.remoteAddr}). Spawning shell...`));
    });

    const onKey = (chunk: Buffer): void => {
      // Ctrl-C in the holding state aborts cleanly.
      if (chunk.length > 0 && chunk[0] === 0x03) {
        cleanup();
        process.stderr.write(chalk.dim("\n(aborted)\n"));
        process.exit(130);
      }
      settle("key", chalk.dim("✔ keypress detected. Spawning shell..."));
    };

    const wasRaw = process.stdin.isTTY ? process.stdin.isRaw : false;
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }
    process.stdin.resume();
    process.stdin.on("data", onKey);

    process.stderr.write(chalk.dim(`   waiting for a peer to connect, or press any key to start the shell now...\n`));

    function cleanup(): void {
      unsubscribePeer();
      process.stdin.off("data", onKey);
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
