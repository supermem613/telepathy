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
});
