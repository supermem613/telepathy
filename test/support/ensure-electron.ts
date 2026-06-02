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

export function createElectronInstallScript(): string {
  return `
const fs = require("node:fs");
const path = require("node:path");
const timeoutMs = Number(process.argv[1]);
const electronDir = process.cwd();
const pathFile = path.join(electronDir, "path.txt");
let lastProgress = Date.now();

function platformExecutablePath() {
  switch (process.platform) {
    case "darwin":
      return "Electron.app/Contents/MacOS/Electron";
    case "freebsd":
    case "linux":
    case "openbsd":
      return "electron";
    case "win32":
      return "electron.exe";
    default:
      throw new Error(\`Electron builds are not available on platform: \${process.platform}\`);
  }
}

async function main() {
  const { downloadArtifact } = await import("@electron/get");
  const extractZip = (await import("extract-zip")).default;
  const { version } = JSON.parse(fs.readFileSync(path.join(electronDir, "package.json"), "utf8"));
  const checksums = JSON.parse(fs.readFileSync(path.join(electronDir, "checksums.json"), "utf8"));
  const zipPath = await downloadArtifact({
    version,
    artifactName: "electron",
    checksums,
    platform: process.platform,
    arch: process.arch,
    downloadOptions: {
      signal: AbortSignal.timeout(timeoutMs),
      getProgressCallback: async (progress) => {
        if (Date.now() - lastProgress >= 60_000) {
          const total = progress.total === null ? "unknown" : String(progress.total);
          console.error(\`Still downloading Electron: \${progress.transferred}/\${total} bytes\`);
          lastProgress = Date.now();
        }
      },
    },
  });
  fs.rmSync(path.join(electronDir, "dist"), { recursive: true, force: true });
  await extractZip(zipPath, { dir: path.join(electronDir, "dist") });
  const sourceTypes = path.join(electronDir, "dist", "electron.d.ts");
  if (fs.existsSync(sourceTypes)) {
    fs.renameSync(sourceTypes, path.join(electronDir, "electron.d.ts"));
  }
  fs.writeFileSync(pathFile, platformExecutablePath());
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
`;
}

export function installElectronWithWait(electronDir: string, timeoutMs = DEFAULT_ELECTRON_INSTALL_TIMEOUT_MS): void {
  const result = spawnSync(process.execPath, ["-e", createElectronInstallScript(), String(timeoutMs)], {
    cwd: electronDir,
    stdio: "pipe",
    encoding: "utf8",
  });
  if (result.status !== 0) {
    if (result.stderr) {
      process.stderr.write(result.stderr);
    }
    throw new Error(`Electron install failed with exit code ${result.status ?? "null"}`);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
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
