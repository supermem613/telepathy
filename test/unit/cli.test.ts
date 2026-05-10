import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI = join(ROOT, "dist", "cli.js");
const VERSION = (JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version: string }).version;

function run(args: string[]): { stdout: string; stderr: string; status: number } {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
  });
  return { stdout: r.stdout, stderr: r.stderr, status: r.status ?? -1 };
}

describe("cli: bare-run banner", () => {
  it("prints `telepathy v<version>` followed by help when no args are given", () => {
    const r = run([]);
    assert.equal(r.status, 0, `bare run should exit 0, got ${r.status}; stderr=${r.stderr}`);
    assert.match(r.stdout, new RegExp(`^telepathy v${VERSION.replace(/\./g, "\\.")}\\n`), `expected banner with v${VERSION}`);
    assert.match(r.stdout, /Usage: telepathy/, "expected commander help to follow the banner");
  });

  it("`--version` still prints the version on its own (commander default)", () => {
    const r = run(["--version"]);
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), VERSION);
  });

  it("`--help` does not include the bare-run banner (machine-parseable)", () => {
    const r = run(["--help"]);
    assert.equal(r.status, 0);
    assert.doesNotMatch(r.stdout, new RegExp(`^telepathy v${VERSION.replace(/\./g, "\\.")}`));
    assert.match(r.stdout, /Usage: telepathy/);
  });

  it("sub-commands do not print the bare-run banner", () => {
    const r = run(["doctor", "--json"]);
    // doctor exits 0/1 depending on environment; what matters here is that
    // the JSON body is not prefixed with the banner.
    assert.doesNotMatch(r.stdout, new RegExp(`^telepathy v${VERSION.replace(/\./g, "\\.")}`));
    assert.match(r.stdout, /^\[/, "doctor --json output should start with [");
  });

  it("doctor enforces the Node 24 runtime contract", () => {
    const r = run(["doctor", "--json"]);
    const checks = JSON.parse(r.stdout) as Array<{ name: string; ok: boolean; hint?: string }>;
    const nodeCheck = checks.find((check) => check.name === "node >= 24");
    assert.ok(nodeCheck, "doctor should report the Node 24 runtime requirement");
    assert.equal(nodeCheck.ok, true, nodeCheck.hint);
  });
});
