// Process-wide debug flag. Set ONCE at CLI parse time via `--debug`
// (see src/cli.ts) and read by anyone who needs to gate verbose
// stderr traces. Deliberately a tiny module: we don't want anyone
// reaching for `process.env.TELEPATHY_DEBUG` — env vars are invisible
// global state and break test isolation. CLI flag in, getter out.

let debugFlag = false;

export function setDebug(on: boolean): void {
  debugFlag = on;
}

export function isDebug(): boolean {
  return debugFlag;
}
