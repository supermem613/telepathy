// Cross-platform test runner — expands glob and passes files to node --test.
// Sandboxes HOME/USERPROFILE to a tmpdir so tests cannot read the developer's
// real ~/.telepathy/ state, mirroring CI exactly. Set TELEPATHY_TEST_REAL_HOME=1 to opt out.
//
// Avoids `node --test` worker subprocesses (their IPC pipe intermittently
// fails on Windows runners with deserialize errors). Uses node:test auto-start
// in a single process with a TAP reporter for the aggregate summary.
import { readdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { minimatch } from "minimatch";
import { execSync } from "node:child_process";

const pattern = process.argv[2] || "test/**/*.test.ts";
const baseDir = pattern.split(/[/\\]/)[0] || ".";
const allFiles = readdirSync(baseDir, { recursive: true })
  .map((f) => join(baseDir, f).split("\\").join("/"))
  .filter((f) => minimatch(f, pattern));

if (allFiles.length === 0) {
  console.error(`No test files found matching: ${pattern}`);
  process.exit(1);
}

// Integration tests opt out of the HOME sandbox: they spawn long-lived
// children (Electron, ConPTY-wrapped subprocesses) whose own user-data
// paths depend on the real USERPROFILE/HOME. With sandboxed HOME these
// children hang or crash trying to write to non-existent directories
// (Electron in particular hits a deadlock waiting on its userData dir
// to materialize relative to the sandboxed USERPROFILE). We make the
// decision per file so `npm test` (which runs both unit and integration)
// works correctly: each file's env is built individually based on whether
// its path includes "integration".
const sharedSandboxHome = process.env.TELEPATHY_TEST_REAL_HOME
  ? null
  : mkdtempSync(join(tmpdir(), "telepathy-test-home-"));

function envForFile(filePath) {
  const env = { ...process.env };
  if (sharedSandboxHome && !filePath.includes("integration")) {
    env.HOME = sharedSandboxHome;
    env.USERPROFILE = sharedSandboxHome;
    env.LOCALAPPDATA = join(sharedSandboxHome, "AppData", "Local");
  }
  return env;
}

let exitCode = 0;
let totalTests = 0;
let totalPass = 0;
let totalFail = 0;
const failedFiles = [];
try {
  for (const file of allFiles) {
    const cmd = `node --import tsx --test-reporter=tap ${file}`;
    let stdout = "";
    let fileFailed = false;
    try {
      stdout = execSync(cmd, { env: envForFile(file), encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
    } catch (err) {
      fileFailed = true;
      stdout = (err.stdout ?? "").toString();
      failedFiles.push(file);
    }
    process.stdout.write(stdout);
    const tests = parseInt((stdout.match(/^# tests (\d+)/m) ?? [])[1] ?? "0", 10);
    const pass  = parseInt((stdout.match(/^# pass (\d+)/m)  ?? [])[1] ?? "0", 10);
    const fail  = parseInt((stdout.match(/^# fail (\d+)/m)  ?? [])[1] ?? "0", 10);
    totalTests += tests;
    totalPass += pass;
    totalFail += fail;
    if (fileFailed && fail === 0) {
      totalFail += 1;
    }
  }
  console.log(`\n# AGGREGATE: tests ${totalTests} | pass ${totalPass} | fail ${totalFail}`);
  if (failedFiles.length) {
    console.log(`# Failed files:\n${failedFiles.map((f) => `#   ${f}`).join("\n")}`);
    exitCode = 1;
  }
} finally {
  if (sharedSandboxHome) {
    rmSync(sharedSandboxHome, { recursive: true, force: true });
  }
}
process.exit(exitCode);
