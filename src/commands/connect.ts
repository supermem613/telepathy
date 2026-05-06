// `telepathy connect <token>` — establish a peer link, then either open
// the browser viewer (default) or mirror the remote PTY in the current
// terminal (--term mode).

import { connectPeer } from "../core/api.js";
import { startViewer, getViewerUrl } from "../core/viewer.js";
import { spawn } from "node:child_process";
import chalk from "chalk";

export type ConnectCommandOptions = {
  token: string;
  alias?: string;
  term?: boolean;
};

export async function runConnect(opts: ConnectCommandOptions): Promise<void> {
  let result;
  try {
    result = await connectPeer({ token: opts.token, alias: opts.alias });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(chalk.red(`connect failed: ${msg}\n`));
    process.exit(1);
  }
  process.stderr.write(
    `${chalk.cyan("🔗 linked")} alias=${chalk.bold(result.alias)} (remote=${result.remoteAlias} at ${result.remoteAddr}, hasPty=${result.hasPty})\n`,
  );
  if (opts.term) {
    process.stderr.write(chalk.dim("--term mode is not implemented yet; opening browser viewer instead.\n"));
  }
  await startViewer();
  const url = getViewerUrl(`/peer/${encodeURIComponent(result.alias)}`);
  if (!url) {
    process.stderr.write(chalk.red("viewer failed to start.\n"));
    process.exit(1);
  }
  process.stderr.write(`${chalk.green("🖥  viewer:")} ${url}\n`);
  openInBrowser(url);
  // Stay alive so the peer link doesn't drop. Ctrl-C exits.
  await new Promise(() => undefined);
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
