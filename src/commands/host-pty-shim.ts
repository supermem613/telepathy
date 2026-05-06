// Reattaches the in-process orchestrator API to the wrapper's IPC pipe.
// Mirrors what the copilot-extension version did, minus the SDK glue.
//
// The wrapper exposes a named-pipe IPC where the first message is a
// `hello` (cols/rows/replay), then `frame`/`resize` messages stream live.
// We expose a LocalPty object the orchestrator can serve to remote peers.

import { connectIpcClient, sendIpc, readIpc, type WrapperToExtension, type ExtensionToWrapper } from "../core/ipc.js";
import type { Socket } from "node:net";
import type { LocalPty } from "../core/orchestrator.js";

const RING_BUFFER_BYTES = 64 * 1024;

export async function attachToWrapperIfPresent(pipePath?: string): Promise<LocalPty | null> {
  const pipe = pipePath ?? process.env.TELEPATHY_SOCKET;
  if (!pipe) {
    return null;
  }
  let socket: Socket;
  try {
    socket = await connectIpcClient(pipe);
  } catch {
    return null;
  }
  const state: LocalPty["state"] = {
    cols: process.stdout.columns ?? 132,
    rows: process.stdout.rows ?? 42,
    ringBuffer: Buffer.from(""),
    subscribers: new Set(),
    resizeSubscribers: new Set(),
  };
  readIpc<WrapperToExtension>(socket, (msg) => {
    if (msg.type === "hello") {
      state.cols = msg.cols;
      state.rows = msg.rows;
      state.ringBuffer = Buffer.from(msg.replayBase64, "base64");
    } else if (msg.type === "frame") {
      const chunk = Buffer.from(msg.dataBase64, "base64");
      state.ringBuffer = appendBounded(state.ringBuffer, chunk, RING_BUFFER_BYTES);
      for (const sub of state.subscribers) {
        try {
          sub({ dataBase64: msg.dataBase64 });
        } catch {
          // ignore
        }
      }
    } else if (msg.type === "resize") {
      state.cols = msg.cols;
      state.rows = msg.rows;
      for (const sub of state.resizeSubscribers) {
        try {
          sub({ cols: msg.cols, rows: msg.rows });
        } catch {
          // ignore
        }
      }
    }
  }, () => {
    socket.destroy();
  });
  return {
    state,
    injectInput: (dataBase64) => {
      const msg: ExtensionToWrapper = { type: "input", dataBase64 };
      try {
        sendIpc(socket, msg);
      } catch {
        // ignore
      }
    },
    requestResize: (cols, rows) => {
      const msg: ExtensionToWrapper = { type: "resize", cols, rows };
      try {
        sendIpc(socket, msg);
      } catch {
        // ignore
      }
    },
    close: () => {
      try {
        socket.end();
      } catch {
        // ignore
      }
    },
  };
}

function appendBounded(buf: Buffer, chunk: Buffer, max: number): Buffer {
  if (chunk.length >= max) {
    return Buffer.from(chunk.subarray(chunk.length - max));
  }
  const combined = Buffer.concat([buf, chunk]);
  return combined.length > max ? Buffer.from(combined.subarray(combined.length - max)) : combined;
}
