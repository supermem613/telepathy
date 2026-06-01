// Unit tests for findElectronBin — verifies that the helper locates the
// Electron binary without relying on `node_modules/electron/path.txt`.
//
// Root cause context: `electron.launch()` in Playwright reads `path.txt`
// directly. When the electron binary download is skipped or fails during
// `npm ci`, `path.txt` is absent and tests crash with ENOENT. Using
// findElectronBin() instead lets tests (and the `app` / `connect` commands)
// locate the binary through direct filesystem checks that don't depend on
// `path.txt`.
//
// Shim fallback policy: the `.bin/electron[.cmd]` shim is a Node.js script
// that reads `path.txt` to locate the real binary. findElectronBin() only
// returns the shim when `path.txt` is also present; without it the shim
// would trigger an unwanted download attempt instead of running cleanly.

import { describe, it, before, after } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { findElectronBin } from "../../src/commands/find-electron.js";

// Name of the platform-native electron binary.
const BIN_NAME = process.platform === "win32" ? "electron.exe" : "electron";
const SHIM_NAME = process.platform === "win32" ? "electron.cmd" : "electron";

// Helper: create a fake executable file (not truly runnable, just present).
function touch(p: string): void {
  writeFileSync(p, "");
  if (process.platform !== "win32") {
    chmodSync(p, 0o755);
  }
}

describe("findElectronBin", () => {
  let tmpRoot: string;

  before(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "find-electron-test-"));
  });

  after(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("returns null when neither dist binary nor .bin shim exists", () => {
    const root = join(tmpRoot, "empty");
    mkdirSync(root, { recursive: true });
    const result = findElectronBin(root);
    // Verifies the pre-fix failure mode: without path.txt and without any
    // binary on disk, the function must return null rather than throwing.
    assert.equal(result, null);
  });

  it("returns the dist binary path when node_modules/electron/dist/<bin> exists", () => {
    const root = join(tmpRoot, "with-dist");
    const distDir = join(root, "node_modules", "electron", "dist");
    mkdirSync(distDir, { recursive: true });
    const binPath = join(distDir, BIN_NAME);
    touch(binPath);

    const result = findElectronBin(root);
    assert.equal(result, binPath, "should prefer the dist binary over the .bin shim");
  });

  it("falls back to .bin shim when dist binary is absent but path.txt is present", () => {
    const root = join(tmpRoot, "with-shim");
    const binDir = join(root, "node_modules", ".bin");
    const electronDir = join(root, "node_modules", "electron");
    mkdirSync(binDir, { recursive: true });
    mkdirSync(electronDir, { recursive: true });
    const shimPath = join(binDir, SHIM_NAME);
    touch(shimPath);
    // path.txt must be present; the shim reads it to locate the real binary.
    writeFileSync(join(electronDir, "path.txt"), `dist/${BIN_NAME}`);

    const result = findElectronBin(root);
    assert.equal(result, shimPath, "should fall back to .bin shim when path.txt exists");
  });

  it("returns null when dist binary is absent and path.txt is missing (prevents bad download)", () => {
    const root = join(tmpRoot, "shim-no-path-txt");
    const binDir = join(root, "node_modules", ".bin");
    mkdirSync(binDir, { recursive: true });
    // Shim is present but path.txt is absent — this is the CI failure scenario.
    // Without path.txt the shim would trigger an unwanted electron download.
    // findElectronBin must return null so integration tests skip gracefully.
    touch(join(binDir, SHIM_NAME));

    const result = findElectronBin(root);
    assert.equal(result, null, "must return null when path.txt is absent (shim unusable)");
  });

  it("prefers dist binary over .bin shim when both exist", () => {
    const root = join(tmpRoot, "both");
    const distDir = join(root, "node_modules", "electron", "dist");
    const electronDir = join(root, "node_modules", "electron");
    const binDir = join(root, "node_modules", ".bin");
    mkdirSync(distDir, { recursive: true });
    mkdirSync(binDir, { recursive: true });
    const binPath = join(distDir, BIN_NAME);
    const shimPath = join(binDir, SHIM_NAME);
    touch(binPath);
    touch(shimPath);
    writeFileSync(join(electronDir, "path.txt"), `dist/${BIN_NAME}`);

    const result = findElectronBin(root);
    assert.equal(result, binPath, "dist binary should take precedence over .bin shim");
  });

  it("does not read or require path.txt", () => {
    // This test explicitly verifies that findElectronBin never touches
    // node_modules/electron/path.txt — the file whose absence caused the CI
    // failure when the electron binary download was skipped.
    const root = join(tmpRoot, "no-path-txt");
    const distDir = join(root, "node_modules", "electron", "dist");
    mkdirSync(distDir, { recursive: true });
    touch(join(distDir, BIN_NAME));
    // Deliberately do NOT create path.txt — findElectronBin must still work.
    // (No path.txt = the failure mode that broke CI)

    const result = findElectronBin(root);
    assert.notEqual(result, null, "must find binary even without path.txt");
  });
});
