// OS-window launcher — spawns a fresh visible terminal window on the
// host machine, running `telepathy host --token-handoff-pipe <pipe>`.
//
// v1 is Windows-only; POSIX paths throw a clear error so the viewer
// surfaces a sensible message instead of silently hanging on the pipe.
//
// Why a separate module: the host process already does platform branching
// (`describePortHolder` in commands/host.ts), and adding wt.exe/gnome-
// terminal/osascript handling later wants a stable seam. This file is
// the seam.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";

export type LaunchOptions = {
  pipePath: string;          // named-pipe path the child will write its token to
};

export function openHostInTerminal(opts: LaunchOptions): void {
  if (process.platform !== "win32") {
    throw new Error("spawn-host: opening a new terminal window is only supported on Windows in this build");
  }

  // Resolve the CLI entry point. We're running under dist/core/launcher.js
  // (or src/core/launcher.ts during ts-node); cli.js sits one directory up.
  const here = dirname(fileURLToPath(import.meta.url));
  const cliPath = resolve(here, "..", "cli.js");
  if (!existsSync(cliPath)) {
    throw new Error(`spawn-host: cli entry not found at ${cliPath} — is the build current?`);
  }

  // `cmd /c start "<title>" /MAX node "<cliPath>" host --token-handoff-pipe <pipe>`
  // - `start` is a cmd builtin that launches in a new console window.
  // - The first quoted arg to `start` is the window title; the empty string
  //   would be ambiguous on some Windows versions, so we pass an explicit
  //   "telepathy host" title.
  // - /MAX asks Windows to open the spawned host terminal maximized.
  // - We use plain `node` from PATH (telepathy ships its own dependency on
  //   node already; running `telepathy host` already requires node).
  // - detached + stdio:"ignore" so the launcher returns immediately and the
  //   new window owns its own input/output. windowsHide is left at default
  //   (false) — we WANT the window visible.
  const child = spawn(
    "cmd.exe",
    buildWindowsStartArgs(cliPath, opts.pipePath),
    {
      detached: true,
      stdio: "ignore",
      windowsHide: false,
    },
  );
  child.unref();
}

export function buildWindowsStartArgs(cliPath: string, pipePath: string): string[] {
  return [
    "/c",
    "start",
    "telepathy host",
    "/MAX",
    "node",
    cliPath,
    "host",
    "--token-handoff-pipe",
    pipePath,
  ];
}
