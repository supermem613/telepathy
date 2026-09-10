import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import {
  runSelfUpdate,
  gitPullMadeNoChanges,
  isSodaGitInterlockError,
  hasSodaWorkspaceMarkers,
} from "../../src/commands/update.js";

function recordCall(command: string, args: string[]): string {
  return [command, ...args].join(" ");
}

const SODA_INTERLOCK_ERROR =
  "Command failed: git pull --ff-only\nsoda: raw git commit blocked in this sd-powered repo\nUse \"sd submit\" instead.";

describe("update", () => {
  it("skips install and build when git pull made no changes", async () => {
    const calls: string[] = [];
    const result = await runSelfUpdate({
      repoRoot: "repo",
      isGitRepo: async () => true,
      hasSodaWorkspace: () => false,
      execCommand: async (command, args) => {
        calls.push(recordCall(command, args));
        return { stdout: "Already up to date.\n", stderr: "" };
      },
    });
    assert.deepEqual(calls, ["sd status", "git pull --ff-only"]);
    assert.equal(result.alreadyUpToDate, true);
    assert.equal(result.installed, false);
    assert.equal(result.built, false);
  });

  it("installs and builds when git pull returns changes", async () => {
    const calls: string[] = [];
    const result = await runSelfUpdate({
      repoRoot: "repo",
      isGitRepo: async () => true,
      hasSodaWorkspace: () => false,
      execCommand: async (command, args) => {
        calls.push(recordCall(command, args));
        return { stdout: command === "git" ? "Fast-forward\n" : "ok\n", stderr: "" };
      },
    });
    assert.deepEqual(calls, [
      "sd status",
      "git pull --ff-only",
      "npm install --no-audit --no-fund",
      "npm run build",
    ]);
    assert.equal(result.installed, true);
    assert.equal(result.built, true);
  });

  it("uses sd pull in a soda-managed repo and installs after worktree updates", async () => {
    const calls: string[] = [];
    const result = await runSelfUpdate({
      repoRoot: "repo",
      isGitRepo: async () => true,
      hasSodaWorkspace: () => false,
      execCommand: async (command, args) => {
        calls.push(recordCall(command, args));
        if (command === "sd" && args.join(" ") === "status") {
          return { stdout: JSON.stringify({ ok: true, data: { summary: { initialized: true } } }), stderr: "" };
        }
        if (command === "sd" && args.join(" ") === "pull") {
          return {
            stdout: JSON.stringify({
              ok: true,
              data: [{ status: "up-to-date", worktree: false }, { status: "pulled", worktree: true }],
            }),
            stderr: "",
          };
        }
        return { stdout: "ok\n", stderr: "" };
      },
    });
    assert.deepEqual(calls, [
      "sd status",
      "sd pull",
      "npm install --no-audit --no-fund",
      "npm run build",
    ]);
    assert.equal(calls.includes("git pull --ff-only"), false);
    assert.equal(result.pulled, true);
  });

  it("skips install and build when sd pull does not update the worktree", async () => {
    const calls: string[] = [];
    const result = await runSelfUpdate({
      repoRoot: "repo",
      isGitRepo: async () => true,
      hasSodaWorkspace: () => false,
      execCommand: async (command, args) => {
        calls.push(recordCall(command, args));
        if (command === "sd" && args.join(" ") === "status") {
          return { stdout: JSON.stringify({ ok: true, data: { summary: { initialized: true } } }), stderr: "" };
        }
        if (command === "sd" && args.join(" ") === "pull") {
          return { stdout: JSON.stringify({ ok: true, data: [{ status: "up-to-date", worktree: false }] }), stderr: "" };
        }
        return { stdout: "ok\n", stderr: "" };
      },
    });
    assert.deepEqual(calls, ["sd status", "sd pull"]);
    assert.equal(result.alreadyUpToDate, true);
    assert.equal(result.installed, false);
  });

  it("uses sd pull when workspace markers exist even if sd status fails", async () => {
    const calls: string[] = [];
    const result = await runSelfUpdate({
      repoRoot: "repo",
      isGitRepo: async () => true,
      hasSodaWorkspace: () => true,
      execCommand: async (command, args) => {
        calls.push(recordCall(command, args));
        if (command === "sd" && args.join(" ") === "status") {
          throw new Error("spawn sd ENOENT");
        }
        if (command === "sd" && args.join(" ") === "pull") {
          return {
            stdout: JSON.stringify({ ok: true, data: [{ status: "pulled", worktreeUpdated: true }] }),
            stderr: "",
          };
        }
        return { stdout: "ok\n", stderr: "" };
      },
    });
    assert.equal(calls.includes("git pull --ff-only"), false);
    assert.equal(calls.includes("sd pull"), true);
    assert.equal(result.pulled, true);
  });

  it("fails clearly when markers say soda but sd pull cannot run", async () => {
    await assert.rejects(
      () =>
        runSelfUpdate({
          repoRoot: "repo",
          isGitRepo: async () => true,
          hasSodaWorkspace: () => true,
          execCommand: async (command) => {
            if (command === "sd") {
              throw new Error("spawn sd ENOENT");
            }
            return { stdout: "ok\n", stderr: "" };
          },
        }),
      /soda-managed[\s\S]*sd on PATH/i,
    );
  });

  it("retries with sd pull when git pull hits soda interlock hooks", async () => {
    const calls: string[] = [];
    const result = await runSelfUpdate({
      repoRoot: "repo",
      isGitRepo: async () => true,
      hasSodaWorkspace: () => false,
      execCommand: async (command, args) => {
        calls.push(recordCall(command, args));
        if (command === "sd" && args.join(" ") === "status") {
          throw new Error("spawn sd ENOENT");
        }
        if (command === "git" && args.join(" ") === "pull --ff-only") {
          throw new Error(SODA_INTERLOCK_ERROR);
        }
        if (command === "sd" && args.join(" ") === "pull") {
          return {
            stdout: JSON.stringify({ ok: true, data: [{ status: "pulled", worktreeUpdated: true }] }),
            stderr: "",
          };
        }
        return { stdout: "ok\n", stderr: "" };
      },
    });
    assert.deepEqual(calls, [
      "sd status",
      "git pull --ff-only",
      "sd pull",
      "npm install --no-audit --no-fund",
      "npm run build",
    ]);
    assert.equal(result.pulled, true);
  });

  it("fails clearly when install directory is not a git repo", async () => {
    await assert.rejects(
      () => runSelfUpdate({ repoRoot: "not-a-repo", isGitRepo: async () => false, hasSodaWorkspace: () => false }),
      /not a git repo/i,
    );
  });

  it("recognizes legacy git no-change output", () => {
    assert.equal(gitPullMadeNoChanges("Already up-to-date."), true);
    assert.equal(gitPullMadeNoChanges("Fast-forward"), false);
  });

  it("detects soda interlock error text", () => {
    assert.equal(isSodaGitInterlockError(SODA_INTERLOCK_ERROR), true);
    assert.equal(isSodaGitInterlockError("fatal: not a repository"), false);
  });

  it("detects soda workspace markers from meta and repo-id", () => {
    assert.equal(hasSodaWorkspaceMarkers("definitely-not-a-soda-workspace-path"), false);
  });
});
