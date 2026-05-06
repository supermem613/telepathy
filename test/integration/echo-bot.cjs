#!/usr/bin/env node
// Tiny "echo bot" used by integration tests as the wrapped command for
// `telepathy host`. Echoes each chunk of stdin back to stdout prefixed
// with "echo:" so the test can assert the bytes round-tripped through:
//   xterm.onData → ws.send → server → orchestrator → host pty_input →
//   wrapper IPC → ConPTY → child stdin → child stdout → ConPTY frame →
//   wrapper IPC → orchestrator → ws → xterm.write
//
// Special commands:
//   QUIT      — exit cleanly
//   SIZE      — emit "size:<cols>x<rows>" using the bot's current PTY size
//
// Run as: node test/integration/echo-bot.cjs
process.stdout.write("ECHO_BOT_READY\n");
process.stdin.setEncoding("utf8");
// Re-print size on SIGWINCH so callers can observe a resize landing.
process.stdout.on("resize", () => {
  process.stdout.write(`resize:${process.stdout.columns}x${process.stdout.rows}\n`);
});
let buf = "";
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0 || (nl = buf.indexOf("\r")) >= 0) {
    const line = buf.slice(0, nl).replace(/\r/g, "");
    buf = buf.slice(nl + 1);
    if (line === "QUIT") {
      process.exit(0);
    } else if (line === "SIZE") {
      process.stdout.write(`size:${process.stdout.columns}x${process.stdout.rows}\n`);
    } else {
      process.stdout.write(`echo:${line}\n`);
    }
  }
});
process.stdin.on("end", () => process.exit(0));
