// `telepathy connect <token> --term` — mirror the remote PTY in the
// current terminal instead of the browser viewer. stdin keystrokes are
// forwarded to the remote PTY; remote frames are written verbatim to
// stdout. Ctrl-] (ASCII 0x1d) sends a quit escape so the user can
// disconnect even when the remote is in raw-mode TUIs.

import { connectPeer } from "../core/api.js";
import {
  addOrchestratorEvents,
  subscribeRemotePty,
  sendRemoteInput,
  unsubscribeRemotePty,
} from "../core/orchestrator.js";
import { randomUUID } from "node:crypto";
import chalk from "chalk";
import type { Peer } from "../core/peers.js";

export type TermOptions = {
  token: string;
  alias?: string;
};

const QUIT_KEY = 0x1d; // Ctrl-] — same convention as telnet/ssh

export async function runTermMode(opts: TermOptions): Promise<void> {
  let result;
  try {
    result = await connectPeer({ token: opts.token, alias: opts.alias });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(chalk.red(`connect failed: ${msg}\n`));
    process.exit(1);
  }
  process.stderr.write(
    `${chalk.cyan("🔗 linked")} alias=${chalk.bold(result.alias)} (remote=${result.remoteAlias} at ${result.remoteAddr})\n`,
  );
  process.stderr.write(chalk.dim("   PTY mirror — press Ctrl-] to disconnect.\n\n"));

  let peerForCleanup: Peer | undefined;
  addOrchestratorEvents({
    onRemoteFrame: (peer, dataBase64) => {
      peerForCleanup = peer;
      process.stdout.write(Buffer.from(dataBase64, "base64"));
    },
    onRemoteResize: () => {
      // The remote PTY's size changed; we just keep echoing whatever
      // bytes it sends. Mirroring the resize to the local terminal would
      // require resizing the user's window, which we can't do.
    },
    onPeerDisconnected: (peer, reason) => {
      restoreTty();
      process.stderr.write(`\n${chalk.dim(`(remote ${peer.alias} disconnected${reason ? `: ${reason}` : ""})`)}\n`);
      process.exit(0);
    },
  });

  // Subscribe to the remote PTY (we already have a Peer registered by adoptOutgoing).
  // Need its socket reference; orchestrator looks it up by alias.
  // We rely on listPeers to find ours.
  const { listPeers } = await import("../core/peers.js");
  const peer = listPeers().find((p) => p.alias === result.alias);
  if (!peer) {
    process.stderr.write(chalk.red("internal error: peer not found in registry after connect\n"));
    process.exit(1);
  }
  peerForCleanup = peer;
  subscribeRemotePty(peer, randomUUID());

  // Set raw mode and forward keystrokes; intercept Ctrl-] for quit.
  let wasRaw = false;
  if (process.stdin.isTTY) {
    wasRaw = process.stdin.isRaw;
    process.stdin.setRawMode(true);
  }
  process.stdin.resume();
  process.stdin.on("data", (chunk: Buffer) => {
    // Scan for the quit key. If present, disconnect cleanly. We forward
    // any bytes BEFORE the quit key so partial input isn't lost.
    const idx = chunk.indexOf(QUIT_KEY);
    if (idx >= 0) {
      if (idx > 0) {
        sendRemoteInput(peer, chunk.subarray(0, idx).toString("base64"));
      }
      restoreTty();
      if (peerForCleanup) {
        try {
          unsubscribeRemotePty(peerForCleanup); 
        } catch { /* ignore */ }
      }
      process.stderr.write(`\n${chalk.dim("(disconnected)")}\n`);
      process.exit(0);
    }
    sendRemoteInput(peer, chunk.toString("base64"));
  });

  process.once("SIGINT", () => {
    // In raw mode, Ctrl-C arrives as 0x03 in the data handler (and is
    // forwarded to the remote PTY, which is what the user wants).
    // We get here only if the runtime delivers SIGINT another way.
    restoreTty();
    process.exit(0);
  });

  function restoreTty(): void {
    if (process.stdin.isTTY) {
      try {
        process.stdin.setRawMode(wasRaw); 
      } catch { /* ignore */ }
    }
    process.stdin.pause();
  }

  // Stay alive forever; the data handlers and onPeerDisconnected handle exit.
  await new Promise<never>(() => undefined);
}
