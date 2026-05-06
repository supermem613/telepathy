#!/usr/bin/env node
// telepathy CLI entry point — commander dispatcher to ./commands/*.

import { Command } from "commander";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { runHost } from "./commands/host.js";
import { runConnect } from "./commands/connect.js";
import { runApp } from "./commands/app.js";
import { runPeers, runDisconnect } from "./commands/peers.js";
import { runDoctor } from "./commands/doctor.js";
import { runInstallShortcut } from "./commands/install-shortcut.js";
import { runUpdate } from "./commands/update.js";
import { setDebug } from "./core/debug.js";

const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
const VERSION = (JSON.parse(readFileSync(pkgPath, "utf8")) as { version: string }).version;

const program = new Command();
program
  .name("telepathy")
  .description("Peer-to-peer terminal sharing over the LAN")
  .version(VERSION)
  // Global --debug enables verbose stderr traces from the orchestrator,
  // pty-wrapper, hold loop, etc. Wired through src/core/debug.ts so the
  // setting is process-wide without touching env vars.
  .option("--debug", "Enable verbose diagnostic logging to stderr")
  .hook("preAction", (thisCommand) => {
    if (thisCommand.opts().debug) {
      setDebug(true);
    }
  });

program
  .command("host")
  .description("Wrap a shell (or any command after `--`) under a ConPTY and expose it to peers")
  .option("-p, --port <port>", "TCP port to listen on (default: try 7423, fall back to a random free port)", (v) => parseInt(v, 10))
  .option("-b, --bind <host>", "Interface to bind to (default: 0.0.0.0 — all interfaces)")
  .option("-a, --advertise <host>", "IP encoded into the join token (default: detected LAN IPv4)")
  .option("--no-listen", "Run the wrapper without binding a peer listener (local-only)")
  // Hidden internal flag: see HostOptions.tokenHandoffPipe. Used by the
  // spawn-host RPC; not for end-users.
  .option("--token-handoff-pipe <path>", "(internal) write the join token to this named pipe / unix socket and continue")
  .allowUnknownOption(true)
  .allowExcessArguments(true)
  .action(async (options) => {
    const { command, args } = collectChildCommand(process.argv);
    await runHost({
      command,
      args,
      port: options.port,
      bind: options.bind,
      advertise: options.advertise,
      noListen: options.listen === false,
      tokenHandoffPipe: options.tokenHandoffPipe,
    });
  });

program
  .command("connect <token>")
  .description("Link to a host using its TLP1 join token (browser wall by default; --term for in-terminal mirror)")
  .option("--as <alias>", "Custom local alias for this peer (default: derived from host's hostname)")
  .option("--term", "Mirror the remote PTY in this terminal instead of opening the wall (use Ctrl-] to detach)")
  .action(async (token: string, options) => {
    await runConnect({ token, alias: options.as, term: options.term });
  });

program
  .command("app [tokens...]")
  .description("Open the Electron wall viewer; auto-links any tokens passed as args (multi-tab, mouse-clickable)")
  .action(async (tokens: string[]) => {
    await runApp({ tokens });
  });

program
  .command("peers")
  .description("List active peer links and the local listener (if any)")
  .option("--json", "Machine-readable output")
  .action((options) => {
    runPeers({ json: options.json });
  });

program
  .command("disconnect [peer]")
  .description("Tear down one peer link (by alias) or all peers (no arg)")
  .option("--json", "Machine-readable output")
  .action((peer: string | undefined, options) => {
    runDisconnect({ peer, json: options.json });
  });

program
  .command("doctor")
  .description("Preflight checks: node version, node-pty availability, default port, browser launcher")
  .option("--json", "Machine-readable output")
  .action(async (options) => {
    await runDoctor({ json: options.json });
  });

program
  .command("install-shortcut")
  .description("Windows: install (or --uninstall) a Start-menu shortcut for `telepathy app` you can pin to taskbar")
  .option("--uninstall", "Remove the shortcut instead of creating it")
  .action(async (options) => {
    await runInstallShortcut({ uninstall: options.uninstall });
  });

program
  .command("update")
  .description("Pull, npm install, and rebuild the local telepathy clone in place")
  .action(async () => {
    await runUpdate();
  });

// Bare `telepathy`(no args) prints version + full help. Matches the
// rotunda/kash/reflux convention. Doesn't print before sub-commands so
// machine-parseable output stays clean.
if (process.argv.slice(2).length === 0) {
  process.stdout.write(`telepathy v${VERSION}\n\n`);
  program.outputHelp();
  process.exit(0);
}

program.parseAsync(process.argv).catch((err) => {
  process.stderr.write(`telepathy: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});

function collectChildCommand(argv: string[]): { command?: string; args?: string[] } {
  // Everything after `--` becomes the wrapped command. If `--` isn't
  // present, host falls back to the user's default shell.
  const ddIdx = argv.indexOf("--");
  if (ddIdx < 0) {
    return {};
  }
  const tail = argv.slice(ddIdx + 1);
  if (tail.length === 0) {
    return {};
  }
  return { command: tail[0], args: tail.slice(1) };
}
