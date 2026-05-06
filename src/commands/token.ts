// `telepathy token` — reprint the current join token from inside the
// wrapped shell. Connects to the wrapper's IPC pipe (TELEPATHY_SOCKET,
// set by `telepathy host` for every child of the wrapped shell), sends
// a `get_token` request, and prints the reply.
//
// Why this exists: the original join token is valid for the lifetime of
// the host process (no TTL). When an app disconnects and the user wants
// to reconnect, they need the token again. Scrolling terminal history is
// fragile (the banner may have scrolled away under TUI redraws). This
// command resurfaces it on demand without restarting the host.
//
// Constraints by design:
//   • Only works when run from inside a `telepathy host` wrapped shell.
//     Outside, `TELEPATHY_SOCKET` is unset and we fail with a clear
//     remediation message.
//   • Only works when the host has an active listener. With `--no-listen`,
//     the wrapper replies `token_error` and we surface it.
//   • Read-only — never mutates the listener PSK. (PSK rotation is a
//     separate, deferred feature; the original token keeps working.)

import { connectIpcClient, sendIpc, readIpc, type WrapperToExtension, type ExtensionToWrapper } from "../core/ipc.js";
import chalk from "chalk";

export type TokenOptions = {
  json?: boolean;
};

const REPLY_TIMEOUT_MS = 3_000;

export async function runToken(opts: TokenOptions): Promise<void> {
  // SAFETY: TELEPATHY_SOCKET is the established structural integration
  // contract between the host wrapper and any child of the wrapped shell
  // (see core/ipc.ts header and host.ts where it is set). It is not a
  // behavioral configuration knob — without it, this command has no
  // wrapper to talk to.
  const pipePath = process.env.TELEPATHY_SOCKET;
  if (!pipePath) {
    process.stderr.write(chalk.red("telepathy token: not running inside a `telepathy host` wrapped shell.\n"));
    process.stderr.write(chalk.dim("  TELEPATHY_SOCKET is unset. Run this command from a shell that was spawned by `telepathy host`.\n"));
    process.exit(1);
  }

  let info: { token: string; addr: string; bindHost: string };
  try {
    info = await fetchToken(pipePath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (opts.json) {
      process.stdout.write(`${JSON.stringify({ ok: false, error: msg })}\n`);
    } else {
      process.stderr.write(chalk.red(`telepathy token: ${msg}\n`));
    }
    process.exit(1);
  }

  if (opts.json) {
    process.stdout.write(`${JSON.stringify({ ok: true, ...info }, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${chalk.cyan("📡 telepathy host token")}\n`);
  process.stdout.write(`   bound: ${info.bindHost}\n`);
  process.stdout.write(`   addr:  ${info.addr}\n`);
  process.stdout.write(`   token: ${chalk.bold(info.token)}\n`);
  process.stdout.write(chalk.dim("   share with the other box; they run `telepathy connect <token>` or `telepathy app <token>`\n"));
}

function fetchToken(pipePath: string): Promise<{ token: string; addr: string; bindHost: string }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (err: Error | null, value?: { token: string; addr: string; bindHost: string }): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      try {
        socketRef?.end();
      } catch {
        /* ignore */
      }
      if (err) {
        reject(err);
      } else {
        resolve(value!);
      }
    };

    const timer = setTimeout(() => {
      finish(new Error(`timed out after ${REPLY_TIMEOUT_MS}ms waiting for the wrapper to reply on ${pipePath}`));
    }, REPLY_TIMEOUT_MS);

    let socketRef: Awaited<ReturnType<typeof connectIpcClient>> | undefined;
    connectIpcClient(pipePath).then((socket) => {
      socketRef = socket;
      // Swallow late socket errors so they don't crash the process after
      // we've already settled (e.g. EPIPE from the wrapper closing first).
      socket.on("error", () => undefined);
      readIpc<WrapperToExtension>(socket, (msg) => {
        if (msg.type === "token") {
          finish(null, { token: msg.token, addr: msg.addr, bindHost: msg.bindHost });
          return;
        }
        if (msg.type === "token_error") {
          finish(new Error(msg.error));
          return;
        }
        // The wrapper sends `hello` + `frame`s on every connect; ignore
        // those — we only care about the reply to our get_token request.
      }, (err) => {
        if (err) {
          finish(err);
        } else if (!settled) {
          finish(new Error(`wrapper closed the IPC pipe before replying`));
        }
      });
      const req: ExtensionToWrapper = { type: "get_token" };
      try {
        sendIpc(socket, req);
      } catch (err) {
        finish(err instanceof Error ? err : new Error(String(err)));
      }
    }).catch((err: unknown) => {
      finish(err instanceof Error ? err : new Error(String(err)));
    });
  });
}
