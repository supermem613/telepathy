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

// When the shell (sh/bash) expands a glob before passing to node, every
// matched file arrives as a separate argv entry and process.argv[2] is the
// first file path, not the original glob pattern. Detect this: if all extra
// arguments contain no wildcard characters they are already-expanded file
// paths and should be used verbatim. A single argument that contains a '*'
// (or '?') is treated as a glob pattern and expanded with minimatch.
const args = process.argv.slice(2);
const defaultPattern = "test/**/*.test.ts";

let allFiles;
if (args.length === 0) {
  // No args: expand the default pattern.
  const baseDir = defaultPattern.split(/[/\\]/)[0] || ".";
  allFiles = readdirSync(baseDir, { recursive: true })
    .map((f) => join(baseDir, f).split("\\").join("/"))
    .filter((f) => minimatch(f, defaultPattern));
} else if (args.length === 1 && (args[0].includes("*") || args[0].includes("?"))) {
  // Single glob pattern (shell did not expand it, e.g. quoted or Windows):
  // expand it via minimatch.
  const pattern = args[0];
  const baseDir = pattern.split(/[/\\]/)[0] || ".";
  allFiles = readdirSync(baseDir, { recursive: true })
    .map((f) => join(baseDir, f).split("\\").join("/"))
    .filter((f) => minimatch(f, pattern));
} else {
  // Shell already expanded the glob: every arg is a concrete file path.
  allFiles = args.map((f) => f.split("\\").join("/"));
}

if (allFiles.length === 0) {
  const label = args.length === 1 ? args[0] : `${args.length} file(s)`;
  console.error(`No test files found matching: ${label}`);
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
    const tests = parseInt((stdout.match(/^# tests (\d+)/m) ?? [])[1] ?? "0", 10);
    const pass  = parseInt((stdout.match(/^# pass (\d+)/m)  ?? [])[1] ?? "0", 10);
    const fail  = parseInt((stdout.match(/^# fail (\d+)/m)  ?? [])[1] ?? "0", 10);
    if (fileFailed || fail > 0) {
      process.stdout.write(stdout);
      if (!failedFiles.includes(file)) {
        failedFiles.push(file);
      }
    } else {
      console.log(`# ok ${file} (${pass}/${tests} tests)`);
    }
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
