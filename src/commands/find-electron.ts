// Locate the local Electron binary. Shared by `app` and `connect`.

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

/**
 * Find the Electron binary path under a given repo root without relying on
 * the electron package's `path.txt` (which may be absent if the binary
 * download was skipped or failed during `npm ci`).
 *
 * Tries the direct `dist/electron[.exe]` binary first — this is always the
 * real Electron process and works regardless of `path.txt`. Falls back to
 * the `.bin/electron[.cmd]` shim only when `path.txt` exists, because the
 * shim is a Node.js script that reads `path.txt` to locate the binary; using
 * it when `path.txt` is absent would trigger an unwanted download attempt.
 * Returns null when no usable binary can be found.
 */
export function findElectronBin(root: string): string | null {
  // Skip the .bin/electron.cmd shim — spawning .cmd on Windows requires
  // shell:true (CVE-2024-27980 mitigation), which on top of detached:true
  // creates a visible cmd.exe console window. Use the platform-native
  // binary directly: it spawns clean, no console, no shell.
  const distExe = process.platform === "win32"
    ? join(root, "node_modules", "electron", "dist", "electron.exe")
    : join(root, "node_modules", "electron", "dist", "electron");
  if (existsSync(distExe)) {
    return distExe;
  }
  // Fall back to the .bin shim only when path.txt is present — the shim
  // reads that file to locate the binary, so without it the shim would
  // trigger an electron binary download instead of running cleanly.
  const pathTxt = join(root, "node_modules", "electron", "path.txt");
  const shim = process.platform === "win32"
    ? join(root, "node_modules", ".bin", "electron.cmd")
    : join(root, "node_modules", ".bin", "electron");
  if (existsSync(pathTxt) && existsSync(shim)) {
    return shim;
  }
  return null;
}

export function findElectron(): { bin: string; cwd: string } | null {
  // dist/commands/find-electron.js → ../../  (repo root)
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const bin = findElectronBin(root);
  if (!bin) {
    return null;
  }
  return { bin, cwd: root };
}
