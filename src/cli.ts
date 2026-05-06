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

const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
const VERSION = (JSON.parse(readFileSync(pkgPath, "utf8")) as { version: string }).version;

const program = new Command();
program
  .name("telepathy")
  .description("Peer-to-peer terminal sharing over the LAN")
  .version(VERSION);

program
  .command("host")
  .description("Wrap a process under a ConPTY and expose its terminal to peers (default cmd: your shell)")
  .option("-p, --port <port>", "TCP port to listen on", (v) => parseInt(v, 10))
  .option("-b, --bind <host>", "Interface to bind to (default: detected LAN IPv4)")
  .option("-a, --advertise <host>", "IP encoded into the join token (default: detected LAN IPv4)")
  .option("--no-listen", "Run wrapper without binding a peer listener")
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
    });
  });

program
  .command("shell")
  .description("Alias for `telepathy host` (wraps your default shell)")
  .option("-p, --port <port>", "TCP port to listen on", (v) => parseInt(v, 10))
  .option("-b, --bind <host>", "Interface to bind to (default: detected LAN IPv4)")
  .option("-a, --advertise <host>", "IP encoded into the join token (default: detected LAN IPv4)")
  .action(async (options) => {
    await runHost({
      port: options.port,
      bind: options.bind,
      advertise: options.advertise,
    });
  });

program
  .command("connect <token>")
  .description("Link to a host using its join token (default: opens browser viewer)")
  .option("--as <alias>", "Custom local alias for this peer")
  .option("--term", "Mirror in the current terminal instead of opening a browser (not yet implemented)")
  .action(async (token: string, options) => {
    await runConnect({ token, alias: options.as, term: options.term });
  });

program
  .command("app [tokens...]")
  .description("Open the multi-peer wall viewer (optionally pre-link the given tokens)")
  .option("--no-windowed", "Open in default browser (vs. chrome --app= chromeless window)")
  .action(async (tokens: string[], options) => {
    await runApp({ tokens, windowed: options.windowed });
  });

program
  .command("peers")
  .description("List active links and the local listener (if any)")
  .option("--json", "Machine-readable output")
  .action((options) => {
    runPeers({ json: options.json });
  });

program
  .command("disconnect [peer]")
  .description("Tear down one or all peer links")
  .option("--json", "Machine-readable output")
  .action((peer: string | undefined, options) => {
    runDisconnect({ peer, json: options.json });
  });

program
  .command("doctor")
  .description("Preflight: node version, node-pty, default port, browser")
  .option("--json", "Machine-readable output")
  .action(async (options) => {
    await runDoctor({ json: options.json });
  });

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
