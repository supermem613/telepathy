// Wrapper-side PTY broker. Allocates a ConPTY, spawns the child program
// under it, tees PTY frames to (a) the wrapper's own stdout (so the user
// sees the live session) and (b) every connected IPC subscriber (the
// extension reads frames here and re-broadcasts to remote peers).
//
// node-pty is a native module; we import lazily so a missing/broken build
// degrades gracefully — `telepathy host` falls back to a non-mirrored
// passthrough and emits a friendly diagnostic.

import { startIpcServer, sendIpc, readIpc, type WrapperToExtension, type ExtensionToWrapper } from "./ipc.js";
import { isDebug } from "./debug.js";
import { trackDecModes, buildReplayWithModes } from "./dec-modes.js";
import type { Server, Socket } from "node:net";

export type Pty = {
  onData(handler: (data: string | Buffer) => void): void;
  onExit(handler: (e: { exitCode: number; signal?: number }) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  cols: number;
  rows: number;
};

export function encodePtyDataForReplay(data: string | Buffer): Buffer {
  return Buffer.isBuffer(data) ? Buffer.from(data) : Buffer.from(data, "utf8");
}

export function buildPtySpawnOptions(opts: StartWrapperOptions, cols: number, rows: number): Parameters<PtyModule["spawn"]>[2] {
  return {
    name: "xterm-256color",
    cols,
    rows,
    cwd: opts.cwd,
    env: opts.env,
    encoding: null,
    useConptyDll: true,
    conptyInheritCursor: true,
  } as Parameters<PtyModule["spawn"]>[2];
}

export type PtyModule = {
  spawn(file: string, args: string[], opts: {
    name: string;
    cols: number;
    rows: number;
    cwd: string;
    env: Record<string, string | undefined>;
  }): Pty;
};

// Lazy native-module load; returns null if node-pty isn't available.
async function tryLoadPty(): Promise<PtyModule | null> {
  try {
    const mod = await import("node-pty");
    return mod as unknown as PtyModule;
  } catch {
    return null;
  }
}

const RING_BUFFER_BYTES = 64 * 1024; // ~64 KB of replay state per session

export type WrapperState = {
  pty: Pty;
  server: Server;
  pipePath: string;
  ringBuffer: Buffer;
  subscribers: Set<Socket>;
};

export type StartWrapperOptions = {
  pipePath: string;
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string | undefined>;
  // Called when the wrapped child exits. Defaults to `process.exit(code)`,
  // which is what the production CLI wants. Tests pass a custom handler.
  onChildExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
  // Whether to attach the wrapper to the host process's stdin/stdout for
  // user passthrough. Default true (production CLI). Tests pass false.
  attachStdio?: boolean;
  // Called when the local host terminal types `telepathy reconnect`.
  // Remote peer input and child output do not pass through this observer.
  onReconnectRequest?: () => string | Promise<string>;
};

export type ReconnectInputState = {
  line: string;
};

const RECONNECT_COMMANDS = new Set(["telepathy reconnect", ":telepathy reconnect"]);
const MAX_RECONNECT_LINE_CHARS = 256;

export function observeReconnectInput(state: ReconnectInputState, chunk: Buffer): number {
  let count = 0;
  for (const byte of chunk) {
    if (byte === 0x0d || byte === 0x0a) {
      if (RECONNECT_COMMANDS.has(state.line.trim())) {
        count += 1;
      }
      state.line = "";
      continue;
    }
    if (byte === 0x03 || byte === 0x15) {
      state.line = "";
      continue;
    }
    if (byte === 0x08 || byte === 0x7f) {
      state.line = state.line.slice(0, -1);
      continue;
    }
    if (byte < 0x20 || byte > 0x7e) {
      continue;
    }
    state.line += String.fromCharCode(byte);
    if (state.line.length > MAX_RECONNECT_LINE_CHARS) {
      state.line = state.line.slice(-MAX_RECONNECT_LINE_CHARS);
    }
  }
  return count;
}

export async function startWrapper(opts: StartWrapperOptions): Promise<WrapperState | null> {
  const ptyMod = await tryLoadPty();
  if (!ptyMod) {
    return null;
  }
  const cols = process.stdout.columns ?? 132;
  const rows = process.stdout.rows ?? 42;
  // encoding:null keeps raw PTY bytes. On Windows runners the default
  // string decoding can mojibake UTF-8 box drawing as CP437 text.
  // useConptyDll: true picks node-pty's bundled conpty.dll (newer than
  // the OS-bundled one) which fixes known VT-passthrough bugs —
  // specifically, the bug where alt-screen-mode TUIs render their
  // updates as scroll output instead of in-place redraws when wrapped.
  // conptyInheritCursor preserves cursor state across the wrapper
  // boundary so absolute-position writes from the child land at the
  // expected row/col on the host's terminal.
  // Cast: IWindowsPtyForkOptions is the right shape on win32 but
  // node-pty's main spawn() type is IPtyForkOptions (POSIX-flavored)
  // and doesn't expose the Windows-only flags; the underlying impl
  // accepts them at runtime.
  const ptyOpts = buildPtySpawnOptions(opts, cols, rows);
  const pty = ptyMod.spawn(opts.command, opts.args, ptyOpts);
  let ringBuffer: Buffer = Buffer.from("");
  const subscribers = new Set<Socket>();
  // Per-subscriber last-reported size. A subscriber that has not yet sent
  // a `resize` is absent from this map and contributes no constraint to
  // recomputeSize() (its initial paint uses pty's current cols/rows from
  // the hello message).
  const subscriberSizes = new Map<Socket, { cols: number; rows: number }>();

  // DEC private mode state — see src/core/dec-modes.ts for rationale.
  // Without this, late IPC subscribers (and downstream remote peers via
  // host-pty-shim → orchestrator) miss alt-screen / focus / mouse
  // enables that scrolled out of the ring buffer.
  const enabledDecModes = new Map<string, boolean>();

  const broadcastFrame = (chunk: Buffer): void => {
    const dataBase64 = chunk.toString("base64");
    const frame: WrapperToExtension = { type: "frame", dataBase64 };
    for (const sub of subscribers) {
      try {
        sendIpc(sub, frame);
      } catch {
        // Drop on error; the socket will close itself shortly.
      }
    }
  };

  const attachStdio = opts.attachStdio !== false;

  // Sizing model: PTY cols/rows = MIN over { host stdout (when attached),
  // every subscriber that has reported a size }. Both surfaces are then
  // ≥ PTY in both dimensions, so neither garbles regardless of which is
  // bigger; the larger surface gets letterbox/pillarbox empty space.
  // Triggered on: host stdout resize, subscriber connect, subscriber
  // resize, subscriber disconnect. When the size actually changes, the
  // new size is fanned out to all subscribers so they redraw to match.
  const recomputeSize = (): void => {
    let minCols = Number.POSITIVE_INFINITY;
    let minRows = Number.POSITIVE_INFINITY;
    if (attachStdio && process.stdout.isTTY) {
      const c = process.stdout.columns;
      const r = process.stdout.rows;
      if (c) {
        minCols = Math.min(minCols, c);
      }
      if (r) {
        minRows = Math.min(minRows, r);
      }
    }
    for (const size of subscriberSizes.values()) {
      minCols = Math.min(minCols, size.cols);
      minRows = Math.min(minRows, size.rows);
    }
    // No constraints at all (no host TTY + no subscriber sizes yet) →
    // keep current PTY size; nothing to recompute against.
    if (!Number.isFinite(minCols) || !Number.isFinite(minRows)) {
      return;
    }
    if (minCols === pty.cols && minRows === pty.rows) {
      return;
    }
    if (isDebug()) {
      process.stderr.write(`[telepathy/wrapper] resize ${minCols}x${minRows} (was ${pty.cols}x${pty.rows})\n`);
    }
    try {
      pty.resize(minCols, minRows);
    } catch {
      // Some terminals don't support resize; ignore.
    }
    const resizeMsg: WrapperToExtension = { type: "resize", cols: minCols, rows: minRows };
    for (const sub of subscribers) {
      try {
        sendIpc(sub, resizeMsg);
      } catch {
        // ignore
      }
    }
  };

  pty.onData((data) => {
    // node-pty emits already-decoded UTF-8 strings. Re-encode to UTF-8
    // bytes so the user's terminal sees the original byte stream
    // (powerline glyphs, box-drawing, etc. are multi-byte UTF-8 and get
    // mangled if we round-trip through "binary"/Latin-1).
    const chunk = encodePtyDataForReplay(data);
    if (attachStdio) {
      process.stdout.write(chunk);
    }
    trackDecModes(chunk, enabledDecModes);
    ringBuffer = appendBounded(ringBuffer, chunk, RING_BUFFER_BYTES);
    broadcastFrame(chunk);
  });

  pty.onExit((e) => {
    if (isDebug()) {
      process.stderr.write(`[telepathy/wrapper] pty.onExit fired (code=${e.exitCode}, signal=${e.signal})\n`);
    }
    // Shutdown is racy: we're about to write a chunky mode-reset string
    // to stdout, fan an "exit" frame out to every IPC subscriber, and
    // call process.exit. Any of those writes can complete asynchronously
    // with EAGAIN / EPIPE / ECONNRESET if the peer / parent's pipe is
    // already half-closed. Each of those errors normally surfaces as an
    // 'error' event on a node:net Socket; if no listener is attached at
    // the moment the event fires, Node aborts with an "Unhandled 'error'
    // event" trace and exits with code 1 — masking the child's real
    // exit code with a scary stack the user didn't cause.
    //
    // We install a process-level uncaughtException trap for the duration
    // of shutdown that swallows ONLY these benign write-time errors.
    // Anything else still propagates (we don't want to hide real bugs).
    const swallowShutdownWriteError = (err: unknown): void => {
      const code = (err as { code?: string } | null)?.code;
      const syscall = (err as { syscall?: string } | null)?.syscall;
      if (syscall === "write" && (code === "EAGAIN" || code === "EPIPE" || code === "ECONNRESET")) {
        return;
      }
      // Re-throw by removing ourselves and letting Node's default
      // handler take over.
      process.off("uncaughtException", swallowShutdownWriteError);
      throw err;
    };
    process.on("uncaughtException", swallowShutdownWriteError);

    const exitMsg: WrapperToExtension = {
      type: "exit",
      code: e.exitCode ?? null,
      signal: e.signal !== undefined ? (`SIG${e.signal}` as NodeJS.Signals) : null,
    };
    for (const sub of subscribers) {
      try {
        sendIpc(sub, exitMsg);
      } catch {
        // ignore
      }
    }
    if (attachStdio && process.stdout.isTTY) {
      // Restore the terminal to a clean state when the wrapped shell
      // exits. The wrapped TUI (Copilot CLI, vim, oh-my-posh + clink,
      // etc.) commonly enables modes the shell doesn't disable on exit
      // — leaving the user's terminal stuck (mouse-select-to-copy
      // broken, keys arriving as escape sequences, alt-screen content
      // visible). The next `telepathy host` (or any subsequent shell
      // command) inherits this broken state. We force-reset every mode
      // we know about, then clear the screen + scrollback.
      //
      // Mode resets (DECRST sequences):
      //   ?1000l ?1002l ?1003l — disable mouse tracking variants
      //   ?1006l ?1015l        — disable SGR / urxvt mouse encoding
      //   ?1004l               — disable focus reporting
      //   ?2004l               — disable bracketed paste
      //   ?9001l               — disable win32-input-mode
      //   ?1049l ?47l ?1047l   — exit alternate screen buffer (all variants)
      //   ?25h                 — show cursor (some TUIs hide it)
      //   ?7h                  — re-enable line wrap
      // Then:
      //   \x1b[2J \x1b[3J \x1b[H — erase screen, erase scrollback, home cursor
      //   \x1b[0m              — reset all SGR attributes (color, bold, ...)
      process.stdout.write(
        "\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1015l" +
        "\x1b[?1004l\x1b[?2004l\x1b[?9001l" +
        "\x1b[?1049l\x1b[?47l\x1b[?1047l" +
        "\x1b[?25h\x1b[?7h" +
        "\x1b[0m\x1b[2J\x1b[3J\x1b[H",
      );
    }
    if (opts.onChildExit) {
      opts.onChildExit(e.exitCode ?? null, exitMsg.signal);
    } else {
      // Belt-and-suspenders: process.exit should fire immediately, but
      // if some hold-the-loop-open native handle ignores it (rare,
      // node-pty + open TLS sockets have done this before), force-kill
      // ourselves a beat later. The user typed `exit` — they want out.
      process.exit(e.exitCode ?? 0);
      setTimeout(() => process.kill(process.pid, "SIGKILL"), 1500).unref();
    }
  });

  // Forward user keystrokes from wrapper's stdin → PTY (production only;
  // tests pass attachStdio:false to avoid keeping the test event loop alive
  // and to avoid corrupting the test runner's TTY).
  let stdinHandler: ((chunk: Buffer) => void) | undefined;
  let resizeHandler: (() => void) | undefined;
  if (attachStdio) {
    const reconnectInputState: ReconnectInputState = { line: "" };
    let reconnectInFlight = false;
    const runReconnect = (): void => {
      if (!opts.onReconnectRequest || reconnectInFlight) {
        return;
      }
      reconnectInFlight = true;
      Promise.resolve()
        .then(() => opts.onReconnectRequest!())
        .then((message) => {
          process.stderr.write(`\r\n${message.trimEnd()}\r\n`);
        })
        .catch((err) => {
          const msg = err instanceof Error ? err.message : String(err);
          process.stderr.write(`\r\ntelepathy reconnect failed: ${msg}\r\n`);
        })
        .finally(() => {
          reconnectInFlight = false;
        });
    };
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }
    stdinHandler = (chunk: Buffer): void => {
      const reconnectRequests = observeReconnectInput(reconnectInputState, chunk);
      pty.write(chunk.toString("utf8"));
      for (let i = 0; i < reconnectRequests; i += 1) {
        runReconnect();
      }
    };
    process.stdin.on("data", stdinHandler);
    // Host stdout resize → recompute MIN. Whether the host is currently
    // the smaller or larger surface, the new MIN gets pushed to the PTY
    // and broadcast to all walls.
    resizeHandler = (): void => {
      recomputeSize();
    };
    process.stdout.on("resize", resizeHandler);
  }

  const server = startIpcServer({
    pipePath: opts.pipePath,
    onClient: (socket) => {
      // SAFETY: attach an error handler IMMEDIATELY (before sendIpc and
      // before readIpc gets a chance to install its own). The very first
      // hello write is asynchronous; if the peer dies between accept and
      // the write completing, the resulting EAGAIN/EPIPE would surface as
      // an unhandled 'error' on this Socket and crash the host.
      socket.on("error", () => undefined);
      subscribers.add(socket);
      // Send the hello + replay so the new subscriber can paint immediately.
      const hello: WrapperToExtension = {
        type: "hello",
        cols: pty.cols,
        rows: pty.rows,
        replayBase64: buildReplayWithModes(ringBuffer, enabledDecModes),
      };
      try {
        sendIpc(socket, hello);
      } catch {
        subscribers.delete(socket);
        return;
      }
      readIpc<ExtensionToWrapper>(socket, (msg) => {
        if (msg.type === "input") {
          const data = Buffer.from(msg.dataBase64, "base64");
          pty.write(data.toString("utf8"));
        } else if (msg.type === "resize") {
          if (isDebug()) {
            process.stderr.write(`[telepathy/wrapper] subscriber resize ${msg.cols}x${msg.rows}\n`);
          }
          subscriberSizes.set(socket, { cols: msg.cols, rows: msg.rows });
          recomputeSize();
        }
      }, () => {
        subscribers.delete(socket);
        // Subscriber gone → its size constraint is lifted. Recompute MIN
        // over remaining { host stdout, other subscribers }; the PTY may
        // now grow, which the local terminal / remaining walls will pick
        // up via the broadcast resize.
        if (subscriberSizes.delete(socket)) {
          recomputeSize();
        }
      });
    },
  });

  return {
    pty,
    server,
    pipePath: opts.pipePath,
    ringBuffer,
    subscribers,
  };
}

function appendBounded(buf: Buffer, chunk: Buffer, max: number): Buffer {
  if (chunk.length >= max) {
    return Buffer.from(chunk.subarray(chunk.length - max));
  }
  const combined = Buffer.concat([buf, chunk]);
  return combined.length > max ? Buffer.from(combined.subarray(combined.length - max)) : combined;
}
