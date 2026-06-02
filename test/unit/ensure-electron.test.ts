import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  createElectronInstallScript,
  DEFAULT_ELECTRON_INSTALL_TIMEOUT_MS,
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

  it("installs through the downloader directly instead of waiting on install.js side effects", () => {
    const script = createElectronInstallScript();
    assert.match(script, /downloadArtifact/);
    assert.match(script, /AbortSignal\.timeout\(timeoutMs\)/);
    assert.match(script, /extractZip/);
    assert.doesNotMatch(script, /install\.js/);
  });

  it("fails fast when Electron package metadata is missing", () => {
    const electronDir = makeFakeElectronDir("");
    const originalWrite = process.stderr.write.bind(process.stderr);
    let stderr = "";
    try {
      process.stderr.write = ((chunk: string | Uint8Array) => {
        stderr += chunk.toString();
        return true;
      }) as typeof process.stderr.write;
      assert.throws(() => installElectronWithWait(electronDir, 250), /Electron install failed/);
      assert.match(stderr, /Cannot find package '@electron\/get'/);
    } finally {
      process.stderr.write = originalWrite;
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
