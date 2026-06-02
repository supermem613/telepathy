import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  DEFAULT_ELECTRON_INSTALL_TIMEOUT_MS,
  describeElectronInstallState,
  hasElectronBinary,
  installElectronWithWait,
} from "../support/ensure-electron.js";

function makeFakeElectronDir(installJs: string): string {
  const root = mkdtempSync(join(tmpdir(), "telepathy-electron-fake-"));
  mkdirSync(join(root, "dist"), { recursive: true });
  writeFileSync(join(root, "install.js"), installJs);
  return root;
}

describe("ensure-electron installer guard", () => {
  it("pins the Electron installer ZIP reader to a Node 24-compatible version", () => {
    const packageJson = readFileSync("package.json", "utf8");
    const packageLock = readFileSync("package-lock.json", "utf8");
    assert.match(packageJson, /"overrides":\s*\{[\s\S]*"yauzl": "3\.3\.2"/);
    assert.match(packageLock, /"node_modules\/yauzl":\s*\{[\s\S]*"version": "3\.3\.2"/);
  });

  it("allows slow cold Electron downloads on fresh Linux CI runners", () => {
    assert.ok(
      DEFAULT_ELECTRON_INSTALL_TIMEOUT_MS >= 600_000,
      "Electron preflight must allow a cold CI download to exceed the old 3 minute failure window",
    );
  });

  it("documents the failure mode: install.js can exit 0 without path.txt", () => {
    const electronDir = makeFakeElectronDir("");
    try {
      const result = spawnSync(process.execPath, [join(electronDir, "install.js")], { cwd: electronDir });
      assert.equal(result.status, 0);
      assert.equal(hasElectronBinary(electronDir), false);
    } finally {
      rmSync(electronDir, { recursive: true, force: true });
    }
  });

  it("runs Electron install.js as a standalone process instead of requiring it in-process", () => {
    assert.match(installElectronWithWait.toString(), /install\.js/);
    assert.match(installElectronWithWait.toString(), /timeout:\s*timeoutMs/);
    assert.match(installElectronWithWait.toString(), /throwInstallError/);
    assert.doesNotMatch(installElectronWithWait.toString(), /--input-type=module/);
    assert.doesNotMatch(installElectronWithWait.toString(), /require\('electron'\)/);
    assert.doesNotMatch(installElectronWithWait.toString(), /downloadArtifact/);
    assert.doesNotMatch(installElectronWithWait.toString(), /extractZip/);
    assert.doesNotMatch(installElectronWithWait.toString(), /require\(path\.join\(process\.cwd\(\), "install\.js"\)\)/);
  });

  it("reports installer output when install.js exits non-zero", () => {
    const electronDir = makeFakeElectronDir(`
console.log("install stdout");
console.error("install stderr");
process.exit(7);
`);
    const originalWrite = process.stderr.write.bind(process.stderr);
    let stderr = "";
    try {
      process.stderr.write = ((chunk: string | Uint8Array) => {
        stderr += chunk.toString();
        return true;
      }) as typeof process.stderr.write;
      assert.throws(
        () => installElectronWithWait(electronDir, 250),
        /Electron install failed with exit code 7[\s\S]*stdout: install stdout[\s\S]*stderr: install stderr/,
      );
      assert.match(stderr, /install stdout/);
      assert.match(stderr, /install stderr/);
    } finally {
      process.stderr.write = originalWrite;
      rmSync(electronDir, { recursive: true, force: true });
    }
  });

  it("reports missing path.txt after a successful installer exit", () => {
    const electronDir = makeFakeElectronDir('console.log("installer said done");');
    const originalWrite = process.stderr.write.bind(process.stderr);
    try {
      process.stderr.write = (() => true) as typeof process.stderr.write;
      assert.throws(
        () => installElectronWithWait(electronDir, 250),
        /Electron install finished but no executable path was produced[\s\S]*path\.txt: missing[\s\S]*stdout: installer said done/,
      );
    } finally {
      process.stderr.write = originalWrite;
      rmSync(electronDir, { recursive: true, force: true });
    }
  });

  it("reports the expected binary path when path.txt exists without the executable", () => {
    const electronDir = makeFakeElectronDir("");
    const executable = process.platform === "win32" ? "electron.exe" : "electron";
    try {
      writeFileSync(join(electronDir, "path.txt"), executable);
      assert.match(describeElectronInstallState(electronDir), new RegExp(`expected executable: .*${executable} missing`));
    } finally {
      rmSync(electronDir, { recursive: true, force: true });
    }
  });

  it("detects a completed Electron install from path.txt and dist", () => {
    const electronDir = makeFakeElectronDir("");
    try {
      writeFileSync(join(electronDir, "dist", process.platform === "win32" ? "electron.exe" : "electron"), "");
      writeFileSync(join(electronDir, "path.txt"), process.platform === "win32" ? "electron.exe" : "electron");
      assert.equal(hasElectronBinary(electronDir), true);
    } finally {
      rmSync(electronDir, { recursive: true, force: true });
    }
  });
});
