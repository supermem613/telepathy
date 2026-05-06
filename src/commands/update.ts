// `telepathy update` — pull, install, and rebuild the local clone in place.
// Mirrors the convention from rotunda's `update` command so a globally
// `npm link`-ed install can refresh itself with one verb.

import chalk from "chalk";
import { exec, execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

export async function runUpdate(): Promise<void> {
  // Resolve the telepathy repo root from this file's location
  // (dist/commands/update.js → repo root).
  const thisFile = fileURLToPath(import.meta.url);
  const repoRoot = dirname(dirname(dirname(thisFile)));

  console.log(chalk.dim(`  telepathy repo: ${repoRoot}\n`));

  if (!(await isGitRepoRoot(repoRoot))) {
    console.error(chalk.red("Error:") + " telepathy install directory is not a git repo root.");
    process.exit(1);
  }

  // 1. git pull
  console.log(chalk.bold("  ↓ Pulling latest..."));
  try {
    const { stdout, stderr } = await execFileAsync("git", ["pull", "--ff-only"], { cwd: repoRoot });
    const output = (stdout + stderr).trim();
    if (output.includes("Already up to date")) {
      console.log(chalk.dim("    Already up to date."));
    } else {
      console.log(chalk.green("    ✓ Pulled new changes."));
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(chalk.red("  ✗ git pull failed:") + ` ${msg}`);
    process.exit(1);
  }

  // 2. npm install
  console.log(chalk.bold("\n  ⬡ Installing dependencies..."));
  try {
    await execAsync("npm install --no-audit --no-fund", { cwd: repoRoot });
    console.log(chalk.green("    ✓ Dependencies installed."));
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(chalk.red("  ✗ npm install failed:") + ` ${msg}`);
    process.exit(1);
  }

  // 3. npm run build
  console.log(chalk.bold("\n  🔨 Building..."));
  try {
    await execAsync("npm run build", { cwd: repoRoot });
    console.log(chalk.green("    ✓ Build complete."));
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(chalk.red("  ✗ Build failed:") + ` ${msg}`);
    process.exit(1);
  }

  console.log(chalk.green("\n  ✓ telepathy updated successfully."));
}

async function isGitRepoRoot(dir: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], { cwd: dir });
    return normalizePath(stdout.trim()) === normalizePath(dir);
  } catch {
    return false;
  }
}

function normalizePath(p: string): string {
  let resolved = p;
  try {
    resolved = realpathSync.native(p);
  } catch {
    // Path may not exist or be inaccessible; fall back to the input.
  }
  resolved = resolved.replace(/\\/g, "/").replace(/\/+$/, "");
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}
