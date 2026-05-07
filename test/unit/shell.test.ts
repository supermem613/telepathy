import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { detectParentShell } from "../../src/core/shell.js";

describe("detectParentShell", () => {
  it("returns a non-empty string", () => {
    const shell = detectParentShell();
    assert.ok(shell.length > 0, "shell should not be empty");
  });

  it("returns a known shell executable on Windows", { skip: process.platform !== "win32" }, () => {
    const shell = detectParentShell();
    // In CI/test the parent is likely node.exe (test runner), so fallback to
    // cmd.exe is correct. Either way, it must be a .exe on Windows.
    assert.ok(shell.endsWith(".exe"), `expected .exe suffix, got: ${shell}`);
  });

  it("returns SHELL or /bin/bash on POSIX", { skip: process.platform === "win32" }, () => {
    const shell = detectParentShell();
    const expected = process.env.SHELL ?? "/bin/bash";
    assert.equal(shell, expected);
  });
});
