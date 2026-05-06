#!/usr/bin/env node
// Tiny "echo bot" used by integration tests as the wrapped command for
// `telepathy host`. Echoes each chunk of stdin back to stdout prefixed
// with "echo:" so the test can assert the bytes round-tripped through:
//   xterm.onData → ws.send → server → orchestrator → host pty_input →
//   wrapper IPC → ConPTY → child stdin → child stdout → ConPTY frame →
//   wrapper IPC → orchestrator → ws → xterm.write
//
// Run as: node test/integration/echo-bot.cjs
process.stdout.write("ECHO_BOT_READY\n");
process.stdin.setEncoding("utf8");
let buf = "";
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0 || (nl = buf.indexOf("\r")) >= 0) {
    const line = buf.slice(0, nl).replace(/\r/g, "");
    buf = buf.slice(nl + 1);
    if (line === "QUIT") {
      process.exit(0);
    }
    process.stdout.write(`echo:${line}\n`);
  }
});
process.stdin.on("end", () => process.exit(0));
