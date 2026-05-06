// Wrapper-side PTY broker. Allocates a ConPTY, spawns the child program
// under it, tees PTY frames to (a) the wrapper's own stdout (so the user
// sees the live session) and (b) every connected IPC subscriber (the
// extension reads frames here and re-broadcasts to remote peers).
//
// node-pty is a native module; we import lazily so a missing/broken build
// degrades gracefully — `telepathy host` falls back to a non-mirrored
// passthrough and emits a friendly diagnostic.

import { startIpcServer, sendIpc, readIpc, type WrapperToExtension, type ExtensionToWrapper } from "./ipc.js";
import type { Server, Socket } from "node:net";

export type Pty = {
  onData(handler: (data: string) => void): void;
  onExit(handler: (e: { exitCode: number; signal?: number }) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  cols: number;
  rows: number;
};

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
};

export async function startWrapper(opts: StartWrapperOptions): Promise<WrapperState | null> {
  const ptyMod = await tryLoadPty();
  if (!ptyMod) {
    return null;
  }
  const cols = process.stdout.columns ?? 132;
  const rows = process.stdout.rows ?? 42;
  const pty = ptyMod.spawn(opts.command, opts.args, {
    name: "xterm-256color",
    cols,
    rows,
    cwd: opts.cwd,
    env: opts.env,
  });
  let ringBuffer: Buffer = Buffer.from("");
  const subscribers = new Set<Socket>();

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

  pty.onData((data) => {
    // node-pty emits already-decoded UTF-8 strings. Re-encode to UTF-8
    // bytes so the user's terminal sees the original byte stream
    // (powerline glyphs, box-drawing, etc. are multi-byte UTF-8 and get
    // mangled if we round-trip through "binary"/Latin-1).
    const chunk = Buffer.from(data, "utf8");
    if (attachStdio) {
      process.stdout.write(chunk);
    }
    ringBuffer = appendBounded(ringBuffer, chunk, RING_BUFFER_BYTES);
    broadcastFrame(chunk);
  });

  pty.onExit((e) => {
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
    if (opts.onChildExit) {
      opts.onChildExit(e.exitCode ?? null, exitMsg.signal);
    } else {
      process.exit(e.exitCode ?? 0);
    }
  });

  // Forward user keystrokes from wrapper's stdin → PTY (production only;
  // tests pass attachStdio:false to avoid keeping the test event loop alive
  // and to avoid corrupting the test runner's TTY).
  let stdinHandler: ((chunk: Buffer) => void) | undefined;
  let resizeHandler: (() => void) | undefined;
  if (attachStdio) {
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }
    stdinHandler = (chunk: Buffer): void => {
      pty.write(chunk.toString("utf8"));
    };
    process.stdin.on("data", stdinHandler);
    resizeHandler = (): void => {
      const newCols = process.stdout.columns ?? cols;
      const newRows = process.stdout.rows ?? rows;
      try {
        pty.resize(newCols, newRows);
      } catch {
        // Some terminals don't support resize; ignore.
      }
      const resizeMsg: WrapperToExtension = { type: "resize", cols: newCols, rows: newRows };
      for (const sub of subscribers) {
        try {
          sendIpc(sub, resizeMsg);
        } catch {
          // ignore
        }
      }
    };
    process.stdout.on("resize", resizeHandler);
  }

  const server = startIpcServer({
    pipePath: opts.pipePath,
    onClient: (socket) => {
      subscribers.add(socket);
      // Send the hello + replay so the new subscriber can paint immediately.
      const hello: WrapperToExtension = {
        type: "hello",
        cols: pty.cols,
        rows: pty.rows,
        replayBase64: ringBuffer.toString("base64"),
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
          try {
            pty.resize(msg.cols, msg.rows);
          } catch {
            // ignore
          }
        }
      }, () => {
        subscribers.delete(socket);
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
