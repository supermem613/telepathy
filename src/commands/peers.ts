// `telepathy peers` — list active links and the local listener (if any).

import { describePeers, disconnectPeer } from "../core/api.js";
import chalk from "chalk";

export type PeersOptions = {
  json?: boolean;
};

export function runPeers(opts: PeersOptions): void {
  const r = describePeers();
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
    return;
  }
  if (r.listening) {
    process.stdout.write(`${chalk.cyan("📡 listening")}  bound=${r.listening.bindHost} addr=${r.listening.addr}\n`);
    process.stdout.write(`   token: ${chalk.bold(r.listening.token)}\n`);
  }
  if (r.peers.length === 0) {
    process.stdout.write(chalk.dim("   no peers connected.\n"));
    return;
  }
  process.stdout.write(`\n${chalk.cyan("peers")} (${r.peers.length}):\n`);
  for (const p of r.peers) {
    const pty = p.hasPty ? chalk.green("pty") : chalk.yellow("no-pty");
    process.stdout.write(`  • ${chalk.bold(p.alias)}  ${p.remoteAlias}  ${p.remoteAddr}  ${p.origin}  ${pty}  since ${p.connectedAtIso}\n`);
  }
}

export type DisconnectOptions = {
  peer?: string;
  json?: boolean;
};

export function runDisconnect(opts: DisconnectOptions): void {
  const r = disconnectPeer(opts);
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
    return;
  }
  if (r.disconnected.length === 0) {
    process.stdout.write(chalk.yellow("no matching peers.\n"));
  } else {
    process.stdout.write(`${chalk.cyan("disconnected:")} ${r.disconnected.join(", ")}\n`);
  }
}
