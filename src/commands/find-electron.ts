// Locate the local Electron binary. Shared by `app` and `connect`.

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

export function findElectron(): { bin: string; cwd: string } | null {
  // dist/commands/find-electron.js → ../../  (repo root)
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  // Skip the .bin/electron.cmd shim — spawning .cmd on Windows requires
  // shell:true (CVE-2024-27980 mitigation), which on top of detached:true
  // creates a visible cmd.exe console window. Use the platform-native
  // binary directly: it spawns clean, no console, no shell.
  const distExe = process.platform === "win32"
    ? join(root, "node_modules", "electron", "dist", "electron.exe")
    : join(root, "node_modules", "electron", "dist", "electron");
  if (existsSync(distExe)) {
    return { bin: distExe, cwd: root };
  }
  const shim = process.platform === "win32"
    ? join(root, "node_modules", ".bin", "electron.cmd")
    : join(root, "node_modules", ".bin", "electron");
  if (existsSync(shim)) {
    return { bin: shim, cwd: root };
  }
  return null;
}
