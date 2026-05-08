#!/usr/bin/env node
function drawPrompt() {
  process.stdout.write(`\x1b[?1049h\x1b[2J\x1b[${process.stdout.rows};1Hhost> `);
}

drawPrompt();

process.stdin.setEncoding("utf8");
let buf = "";
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0 || (nl = buf.indexOf("\r")) >= 0) {
    const line = buf.slice(0, nl).replace(/\r/g, "");
    buf = buf.slice(nl + 1);
    process.stdout.write(line);
  }
});

process.stdin.on("end", () => process.exit(0));
