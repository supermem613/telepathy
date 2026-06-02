import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const DEFAULT_ELECTRON_INSTALL_TIMEOUT_MS = 600_000;

export function hasElectronBinary(electronDir: string): boolean {
  const pathFile = join(electronDir, "path.txt");
  if (!existsSync(pathFile)) {
    return false;
  }
  const executable = readFileSync(pathFile, "utf8").trim();
  if (!executable) {
    return false;
  }
  return existsSync(join(electronDir, "dist", executable));
}

export function installElectronWithWait(electronDir: string, timeoutMs = DEFAULT_ELECTRON_INSTALL_TIMEOUT_MS): void {
  const result = spawnSync(process.execPath, [join(electronDir, "install.js")], {
    cwd: electronDir,
    timeout: timeoutMs,
    stdio: "pipe",
    encoding: "utf8",
  });
  if (result.status !== 0) {
    if (result.stdout) {
      process.stdout.write(result.stdout);
    }
    if (result.stderr) {
      process.stderr.write(result.stderr);
    }
    throw new Error(`Electron install failed with exit code ${result.status ?? "null"}`);
  }
  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }
  if (!hasElectronBinary(electronDir)) {
    throw new Error("Electron install finished but no executable path was produced");
  }
}

export function ensureElectronBinary(projectRoot: string, timeoutMs = DEFAULT_ELECTRON_INSTALL_TIMEOUT_MS): void {
  const electronDir = join(projectRoot, "node_modules", "electron");
  if (hasElectronBinary(electronDir)) {
    return;
  }
  installElectronWithWait(electronDir, timeoutMs);
  if (!hasElectronBinary(electronDir)) {
    throw new Error("Electron install finished but no executable path was produced");
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  ensureElectronBinary(projectRoot);
}
