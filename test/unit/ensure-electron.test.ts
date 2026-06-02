import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { DEFAULT_ELECTRON_INSTALL_TIMEOUT_MS, installElectronWithWait } from "../support/ensure-electron.js";

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
      assert.equal(existsSync(join(electronDir, "path.txt")), false);
    } finally {
      rmSync(electronDir, { recursive: true, force: true });
    }
  });

  it("fails fast when install.js never produces the executable path", () => {
    const electronDir = makeFakeElectronDir("");
    try {
      assert.throws(() => installElectronWithWait(electronDir, 250), /Electron install failed/);
    } finally {
      rmSync(electronDir, { recursive: true, force: true });
    }
  });

  it("waits for install.js side effects and produces path.txt", () => {
    const electronDir = makeFakeElectronDir(`
const fs = require("node:fs");
const path = require("node:path");
setTimeout(() => {
  fs.writeFileSync(path.join(process.cwd(), "dist", "electron"), "");
  fs.writeFileSync(path.join(process.cwd(), "path.txt"), "electron");
}, 25);
`);
    try {
      installElectronWithWait(electronDir, 1_000);
      assert.equal(existsSync(join(electronDir, "path.txt")), true);
      assert.equal(existsSync(join(electronDir, "dist", "electron")), true);
    } finally {
      rmSync(electronDir, { recursive: true, force: true });
    }
  });
});
