// `telepathy doctor` — preflight: node version, node-pty native build,
// default port reachability. Mirrors the convention from rotunda/kash.

import chalk from "chalk";
import { createServer } from "node:net";
import { DEFAULT_PORT } from "../core/protocol.js";
import { findElectron } from "./find-electron.js";

export type CheckResult = {
  name: string;
  ok: boolean;
  detail: string;
  hint?: string;
  optional?: boolean;     // failures on optional checks don't fail exit code
};

export type DoctorOptions = {
  json?: boolean;
};

export async function runDoctor(opts: DoctorOptions = {}): Promise<void> {
  const checks: CheckResult[] = [];
  const v = process.versions.node;
  const major = parseInt(v.split(".")[0]!, 10);
  checks.push({
    name: "node >= 20",
    ok: major >= 20,
    detail: `node ${v}`,
    hint: major < 20 ? "install Node.js 20 or newer (https://nodejs.org)" : undefined,
  });

  let ptyOk = false;
  let ptyDetail: string;
  try {
    await import("node-pty");
    ptyOk = true;
    ptyDetail = "loaded";
  } catch (err) {
    ptyDetail = err instanceof Error ? err.message : String(err);
  }
  checks.push({
    name: "node-pty native module",
    ok: ptyOk,
    detail: ptyDetail,
    hint: ptyOk ? undefined : "install C++ build tools and re-run `npm install`. On Windows, install Visual Studio Build Tools 2022.",
  });

  const portFree = await isPortFree(DEFAULT_PORT);
  checks.push({
    name: `port ${DEFAULT_PORT} free`,
    ok: portFree,
    detail: portFree ? "available" : "in use",
    hint: portFree ? undefined : "another telepathy host or process is bound — pass `--port <n>` to pick a different port.",
  });

  const electron = findElectron();
  checks.push({
    name: "Electron installed",
    ok: !!electron,
    detail: electron ? `found at ${electron.bin}` : "not installed",
    hint: electron ? undefined : "Run: npm install   (electron is a regular dep; ~80MB download)",
  });

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(checks, null, 2)}\n`);
    process.exit(checks.every((c) => c.ok || c.optional) ? 0 : 1);
  }

  let allRequiredOk = true;
  for (const c of checks) {
    const mark = c.ok ? chalk.green("✓") : c.optional ? chalk.yellow("○") : chalk.red("✗");
    process.stdout.write(`${mark} ${c.name} — ${c.detail}\n`);
    if (!c.ok) {
      if (!c.optional) {
        allRequiredOk = false;
      }
      if (c.hint) {
        process.stdout.write(`  ${chalk.dim("hint:")} ${c.hint}\n`);
      }
    }
  }
  process.exit(allRequiredOk ? 0 : 1);
}

function isPortFree(port: number): Promise<boolean> {
  return new Promise((res) => {
    const probe = createServer();
    probe.once("error", () => res(false));
    probe.once("listening", () => probe.close(() => res(true)));
    probe.listen(port, "127.0.0.1");
  });
}
