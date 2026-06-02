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
  const installScript = `
const fs = require("node:fs");
const path = require("node:path");
const timeoutMs = Number(process.argv[1]);
const start = Date.now();
let lastProgress = start;
const pathFile = path.join(process.cwd(), "path.txt");
require(path.join(process.cwd(), "install.js"));
const poll = () => {
  try {
    const rel = fs.readFileSync(pathFile, "utf8").trim();
    if (rel && fs.existsSync(path.join(process.cwd(), "dist", rel))) {
      process.exit(0);
    }
  } catch (err) {
    if (err.code !== "ENOENT") {
      throw err;
    }
  }
  if (Date.now() - lastProgress >= 60_000) {
    console.error("Still waiting for Electron install to produce path.txt");
    lastProgress = Date.now();
  }
  if (Date.now() - start >= timeoutMs) {
    console.error("Timed out waiting for Electron install to produce path.txt");
    process.exit(1);
  }
  setTimeout(poll, 50);
};
poll();
`;
  const result = spawnSync(process.execPath, ["-e", installScript, String(timeoutMs)], {
    cwd: electronDir,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error(`Electron install failed with exit code ${result.status ?? "null"}`);
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
