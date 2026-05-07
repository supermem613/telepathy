import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI = join(ROOT, "dist", "cli.js");

function run(args: string[]): { stdout: string; stderr: string; status: number } {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
  });
  return { stdout: r.stdout, stderr: r.stderr, status: r.status ?? -1 };
}

describe("telepathy reconnect CLI", () => {
  it("is a no-token no-discovery command", () => {
    const r = run(["reconnect"]);
    assert.equal(r.status, 0, `expected exit 0; stderr=${r.stderr}`);
    assert.equal(r.stdout, "");
    assert.match(r.stderr, /original telepathy host terminal/);
    assert.doesNotMatch(r.stderr, /TLP1[A-Z2-7]+/);
  });

  it("help describes re-pairing from the host terminal", () => {
    const r = run(["reconnect", "--help"]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Re-pair a disconnected app/);
    assert.doesNotMatch(r.stdout, /<token>/);
    assert.doesNotMatch(r.stdout, /--json/);
  });
});
