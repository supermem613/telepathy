// Local-only HTTP + WebSocket server that serves the browser viewer
// (xterm.js) and bridges PTY frame streams to/from the orchestrator.
//
// Bound on 127.0.0.1 with a random token in every URL — never reachable
// from the LAN, never reachable without the token. The TLS-PSK peer
// listener is the only LAN-facing surface.

import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import {
  setOrchestratorEvents,
  subscribeRemotePty,
  unsubscribeRemotePty,
  sendRemoteInput,
} from "./orchestrator.js";
import { listPeers, getPeer, type Peer } from "./peers.js";
import { connectPeer, disconnectPeer } from "./api.js";
import { randomUUID } from "node:crypto";
import { DEFAULT_VIEWER_PORT } from "./protocol.js";

export type ViewerState = {
  server: HttpServer;
  wss: WebSocketServer;
  port: number;
  token: string;
};

let viewer: ViewerState | undefined;

// Map peer alias → set of WS clients watching that peer.
const watchers = new Map<string, Set<WebSocket>>();

export function getViewerToken(): string | undefined {
  return viewer?.token;
}

export function getViewerUrl(path: string): string | undefined {
  if (!viewer) {
    return undefined;
  }
  const sep = path.includes("?") ? "&" : "?";
  return `http://127.0.0.1:${viewer.port}${path}${sep}t=${encodeURIComponent(viewer.token)}`;
}

export async function startViewer(opts: { port?: number } = {}): Promise<ViewerState> {
  if (viewer) {
    return viewer;
  }
  const token = randomBytes(16).toString("hex");
  const port = await pickFreePort(opts.port ?? DEFAULT_VIEWER_PORT);
  const staticRoot = resolveStaticRoot();

  const server = createHttpServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
    if (url.searchParams.get("t") !== token) {
      res.writeHead(401, { "Content-Type": "text/plain" });
      res.end("unauthorized");
      return;
    }
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/wall")) {
      serveFile(res, join(staticRoot, "wall.html"), "text/html");
      return;
    }
    if (req.method === "GET" && url.pathname.startsWith("/peer/")) {
      serveFile(res, join(staticRoot, "peer.html"), "text/html");
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/peers") {
      const peers = listPeers().map(toPeerInfo);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ peers }));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/connect") {
      try {
        const body = await readJsonBody<{ token?: string; alias?: string }>(req);
        if (!body.token || typeof body.token !== "string") {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "missing 'token' field" }));
          return;
        }
        const result = await connectPeer({ token: body.token, alias: body.alias });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: msg }));
      }
      return;
    }
    if (req.method === "POST" && url.pathname.startsWith("/api/disconnect/")) {
      const alias = decodeURIComponent(url.pathname.slice("/api/disconnect/".length));
      const result = disconnectPeer({ peer: alias });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
      return;
    }
    if (req.method === "GET" && url.pathname.startsWith("/static/")) {
      const sub = url.pathname.slice("/static/".length);
      const candidates = [
        join(staticRoot, sub),
        resolveModuleAsset(sub),
      ].filter((p): p is string => p !== null && existsSync(p));
      if (candidates.length > 0) {
        serveFile(res, candidates[0]!, guessMime(sub));
        return;
      }
    }
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(port, "127.0.0.1", () => resolveListen());
  });

  const wss = new WebSocketServer({ server });
  wss.on("connection", (ws, req) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
    if (url.searchParams.get("t") !== token) {
      ws.close(1008, "unauthorized");
      return;
    }
    const m = /^\/ws\/([^/]+)$/.exec(url.pathname);
    if (!m) {
      ws.close(1008, "bad path");
      return;
    }
    const alias = decodeURIComponent(m[1]!);
    const peer = getPeer(alias);
    if (!peer) {
      ws.send(JSON.stringify({ type: "error", message: `unknown peer "${alias}"` }));
      ws.close(1011, "unknown peer");
      return;
    }
    attachWatcher(alias, peer, ws);
  });

  viewer = { server, wss, port, token };
  installOrchestratorBridge();
  return viewer;
}

export function stopViewer(): boolean {
  if (!viewer) {
    return false;
  }
  for (const set of watchers.values()) {
    for (const ws of set) {
      try {
        ws.close(1001);
      } catch {
        /* ignore */
      }
    }
  }
  watchers.clear();
  viewer.wss.close();
  viewer.server.close();
  viewer = undefined;
  return true;
}

function attachWatcher(alias: string, peer: Peer, ws: WebSocket): void {
  let set = watchers.get(alias);
  if (!set) {
    set = new Set();
    watchers.set(alias, set);
  }
  set.add(ws);
  // First watcher → tell the orchestrator to subscribe upstream.
  if (set.size === 1) {
    subscribeRemotePty(peer, randomUUID());
  }
  ws.on("message", (raw) => {
    let msg: { type: string; data?: string; cols?: number; rows?: number };
    try {
      msg = JSON.parse(raw.toString("utf8")) as typeof msg;
    } catch {
      return;
    }
    if (msg.type === "input" && typeof msg.data === "string") {
      // The browser sends utf-8 strings; convert to base64 raw bytes for
      // the wire (the host will decode and inject directly into the PTY).
      const dataBase64 = Buffer.from(msg.data, "utf8").toString("base64");
      sendRemoteInput(peer, dataBase64);
    }
  });
  ws.on("close", () => {
    set!.delete(ws);
    if (set!.size === 0) {
      watchers.delete(alias);
      const stillThere = getPeer(alias);
      if (stillThere) {
        unsubscribeRemotePty(stillThere);
      }
    }
  });
}

function installOrchestratorBridge(): void {
  // Standalone build: viewer owns the orchestrator's PTY-event listeners
  // outright. Multiplex incoming frames/resizes to all connected browser
  // watchers for that peer.
  setOrchestratorEvents({
    onRemoteFrame: (peer, dataBase64) => {
      const set = watchers.get(peer.alias);
      if (!set) {
        return;
      }
      const payload = JSON.stringify({ type: "frame", data: dataBase64 });
      for (const ws of set) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(payload);
        }
      }
    },
    onRemoteResize: (peer, cols, rows) => {
      const set = watchers.get(peer.alias);
      if (!set) {
        return;
      }
      const payload = JSON.stringify({ type: "resize", cols, rows });
      for (const ws of set) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(payload);
        }
      }
    },
  });
}

function toPeerInfo(p: Peer): {
  alias: string;
  remoteAlias: string;
  remoteAddr: string;
  origin: string;
  hasPty: boolean;
} {
  return {
    alias: p.alias,
    remoteAlias: p.remoteAlias,
    remoteAddr: p.remoteAddr,
    origin: p.origin,
    hasPty: !!p.remoteCapabilities?.pty,
  };
}

async function pickFreePort(start: number): Promise<number> {
  // We accept that another telepathy instance might already own start.
  // Walk forward up to +20 looking for a free one.
  for (let p = start; p < start + 20; p++) {
    if (await isPortFree(p)) {
      return p;
    }
  }
  return start; // give up and let it error noisily on listen
}

function isPortFree(port: number): Promise<boolean> {
  return new Promise((res) => {
    const probe = createHttpServer();
    probe.once("error", () => res(false));
    probe.once("listening", () => {
      probe.close(() => res(true));
    });
    probe.listen(port, "127.0.0.1");
  });
}

function serveFile(res: import("node:http").ServerResponse, path: string, mime: string): void {
  try {
    const data = readFileSync(path);
    res.writeHead(200, { "Content-Type": mime, "Cache-Control": "no-store" });
    res.end(data);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
  }
}

function resolveStaticRoot(): string {
  // dist/core/viewer.js → ../../viewer/
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "viewer");
}

function resolveModuleAsset(sub: string): string | null {
  // Map "xterm/lib/xterm.js" → node_modules/@xterm/xterm/lib/xterm.js
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "node_modules");
  const map: Record<string, string> = {
    "xterm.js": "@xterm/xterm/lib/xterm.js",
    "xterm.css": "@xterm/xterm/css/xterm.css",
    "addon-fit.js": "@xterm/addon-fit/lib/addon-fit.js",
  };
  const rel = map[sub];
  return rel ? join(root, rel) : null;
}

function guessMime(p: string): string {
  if (p.endsWith(".html")) {
    return "text/html";
  }
  if (p.endsWith(".js")) {
    return "application/javascript";
  }
  if (p.endsWith(".css")) {
    return "text/css";
  }
  if (p.endsWith(".json")) {
    return "application/json";
  }
  return "application/octet-stream";
}

function readJsonBody<T>(req: import("node:http").IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c.toString("utf8"); 
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(raw || "{}") as T);
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}
