import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
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

function readPathFile(electronDir: string): string | undefined {
  const pathFile = join(electronDir, "path.txt");
  if (!existsSync(pathFile)) {
    return undefined;
  }
  return readFileSync(pathFile, "utf8").trim();
}

function listDirectory(path: string): string {
  if (!existsSync(path)) {
    return "<missing>";
  }
  const entries = readdirSync(path, { withFileTypes: true })
    .slice(0, 25)
    .map((entry) => `${entry.name}${entry.isDirectory() ? "/" : ""}`);
  return entries.length > 0 ? entries.join(", ") : "<empty>";
}

function describeInstallResult(result: SpawnSyncReturns<string>): string {
  return [
    `status: ${result.status ?? "null"}`,
    `signal: ${result.signal ?? "null"}`,
    `error: ${result.error?.message ?? "none"}`,
    `stdout: ${result.stdout.trim() || "<empty>"}`,
    `stderr: ${result.stderr.trim() || "<empty>"}`,
  ].join("\n");
}

export function describeElectronInstallState(electronDir: string, result?: SpawnSyncReturns<string>): string {
  const pathContent = readPathFile(electronDir);
  const expectedExecutable = pathContent ? join(electronDir, "dist", pathContent) : undefined;
  const lines = [
    `electron dir: ${electronDir} ${existsSync(electronDir) ? "exists" : "missing"}`,
    `path.txt: ${pathContent === undefined ? "missing" : JSON.stringify(pathContent)}`,
    `expected executable: ${expectedExecutable ?? "unknown"} ${
      expectedExecutable === undefined ? "unknown" : existsSync(expectedExecutable) ? "exists" : "missing"
    }`,
    `electron dir entries: ${listDirectory(electronDir)}`,
    `dist entries: ${listDirectory(join(electronDir, "dist"))}`,
  ];
  if (result) {
    lines.push("installer result:", describeInstallResult(result));
  }
  return lines.join("\n");
}

function throwInstallError(message: string, electronDir: string, result?: SpawnSyncReturns<string>): never {
  throw new Error(`${message}\n${describeElectronInstallState(electronDir, result)}`);
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
      process.stderr.write(result.stdout);
    }
    if (result.stderr) {
      process.stderr.write(result.stderr);
    }
    throwInstallError(`Electron install failed with exit code ${result.status ?? "null"}`, electronDir, result);
  }
  if (result.stdout) {
    process.stderr.write(result.stdout);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }
  if (!hasElectronBinary(electronDir)) {
    throwInstallError("Electron install finished but no executable path was produced", electronDir, result);
  }
}

export function ensureElectronBinary(projectRoot: string, timeoutMs = DEFAULT_ELECTRON_INSTALL_TIMEOUT_MS): void {
  const electronDir = join(projectRoot, "node_modules", "electron");
  if (hasElectronBinary(electronDir)) {
    return;
  }
  installElectronWithWait(electronDir, timeoutMs);
  if (!hasElectronBinary(electronDir)) {
    throwInstallError("Electron install finished but no executable path was produced", electronDir);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  ensureElectronBinary(projectRoot);
}
