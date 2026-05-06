// Wire protocol between telepathy peers. Line-delimited JSON over TLS-PSK.
// All messages share an envelope: { type, id?, ...payload }.
// `id` correlates request/response for send/result and ping/pong.

export type HelloMessage = {
  type: "hello";
  alias: string;            // Sender's chosen identity (hostname or override)
  protocolVersion: 1;
  capabilities?: {
    pty?: boolean;          // Can serve PTY frames (Phase 2)
  };
};

export type HelloAckMessage = {
  type: "hello_ack";
  alias: string;            // Receiver's identity
  protocolVersion: 1;
  capabilities?: {
    pty?: boolean;
  };
};

export type SendMessage = {
  type: "send";
  id: string;
  prompt: string;
};

export type SendResultMessage = {
  type: "send_result";
  id: string;
  ok: boolean;
  text?: string;            // Final agent response text on success
  error?: string;           // Error message on failure
  events?: ActivityEvent[]; // Tool calls, edits, shell commands observed
};

export type NotifyMessage = {
  type: "notify";
  id: string;
  message: string;
};

export type NotifyAckMessage = {
  type: "notify_ack";
  id: string;
};

export type PingMessage = { type: "ping"; id: string };
export type PongMessage = { type: "pong"; id: string };

export type ErrorMessage = {
  type: "error";
  id?: string;
  message: string;
};

export type ActivityEvent = {
  ts: number;               // ms since epoch
  kind: "tool_call" | "tool_result" | "thinking" | "text";
  summary: string;          // Short human-readable description
};

// PTY mirror messages (Phase 2). The accept side fans frames out to all
// subscribers; subscribers (clients) send keystrokes back as pty_input
// when their viewer is in input-mode.

export type PtySubscribeMessage = {
  type: "pty_subscribe";
  id: string;
};

export type PtySubscribeAckMessage = {
  type: "pty_subscribe_ack";
  id: string;
  ok: boolean;
  cols?: number;
  rows?: number;
  replayBase64?: string;    // Last N bytes from the host's ring buffer (for instant first paint)
  error?: string;
};

export type PtyFrameMessage = {
  type: "pty_frame";
  dataBase64: string;       // raw PTY output bytes
};

export type PtyInputMessage = {
  type: "pty_input";
  dataBase64: string;       // raw bytes to inject into the PTY
};

export type PtyResizeMessage = {
  type: "pty_resize";
  cols: number;
  rows: number;
};

// Sent by the dialer (viewer) to the host when xterm resizes, so the
// host's PTY can match. Without this the host renders for whatever
// cols/rows the wrapper allocated at startup, and TUI apps with
// bottom-anchored prompts (Copilot CLI, htop, vim) draw their UI off
// the actual visible viewport.
export type PtyInputResizeMessage = {
  type: "pty_input_resize";
  cols: number;
  rows: number;
};

export type PtyUnsubscribeMessage = {
  type: "pty_unsubscribe";
};

// `spawn_host` — request the remote peer to spawn a fresh `telepathy host`
// process in a new visible OS terminal window on its machine, and return
// the new host's join token so we can attach a second peer link to the
// same box. Currently Windows-only on the host side; the protocol itself
// is platform-neutral and POSIX support can drop in later.
//
// Flow: viewer → host (spawn_host) → host runs launcher → child host
// reports its token via a host-local named pipe → host → viewer
// (spawn_host_ack {token}). Viewer then pipes the token through its
// existing /api/connect path.
export type SpawnHostMessage = {
  type: "spawn_host";
  id: string;
};

export type SpawnHostAckMessage = {
  type: "spawn_host_ack";
  id: string;
  ok: boolean;
  token?: string;          // TLP1… on success
  error?: string;          // human-readable failure reason
};

export type Message =
  | HelloMessage
  | HelloAckMessage
  | SendMessage
  | SendResultMessage
  | NotifyMessage
  | NotifyAckMessage
  | PingMessage
  | PongMessage
  | ErrorMessage
  | PtySubscribeMessage
  | PtySubscribeAckMessage
  | PtyFrameMessage
  | PtyInputMessage
  | PtyResizeMessage
  | PtyInputResizeMessage
  | PtyUnsubscribeMessage
  | SpawnHostMessage
  | SpawnHostAckMessage;

export const PROTOCOL_VERSION = 1;
export const DEFAULT_PORT = 7423;
export const DEFAULT_VIEWER_PORT = 7424;
