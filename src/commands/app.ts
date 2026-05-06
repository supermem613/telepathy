// `telepathy app [<token>...]` — opens the multi-peer wall viewer in a
// browser window. Optional tokens passed on the command line are
// connected up-front so they show up immediately in the wall.

import { connectPeer } from "../core/api.js";
import { startViewer, getViewerUrl } from "../core/viewer.js";
import { spawn } from "node:child_process";
import chalk from "chalk";

export type AppOptions = {
  tokens: string[];
  windowed?: boolean; // open with `chrome --app=URL` for a chromeless window
};

export async function runApp(opts: AppOptions): Promise<void> {
  for (const token of opts.tokens) {
    try {
      const r = await connectPeer({ token });
      process.stderr.write(`${chalk.cyan("🔗")} linked ${chalk.bold(r.alias)} (${r.remoteAddr})\n`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(chalk.yellow(`skip token (${msg})\n`));
    }
  }
  await startViewer();
  const url = getViewerUrl("/wall");
  if (!url) {
    process.stderr.write(chalk.red("viewer failed to start.\n"));
    process.exit(1);
  }
  process.stderr.write(`${chalk.green("🛰  wall:")} ${url}\n`);
  openInBrowser(url, opts.windowed ?? true);
  await new Promise(() => undefined);
}

function openInBrowser(url: string, windowed: boolean): void {
  if (windowed && process.platform === "win32") {
    // Try to launch Chrome/Edge as an "app" window (no tab bar / address bar).
    const chrome = findChromeOnWindows();
    if (chrome) {
      spawn(chrome, [`--app=${url}`], { detached: true, stdio: "ignore" }).unref();
      return;
    }
  }
  // Fallback: hand off to the OS default browser.
  if (process.platform === "win32") {
    spawn("cmd.exe", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
  } else if (process.platform === "darwin") {
    spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
  } else {
    spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
  }
}

function findChromeOnWindows(): string | null {
  const candidates = [
    `${process.env["ProgramFiles"] ?? ""}\\Google\\Chrome\\Application\\chrome.exe`,
    `${process.env["ProgramFiles(x86)"] ?? ""}\\Google\\Chrome\\Application\\chrome.exe`,
    `${process.env["LocalAppData"] ?? ""}\\Google\\Chrome\\Application\\chrome.exe`,
    `${process.env["ProgramFiles"] ?? ""}\\Microsoft\\Edge\\Application\\msedge.exe`,
    `${process.env["ProgramFiles(x86)"] ?? ""}\\Microsoft\\Edge\\Application\\msedge.exe`,
  ];
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- async import not worth the refactor cost here
  const fs = require("node:fs") as typeof import("node:fs");
  for (const p of candidates) {
    if (p && fs.existsSync(p)) {
      return p;
    }
  }
  return null;
}
