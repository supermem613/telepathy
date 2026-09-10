// `telepathy update` — pull, install, and rebuild the local clone in place.
// Mirrors the convention from rotunda's `update` command so a globally
// `npm link`-ed install can refresh itself with one verb.
//
// Prefer sd when the clone is soda-managed. Detection uses sd status when
// available, plus local .sd workspace markers so a missing sd binary cannot be
// mistaken for a plain checkout. If a non-soda probe still hits soda interlock
// hooks on pull, retry once with sd pull instead of failing on the blocked write.

import chalk from "chalk";
import { execFile } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

type ExecResult = {
  stdout: string;
  stderr: string;
};

type SodaEnvelope<TData> = {
  ok?: boolean;
  data?: TData;
  error?: string;
};

type SodaPullOutcome = {
  status?: string;
  worktreeUpdated?: boolean;
  worktree?: boolean;
};

export type UpdateDeps = {
  repoRoot?: string;
  execCommand?: (command: string, args: string[], cwd: string) => Promise<ExecResult>;
  hasSodaWorkspace?: (dir: string) => boolean;
  isGitRepo?: (dir: string) => Promise<boolean>;
};

export type UpdateResult = {
  repoRoot: string;
  pulled: boolean;
  alreadyUpToDate: boolean;
  installed: boolean;
  built: boolean;
};

async function defaultExecCommand(command: string, args: string[], cwd: string): Promise<ExecResult> {
  const invocation = process.platform === "win32" && (command === "npm" || command === "sd")
    ? { command: "cmd.exe", args: ["/d", "/s", "/c", command, ...args] }
    : { command, args };
  const result = await execFileAsync(invocation.command, invocation.args, { cwd });
  return { stdout: String(result.stdout), stderr: String(result.stderr) };
}

export function gitPullMadeNoChanges(output: string): boolean {
  return /already up[- ]to[- ]date\.?/i.test(output);
}

export function hasSodaWorkspaceMarkers(dir: string): boolean {
  const workspaceDir = join(dir, ".sd");
  const metaPath = join(workspaceDir, "meta.json");
  const repoIdPath = join(workspaceDir, "repo-id");
  if (!existsSync(metaPath) || !existsSync(repoIdPath)) {
    return false;
  }
  try {
    return readFileSync(repoIdPath, "utf8").trim().length > 0;
  } catch {
    return false;
  }
}

export function isSodaGitInterlockError(message: string): boolean {
  return /sd-powered repo/i.test(message) || /raw git .* blocked/i.test(message);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function stdoutFromError(err: unknown): string | undefined {
  if (typeof err === "object" && err !== null && "stdout" in err) {
    const stdout = (err as { stdout?: unknown }).stdout;
    return typeof stdout === "string" ? stdout : undefined;
  }
  return undefined;
}

function parseSodaStatus(stdout: string): boolean {
  const envelope = JSON.parse(stdout) as SodaEnvelope<{ summary?: { initialized?: boolean } }>;
  return envelope.ok === true && envelope.data?.summary?.initialized === true;
}

async function probeSodaStatus(
  execCommand: (command: string, args: string[], cwd: string) => Promise<ExecResult>,
  dir: string,
): Promise<boolean> {
  try {
    const result = await execCommand("sd", ["status"], dir);
    return parseSodaStatus(result.stdout);
  } catch (err: unknown) {
    const stdout = stdoutFromError(err);
    if (stdout) {
      try {
        return parseSodaStatus(stdout);
      } catch {
        return false;
      }
    }
    return false;
  }
}

function parseSodaPull(stdout: string): boolean {
  const envelope = JSON.parse(stdout) as SodaEnvelope<SodaPullOutcome[]>;
  if (envelope.ok !== true) {
    throw new Error(`sd pull failed: ${envelope.error ?? "unknown error"}`);
  }
  if (!Array.isArray(envelope.data)) {
    throw new Error("sd pull failed: missing pull outcomes");
  }
  return envelope.data.some((outcome) => outcome.worktreeUpdated === true || outcome.worktree === true);
}

async function pullWithSoda(
  execCommand: (command: string, args: string[], cwd: string) => Promise<ExecResult>,
  dir: string,
): Promise<boolean> {
  try {
    const result = await execCommand("sd", ["pull"], dir);
    return parseSodaPull(result.stdout);
  } catch (err: unknown) {
    const stdout = stdoutFromError(err);
    if (stdout) {
      try {
        return parseSodaPull(stdout);
      } catch (parseErr: unknown) {
        if (parseErr instanceof Error && parseErr.message.startsWith("sd pull failed:")) {
          throw parseErr;
        }
      }
    }
    throw new Error(`sd pull failed: ${errorMessage(err)}`);
  }
}

export async function runSelfUpdate(deps: UpdateDeps = {}): Promise<UpdateResult> {
  const thisFile = fileURLToPath(import.meta.url);
  const repoRoot = deps.repoRoot ?? dirname(dirname(dirname(thisFile)));
  const execCommand = deps.execCommand ?? defaultExecCommand;
  const isGitRepo = deps.isGitRepo ?? ((dir: string) => isGitRepoRoot(dir, execCommand));
  const hasSodaWorkspace = deps.hasSodaWorkspace ?? hasSodaWorkspaceMarkers;

  console.log(chalk.dim(`  telepathy repo: ${repoRoot}\n`));

  if (!(await isGitRepo(repoRoot))) {
    throw new Error("telepathy install directory is not a git repo root.");
  }

  console.log(chalk.bold("  ↓ Pulling latest..."));
  const sodaByStatus = await probeSodaStatus(execCommand, repoRoot);
  const sodaByMarkers = hasSodaWorkspace(repoRoot);
  const sodaManaged = sodaByStatus || sodaByMarkers;
  let worktreeUpdated = false;

  try {
    if (sodaManaged) {
      try {
        worktreeUpdated = await pullWithSoda(execCommand, repoRoot);
      } catch (err: unknown) {
        const detail = errorMessage(err);
        if (sodaByMarkers && !sodaByStatus) {
          throw new Error(
            `This telepathy install is soda-managed, but sd pull failed. Put sd on PATH and rerun telepathy update. ${detail}`,
          );
        }
        throw err instanceof Error ? err : new Error(detail);
      }
    } else {
      try {
        const { stdout, stderr } = await execCommand("git", ["pull", "--ff-only"], repoRoot);
        worktreeUpdated = !gitPullMadeNoChanges((stdout + stderr).trim());
      } catch (err: unknown) {
        const detail = errorMessage(err);
        if (!isSodaGitInterlockError(detail)) {
          throw err instanceof Error ? err : new Error(detail);
        }
        try {
          worktreeUpdated = await pullWithSoda(execCommand, repoRoot);
        } catch (sodaErr: unknown) {
          throw new Error(
            `Pull was blocked by soda interlock hooks, and sd pull failed. Put sd on PATH and rerun telepathy update. ${errorMessage(sodaErr)}`,
          );
        }
      }
    }
  } catch (err: unknown) {
    const msg = errorMessage(err);
    console.error(chalk.red("  ✗ pull failed:") + ` ${msg}`);
    throw err instanceof Error ? err : new Error(msg);
  }

  if (!worktreeUpdated) {
    console.log(chalk.dim("    Already up to date."));
    console.log(chalk.dim("    Skipping install and build."));
    return {
      repoRoot,
      pulled: false,
      alreadyUpToDate: true,
      installed: false,
      built: false,
    };
  }
  console.log(chalk.green("    ✓ Pulled new changes."));

  console.log(chalk.bold("\n  ⬡ Installing dependencies..."));
  try {
    await execCommand("npm", ["install", "--no-audit", "--no-fund"], repoRoot);
    console.log(chalk.green("    ✓ Dependencies installed."));
  } catch (err: unknown) {
    const msg = errorMessage(err);
    console.error(chalk.red("  ✗ npm install failed:") + ` ${msg}`);
    throw err instanceof Error ? err : new Error(msg);
  }

  console.log(chalk.bold("\n  🔨 Building..."));
  try {
    await execCommand("npm", ["run", "build"], repoRoot);
    console.log(chalk.green("    ✓ Build complete."));
  } catch (err: unknown) {
    const msg = errorMessage(err);
    console.error(chalk.red("  ✗ Build failed:") + ` ${msg}`);
    throw err instanceof Error ? err : new Error(msg);
  }

  console.log(chalk.green("\n  ✓ telepathy updated successfully."));
  return {
    repoRoot,
    pulled: true,
    alreadyUpToDate: false,
    installed: true,
    built: true,
  };
}

export async function runUpdate(): Promise<void> {
  try {
    await runSelfUpdate();
  } catch {
    process.exit(1);
  }
}

async function isGitRepoRoot(
  dir: string,
  execCommand: (command: string, args: string[], cwd: string) => Promise<ExecResult>,
): Promise<boolean> {
  try {
    const { stdout } = await execCommand("git", ["rev-parse", "--show-toplevel"], dir);
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
