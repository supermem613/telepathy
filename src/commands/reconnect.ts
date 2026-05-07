// `telepathy reconnect` is intentionally not a host-discovery client.
// When typed in the original `telepathy host` terminal, the wrapper observes
// the local stdin line and re-pairs in-process. If it actually executes, it is
// a harmless no-op so scripts and shell history do not receive a token.

export function runReconnect(): void {
  process.stderr.write("telepathy reconnect: request observed only when typed in the original telepathy host terminal.\n");
}
