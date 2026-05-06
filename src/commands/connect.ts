// `telepathy connect <token>` — establish a peer link. Default opens the
// browser viewer for the remote PTY; `--term` mirrors the remote PTY
// directly in the current terminal (delegated to ./term.ts).

import { connectPeer } from "../core/api.js";
import { startViewer, getViewerUrl } from "../core/viewer.js";
import { addOrchestratorEvents } from "../core/orchestrator.js";
import { runTermMode } from "./term.js";
import { findElectron } from "./app.js";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import chalk from "chalk";

export type ConnectCommandOptions = {
  token: string;
  alias?: string;
  term?: boolean;
};

export async function runConnect(opts: ConnectCommandOptions): Promise<void> {
  if (opts.term) {
    await runTermMode({ token: opts.token, alias: opts.alias });
    return;
  }
  const electron = findElectron();
  if (!electron) {
    process.stderr.write(chalk.red("telepathy connect: Electron isn't installed; the windowed viewer can't open.\n"));
    process.stderr.write(chalk.dim("   Either run `npm install` in the repo root, or use --term to mirror in this terminal instead.\n"));
    process.exit(2);
  }
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
  await startViewer();
  const url = getViewerUrl(`/peer/${encodeURIComponent(result.alias)}`);
  if (!url) {
    process.stderr.write(chalk.red("viewer failed to start.\n"));
    process.exit(1);
  }
  process.stderr.write(`${chalk.green("🖥  viewer:")} ${url}\n`);
  process.stderr.write(chalk.dim("   Press Ctrl-C to disconnect.\n"));
  const main = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "electron", "main.cjs");
  // shell:true is REQUIRED on Windows: electron.cmd is a Windows batch
  // shim, and Node ≥20.12 refuses to spawn .cmd/.bat directly without
  // shell:true (CVE-2024-27980 mitigation, throws EINVAL).
  spawn(electron.bin, [main, `--url=${url}`], {
    cwd: electron.cwd,
    detached: true,
    stdio: "ignore",
    shell: process.platform === "win32",
  }).unref();
  addOrchestratorEvents({
    onPeerDisconnected: (peer, reason) => {
      process.stderr.write(`\n${chalk.dim(`(remote ${peer.alias} disconnected${reason ? `: ${reason}` : ""})`)}\n`);
      process.exit(0);
    },
  });
  await new Promise<never>((_, reject) => {
    process.once("SIGINT", () => {
      process.stderr.write(chalk.dim("\n(disconnected)\n"));
      process.exit(0);
    });
    process.once("uncaughtException", reject);
  });
}
