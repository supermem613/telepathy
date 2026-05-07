import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { buildWindowsStartArgs } from "../../src/core/launcher.js";

describe("launcher", () => {
  it("opens spawned host terminal maximized on Windows", () => {
    const args = buildWindowsStartArgs("C:\\telepathy\\dist\\cli.js", "\\\\.\\pipe\\telepathy-test");

    assert.deepEqual(args, [
      "/c",
      "start",
      "telepathy host",
      "/MAX",
      "node",
      "C:\\telepathy\\dist\\cli.js",
      "host",
      "--token-handoff-pipe",
      "\\\\.\\pipe\\telepathy-test",
    ]);
  });

  it("passes detected shell to child host via -- separator", () => {
    const args = buildWindowsStartArgs(
      "C:\\telepathy\\dist\\cli.js",
      "\\\\.\\pipe\\telepathy-test",
      "pwsh.exe",
    );

    assert.deepEqual(args, [
      "/c",
      "start",
      "telepathy host",
      "/MAX",
      "node",
      "C:\\telepathy\\dist\\cli.js",
      "host",
      "--token-handoff-pipe",
      "\\\\.\\pipe\\telepathy-test",
      "--",
      "pwsh.exe",
    ]);
  });

  it("handles shell path with spaces", () => {
    const args = buildWindowsStartArgs(
      "C:\\telepathy\\dist\\cli.js",
      "\\\\.\\pipe\\telepathy-test",
      "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
    );

    // The shell path is a single array element — Node's spawn handles quoting
    assert.equal(args[args.length - 1], "C:\\Program Files\\PowerShell\\7\\pwsh.exe");
    assert.equal(args[args.length - 2], "--");
  });
});
