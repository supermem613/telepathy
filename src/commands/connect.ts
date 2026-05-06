// `telepathy connect <token>` — establish a peer link. Default opens the
// browser viewer for the remote PTY; `--term` mirrors the remote PTY
// directly in the current terminal (delegated to ./term.ts).

import { connectPeer } from "../core/api.js";
import { startViewer, getViewerUrl } from "../core/viewer.js";
import { addOrchestratorEvents } from "../core/orchestrator.js";
import { runTermMode } from "./term.js";
import { spawn } from "node:child_process";
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
  openInBrowser(url);
  // Exit cleanly when the host disconnects (e.g. they typed `exit` in
  // the wrapped shell) — otherwise the user is stuck staring at a dead
  // browser viewer with no obvious way out.
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

function openInBrowser(url: string): void {
  if (process.platform === "win32") {
    spawn("cmd.exe", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
  } else if (process.platform === "darwin") {
    spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
  } else {
    spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
  }
}
