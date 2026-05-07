// Host-side handler for the `spawn_host` RPC. Spawns a fresh
// `telepathy host` process in a new visible OS terminal window on this
// box, captures its TLP1 join token via a parent-owned named pipe, and
// returns the token to the requesting peer (the viewer) which then
// pipes it through its existing /api/connect path.
//
// SAFETY:
//   • The pipe is host-local (named pipe on Windows, unix socket on
//     POSIX). It never crosses the LAN. The token also crosses the
//     existing TLS-PSK link back to the viewer.
//   • The pipe server is created BEFORE we launch the child. If we
//     created it after, the child could race ahead of the listener.
//   • Exactly one connection is expected. After we receive a single
//     JSON line { token }, we close the server and tear it down.
//   • A 30 s timeout bounds the wait. If the child crashes, hangs
//     before printing, or the user closes the spawned window before it
//     can write, the viewer gets a clean error instead of waiting
//     forever.
//
// The whole handoff is sub-second in practice; the 30 s budget is
// purely a safety net.

import { createServer as createNetServer, type Server, type Socket } from "node:net";
import { createInterface } from "node:readline";
import { buildPipePath } from "./ipc.js";
import { send as sendFrame } from "./transport.js";
import { openHostInTerminal } from "./launcher.js";
import { detectParentShell } from "./shell.js";
import type { Peer } from "./peers.js";
import { isDebug } from "./debug.js";

const HANDOFF_TIMEOUT_MS = 30_000;

// Exported so unit tests can drive the pipe server directly without a
// real launcher.
export function awaitTokenOnPipe(
  pipePath: string,
  timeoutMs: number,
): { promise: Promise<string>; close: () => void } {
  let server: Server | undefined;
  let timer: NodeJS.Timeout | undefined;
  let settled = false;

  const promise = new Promise<string>((resolveToken, rejectToken) => {
    const finish = (err: Error | null, token?: string): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      try {
        server?.close();
      } catch {
        /* ignore */
      }
      if (err) {
        rejectToken(err);
      } else {
        resolveToken(token!);
      }
    };

    timer = setTimeout(() => {
      finish(new Error(`spawn-host: token handoff timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    server = createNetServer((socket: Socket) => {
      // SAFETY: readline re-emits source-stream errors. Without this
      // handler, an EPIPE on the pipe would crash the host process.
      socket.on("error", () => undefined);
      const rl = createInterface({ input: socket, crlfDelay: Infinity });
      rl.on("error", () => undefined);
      rl.once("line", (line) => {
        let parsed: { token?: unknown };
        try {
          parsed = JSON.parse(line) as { token?: unknown };
        } catch {
          finish(new Error("spawn-host: child wrote malformed JSON to handoff pipe"));
          return;
        }
        if (typeof parsed.token !== "string" || parsed.token.length === 0) {
          finish(new Error("spawn-host: child handoff message missing 'token' string"));
          return;
        }
        finish(null, parsed.token);
        try {
          socket.end();
        } catch {
          /* ignore */
        }
      });
      rl.once("close", () => {
        // If the child closed the pipe without writing a token, surface
        // it instead of waiting on the timeout.
        finish(new Error("spawn-host: child closed handoff pipe without sending a token"));
      });
    });
    server.on("error", (err) => {
      finish(err instanceof Error ? err : new Error(String(err)));
    });
    server.listen(pipePath);
  });

  return {
    promise,
    close: () => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      try {
        server?.close();
      } catch {
        /* ignore */
      }
    },
  };
}

export async function handleSpawnHostRequest(peer: Peer, id: string): Promise<void> {
  const pipePath = buildPipePath();
  const { promise } = awaitTokenOnPipe(pipePath, HANDOFF_TIMEOUT_MS);

  if (isDebug()) {
    process.stderr.write(`[telepathy/spawn-host] launching child host, pipe=${pipePath}\n`);
  }

  let token: string;
  try {
    openHostInTerminal({ pipePath, shell: detectParentShell() });
    token = await promise;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (isDebug()) {
      process.stderr.write(`[telepathy/spawn-host] handoff failed: ${msg}\n`);
    }
    sendFrame(peer.socket, {
      type: "spawn_host_ack",
      id,
      ok: false,
      error: msg,
    });
    return;
  }

  if (isDebug()) {
    process.stderr.write(`[telepathy/spawn-host] handoff ok, returning token to ${peer.alias}\n`);
  }
  sendFrame(peer.socket, {
    type: "spawn_host_ack",
    id,
    ok: true,
    token,
  });
}
