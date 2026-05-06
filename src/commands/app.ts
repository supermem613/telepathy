// `telepathy app [tokens...]` — open the Electron wall viewer.
//
// Electron is required. If the local install is missing, fail loudly with
// the exact command to fix it. We don't fall back to the system browser:
// the windowed app experience IS the product, and a bare-tab fallback
// gives a wildly different UX (no menu bar, no app icon, no app-mode
// chromeless window).

import { connectPeer } from "../core/api.js";
import { startViewer, getViewerUrl } from "../core/viewer.js";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
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
  const main = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "electron", "main.cjs");
  // Spawn electron.exe directly (no .cmd shim) so we can avoid shell:true
  // — which on Windows + detached creates a visible cmd.exe console window.
  // windowsHide:true belt-and-suspenders for the case where the shim
  // fallback is in use (existsSync miss on the dist/electron.exe path).
  spawn(electron.bin, [main, `--url=${url}`], {
    cwd: electron.cwd,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  }).unref();
  process.stderr.write(chalk.dim("   window: Electron\n"));
  process.stderr.write(chalk.dim("   Press Ctrl-C to stop the wall server.\n"));
  await new Promise<never>((_, reject) => {
    process.once("SIGINT", () => process.exit(0));
    process.once("uncaughtException", reject);
  });
}

export function findElectron(): { bin: string; cwd: string } | null {
  // dist/commands/app.js → ../../  (repo root, where node_modules lives)
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  // Skip the .bin/electron.cmd shim entirely — spawning .cmd on Windows
  // requires shell:true (CVE-2024-27980 mitigation), which on top of
  // detached:true creates a visible cmd.exe console window. Use the
  // platform-native binary directly: it spawns clean, no console, no shell.
  const distExe = process.platform === "win32"
    ? join(root, "node_modules", "electron", "dist", "electron.exe")
    : join(root, "node_modules", "electron", "dist", "electron");
  if (existsSync(distExe)) {
    return { bin: distExe, cwd: root };
  }
  // Fallback to the .bin shim if the dist binary is missing for some reason.
  const shim = process.platform === "win32"
    ? join(root, "node_modules", ".bin", "electron.cmd")
    : join(root, "node_modules", ".bin", "electron");
  if (existsSync(shim)) {
    return { bin: shim, cwd: root };
  }
  return null;
}
