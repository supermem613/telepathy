// Named-pipe IPC between `telepathy host` (the ConPTY-owning wrapper) and
// the in-process MCP extension (a child of the wrapped copilot).
//
// Shape: line-delimited JSON over a single duplex pipe. Frames are simple,
// because both ends live on the same machine and the same trust boundary.
//
// Wrapper → extension:
//   { type: "frame", dataBase64 }      // PTY output bytes
//   { type: "resize", cols, rows }     // PTY resized
//   { type: "exit",  code, signal? }   // child process exited
//   { type: "hello", cols, rows, replayBase64 }   // sent on first connect
//
// Extension → wrapper:
//   { type: "input",  dataBase64 }     // inject keystrokes into the PTY
//   { type: "resize", cols, rows }     // request a resize
//
// The pipe path is exposed via the TELEPATHY_SOCKET env var.

import { createServer as createNetServer, connect as netConnect, type Server, type Socket } from "node:net";
import { createInterface } from "node:readline";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type WrapperToExtension =
  | { type: "hello"; cols: number; rows: number; replayBase64: string }
  | { type: "frame"; dataBase64: string }
  | { type: "resize"; cols: number; rows: number }
  | { type: "exit"; code: number | null; signal: NodeJS.Signals | null };

export type ExtensionToWrapper =
  | { type: "input"; dataBase64: string }
  | { type: "resize"; cols: number; rows: number };

export function buildPipePath(): string {
  // On Windows, named pipes live under \\.\pipe\<name>. On POSIX, use a
  // unix socket path under tmpdir() and let net.createServer create it.
  const id = randomBytes(8).toString("hex");
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\telepathy-${id}`;
  }
  return join(tmpdir(), `telepathy-${id}.sock`);
}

export function startIpcServer(opts: {
  pipePath: string;
  onClient: (socket: Socket) => void;
}): Server {
  const server = createNetServer((socket) => {
    opts.onClient(socket);
  });
  server.listen(opts.pipePath);
  return server;
}

export function connectIpcClient(pipePath: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = netConnect(pipePath);
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

export function sendIpc(socket: Socket, msg: WrapperToExtension | ExtensionToWrapper): void {
  socket.write(`${JSON.stringify(msg)}\n`);
}

export function readIpc<T extends WrapperToExtension | ExtensionToWrapper>(
  socket: Socket,
  onMessage: (msg: T) => void,
  onClose?: (err?: Error) => void,
): void {
  // SAFETY: readline.Interface re-emits source-stream errors. If the IPC
  // socket dies and nobody handles the bubbled 'error', Node crashes.
  const rl = createInterface({ input: socket, crlfDelay: Infinity });
  rl.on("error", () => undefined);
  rl.on("line", (line) => {
    if (!line) {
      return;
    }
    let parsed: T;
    try {
      parsed = JSON.parse(line) as T;
    } catch {
      return;
    }
    try {
      onMessage(parsed);
    } catch {
      // Handler errors don't kill the IPC channel.
    }
  });
  rl.on("close", () => onClose?.());
  socket.on("error", (err) => onClose?.(err));
}
