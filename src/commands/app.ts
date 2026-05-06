// `telepathy app [tokens...]` — open the Electron wall viewer.
//
// The Electron process now owns the wall HTTP+WS server, so this
// command is fire-and-forget: spawn Electron detached, return to the
// prompt immediately. Closing the Electron window stops the server.

import { findElectron } from "./find-electron.js";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import chalk from "chalk";

export type AppOptions = {
  tokens: string[];
};

export async function runApp(opts: AppOptions): Promise<void> {
  const electron = findElectron();
  if (!electron) {
    process.stderr.write(chalk.red("telepathy app: Electron isn't installed. Run `npm install` in the repo root.\n"));
    process.exit(2);
  }
  const main = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "electron", "main.cjs");
  if (!existsSync(main)) {
    process.stderr.write(chalk.red(`telepathy app: missing electron/main.cjs at ${main}\n`));
    process.exit(2);
  }
  const tokenArgs = opts.tokens.map((t) => `--token=${t}`);
  // Detached + stdio:"ignore" + windowsHide:true means: spawn the
  // Electron process as fully independent from this CLI. The CLI exits
  // immediately; the window's lifecycle is owned by Electron.
  const child = spawn(electron.bin, [main, ...tokenArgs], {
    cwd: electron.cwd,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
  process.stderr.write(`${chalk.green("✓")} Electron window opening (close it to stop the server).\n`);
  // Done. CLI returns to prompt.
}
