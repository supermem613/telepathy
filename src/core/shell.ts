// Detect the shell that launched the current process. Used by `telepathy host`
// to spawn the same shell the user is already in, rather than falling back to
// COMSPEC (always cmd.exe on Windows regardless of which shell is running).
//
// On POSIX, $SHELL is the standard convention.
// On Windows, we inspect the parent process name via `tasklist` and match
// against known shells. Falls back to cmd.exe if detection fails.

import { execFileSync } from "node:child_process";
import { isDebug } from "./debug.js";

const KNOWN_SHELLS = new Set([
  "cmd",
  "pwsh",
  "powershell",
  "bash",
  "zsh",
  "fish",
  "nu",
]);

/**
 * Returns the shell executable that should be spawned for the user's session.
 * On Windows, detects the parent process (the shell that ran `telepathy host`).
 * On POSIX, uses the SHELL environment variable.
 */
export function detectParentShell(): string {
  if (process.platform !== "win32") {
    return process.env.SHELL ?? "/bin/bash";
  }

  try {
    const ppid = process.ppid;
    const out = execFileSync("tasklist.exe", [
      "/FI", `PID eq ${ppid}`,
      "/FO", "CSV",
      "/NH",
    ], { stdio: ["ignore", "pipe", "ignore"], timeout: 3000 }).toString().trim();

    // Output format: "pwsh.exe","1234","Console","1","102,360 K"
    const match = out.match(/^"([^"]+)"/);
    if (match) {
      const imageName = match[1]; // e.g. "pwsh.exe"
      const baseName = imageName.replace(/\.exe$/i, "").toLowerCase();
      if (KNOWN_SHELLS.has(baseName)) {
        if (isDebug()) {
          process.stderr.write(`[telepathy/shell] detected parent shell: ${imageName}\n`);
        }
        return imageName;
      }
      if (isDebug()) {
        process.stderr.write(`[telepathy/shell] parent is ${imageName}, not a known shell — falling back to cmd.exe\n`);
      }
    }
  } catch {
    if (isDebug()) {
      process.stderr.write("[telepathy/shell] parent shell detection failed — falling back to cmd.exe\n");
    }
  }

  return "cmd.exe";
}
