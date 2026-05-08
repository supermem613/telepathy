#!/usr/bin/env node
// Raw-mode echo bot for wall-input round-trip tests. Puts stdin in raw
// mode so the PTY's line-discipline doesn't eat control characters
// (Ctrl-C, ESC, paste markers, etc.) before they reach this program —
// matches what a real TUI like Copilot CLI does.
//
// On every chunk of stdin bytes, emits a single line:
//   RX:<hex>\n
// where <hex> is the chunk as lowercase hex. Tests grep stdout for
// specific RX lines to assert exact byte delivery.
//
// Special command bytes (NOT echoed back, processed locally):
//   0x05 (Ctrl-E) — exit cleanly
//
// We use 0x05 (not 0x04 / Ctrl-D) so tests can exercise Ctrl-C / Ctrl-D
// passthrough without accidentally killing the bot.

if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
}
process.stdout.write("RAW_ECHO_READY\n");
process.stdin.on("data", (chunk) => {
  if (chunk.includes(0x05)) {
    process.exit(0);
  }
  process.stdout.write("RX:" + chunk.toString("hex") + "\n");
});

process.stdin.on("end", () => process.exit(0));
