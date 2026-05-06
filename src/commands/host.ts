// `telepathy host` — wrap any process under a ConPTY and bind a LAN
// listener so peers can attach. The wrapper is the parent of the
// spawned program; it owns the pseudo-terminal and tees frames to the
// user's terminal AND to peer subscribers via the orchestrator.

import { hostname } from "node:os";
import { spawn } from "node:child_process";
import { startWrapper } from "../core/pty-wrapper.js";
import { acceptStart, setLocalPty, type AcceptOptions } from "../core/api.js";
import { attachToWrapperIfPresent } from "./host-pty-shim.js";
import { buildPipePath } from "../core/ipc.js";
import chalk from "chalk";

export type HostOptions = AcceptOptions & {
  command?: string;       // override the spawned program
  args?: string[];        // args to pass to it
  noListen?: boolean;     // run wrapper but don't bind a peer listener
};

export async function runHost(opts: HostOptions): Promise<void> {
  const { command, args } = resolveCommand(opts);

  const pipePath = buildPipePath();
  const env: Record<string, string | undefined> = {
    ...process.env,
    TELEPATHY_SOCKET: pipePath,
    TELEPATHY_LOCAL_ALIAS: process.env.TELEPATHY_ALIAS ?? hostname().toLowerCase(),
  };

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

  // Connect the in-process API surface to the wrapper's IPC, so peer
  // subscribers fan-out from the same PTY the user is interacting with.
  const localPty = await attachToWrapperIfPresent(pipePath);
  setLocalPty(localPty);

  if (!opts.noListen) {
    try {
      const result = await acceptStart(opts);
      printBanner(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(chalk.yellow(`telepathy host: peer listener failed (${msg}). Continuing without LAN exposure.\n`));
    }
  }
}

function resolveCommand(opts: HostOptions): { command: string; args: string[] } {
  if (opts.command) {
    return { command: opts.command, args: opts.args ?? [] };
  }
  // Default to the user's shell.
  if (process.platform === "win32") {
    return { command: process.env.COMSPEC ?? "pwsh.exe", args: [] };
  }
  const sh = process.env.SHELL ?? "/bin/bash";
  return { command: sh, args: [] };
}

function printBanner(r: { token: string; addr: string; bindHost: string; expiresInSec: number }): void {
  // Banner goes to the user's stderr so it doesn't disturb the wrapped
  // program's stdout. The PTY child sees an unmodified terminal.
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

// Detached spawn helper used by `telepathy shell` if it wants to launch a
// brand-new wrapper window instead of taking over the current terminal.
// Currently unused; left for future use when we add the "open new wt tab"
// flow as an alternative to in-place wrap.
export function spawnDetached(command: string, args: string[]): void {
  spawn(command, args, { stdio: "ignore", detached: true }).unref();
}
