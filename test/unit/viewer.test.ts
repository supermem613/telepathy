import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { request as httpRequest } from "node:http";
import { WebSocket } from "ws";
import { startViewer, stopViewer, getViewerToken, getViewerUrl } from "../../src/core/viewer.js";
import { acceptStart, acceptStop, connectPeer, disconnectPeer, setLocalPty } from "../../src/core/api.js";
import { listPeers } from "../../src/core/peers.js";
import type { LocalPty } from "../../src/core/orchestrator.js";

function randomPort(): number {
  return 27000 + Math.floor(Math.random() * 2000);
}

function get(path: string, port: number): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      hostname: "127.0.0.1",
      port,
      path,
      method: "GET",
      headers: { Connection: "close" },
    }, (res) => {
      let body = "";
      res.on("data", (c) => {
        body += c.toString("utf8"); 
      });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end();
  });
}

function post(path: string, port: number, body: unknown): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? "" : JSON.stringify(body);
    const req = httpRequest({
      hostname: "127.0.0.1",
      port,
      path,
      method: "POST",
      headers: {
        Connection: "close",
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload).toString(),
      },
    }, (res) => {
      let buf = "";
      res.on("data", (c) => {
        buf += c.toString("utf8"); 
      });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: buf }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

function waitForOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for WebSocket open")), 5000);
    ws.once("open", () => {
      clearTimeout(timer);
      resolve();
    });
    ws.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function waitForFrame(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for replay frame")), 5000);
    ws.on("message", function onMessage(raw) {
      const msg = JSON.parse(raw.toString("utf8")) as { type?: string };
      if (msg.type !== "frame") {
        return;
      }
      clearTimeout(timer);
      ws.off("message", onMessage);
      resolve();
    });
    ws.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

describe("viewer HTTP server", () => {
  it("rejects requests without the token", async () => {
    const v = await startViewer();
    try {
      const r = await get("/wall", v.port);
      assert.equal(r.status, 401);
    } finally {
      stopViewer();
    }
  });

  it("rejects requests with the wrong token", async () => {
    const v = await startViewer();
    try {
      const r = await get("/wall?t=wrong", v.port);
      assert.equal(r.status, 401);
    } finally {
      stopViewer();
    }
  });

  it("serves /wall HTML with a valid token", async () => {
    const v = await startViewer();
    try {
      const r = await get(`/wall?t=${getViewerToken()}`, v.port);
      assert.equal(r.status, 200);
      assert.match(r.body, /<title>telepathy<\/title>/i);
      assert.match(r.body, /id="tabbar"/);
    } finally {
      stopViewer();
    }
  });

  it("substitutes {{TOKEN}} in /wall HTML so static <script src=...?t=...> tags pass auth (regression)", async () => {
    const v = await startViewer();
    try {
      const tk = getViewerToken()!;
      const r = await get(`/wall?t=${tk}`, v.port);
      assert.equal(r.status, 200);
      // The script tags must contain the actual token, not the literal placeholder.
      assert.equal(r.body.includes("{{TOKEN}}"), false, "wall.html still contains literal {{TOKEN}} placeholder");
      assert.match(r.body, new RegExp(`/static/xterm\\.js\\?t=${tk}`));
      assert.match(r.body, new RegExp(`/static/xterm\\.css\\?t=${tk}`));
      assert.match(r.body, new RegExp(`/static/addon-unicode11\\.js\\?t=${tk}`));
      assert.match(r.body, new RegExp(`/static/addon-fit\\.js\\?t=${tk}`));
      assert.match(r.body, /allowProposedApi: true/);
      assert.match(r.body, /term\.unicode\.activeVersion = "11"/);
    } finally {
      stopViewer();
    }
  });

  it("does not erase replayed terminal output during browser resize", async () => {
    const v = await startViewer();
    try {
      const wall = await get(`/wall?t=${getViewerToken()}`, v.port);
      const peer = await get(`/peer/box-a?t=${getViewerToken()}`, v.port);
      assert.equal(wall.status, 200);
      assert.equal(peer.status, 200);
      assert.equal(wall.body.includes("\\x1b[2J\\x1b[3J\\x1b[H"), false,
        "wall.html must not clear xterm on resize; late resize can erase replay-only CI traces");
      assert.equal(peer.body.includes("\\x1b[2J\\x1b[3J\\x1b[H"), false,
        "peer.html must not clear xterm on resize; host/TUI output owns repainting");
    } finally {
      stopViewer();
    }
  });

  it("resizes the remote PTY before subscribing browser replay", async () => {
    const order: string[] = [];
    const subscribers = new Set<(f: { dataBase64: string }) => void>();
    const addSubscriber = subscribers.add.bind(subscribers);
    subscribers.add = ((subscriber) => {
      order.push("subscribe");
      return addSubscriber(subscriber);
    }) as typeof subscribers.add;

    const localPty: LocalPty = {
      state: {
        cols: 132,
        rows: 42,
        ringBuffer: Buffer.from("Describe a task", "utf8"),
        enabledDecModes: new Map(),
        subscribers,
        resizeSubscribers: new Set(),
      },
      injectInput: () => undefined,
      requestResize: (cols, rows) => {
        order.push(`resize:${cols}x${rows}`);
      },
      close: () => undefined,
    };

    const accept = await acceptStart({ port: randomPort() });
    setLocalPty(localPty);
    let ws: WebSocket | undefined;
    try {
      const connected = await connectPeer({ token: accept.token });
      const peer = listPeers().find((p) => p.alias === connected.alias);
      assert.ok(peer, "connected peer should be available to the viewer");

      const v = await startViewer();
      ws = new WebSocket(
        `ws://127.0.0.1:${v.port}/ws/${encodeURIComponent(peer.alias)}?t=${getViewerToken()}&deferReplay=1`,
      );
      await waitForOpen(ws);
      const frame = waitForFrame(ws);
      ws.send(JSON.stringify({ type: "resize", cols: 80, rows: 24 }));
      await frame;

      assert.deepEqual(order.slice(0, 2), ["resize:80x24", "subscribe"]);
    } finally {
      ws?.close();
      stopViewer();
      setLocalPty(null);
      disconnectPeer({});
      acceptStop();
    }
  });

  it("substitutes {{TOKEN}} in /peer HTML too", async () => {
    const v = await startViewer();
    try {
      const tk = getViewerToken()!;
      const r = await get(`/peer/box-a?t=${tk}`, v.port);
      assert.equal(r.status, 200);
      assert.equal(r.body.includes("{{TOKEN}}"), false);
      assert.match(r.body, new RegExp(`/static/xterm\\.js\\?t=${tk}`));
      assert.match(r.body, new RegExp(`/static/addon-unicode11\\.js\\?t=${tk}`));
      assert.match(r.body, /allowProposedApi: true/);
      assert.match(r.body, /term\.unicode\.activeVersion = "11"/);
    } finally {
      stopViewer();
    }
  });

  it("serves /peer/<alias> HTML with a valid token", async () => {
    const v = await startViewer();
    try {
      const r = await get(`/peer/box-a?t=${getViewerToken()}`, v.port);
      assert.equal(r.status, 200);
      assert.match(r.body, /<title>telepathy attach<\/title>/i);
    } finally {
      stopViewer();
    }
  });

  it("/api/peers returns an empty list when none are connected", async () => {
    const v = await startViewer();
    try {
      const r = await get(`/api/peers?t=${getViewerToken()}`, v.port);
      assert.equal(r.status, 200);
      const parsed = JSON.parse(r.body) as { peers: unknown[] };
      assert.deepEqual(parsed.peers, []);
    } finally {
      stopViewer();
    }
  });

  it("POST /api/connect rejects an invalid token", async () => {
    const v = await startViewer();
    try {
      const r = await post(`/api/connect?t=${getViewerToken()}`, v.port, { token: "not-a-token" });
      assert.equal(r.status, 400);
      const parsed = JSON.parse(r.body) as { error: string };
      assert.match(parsed.error, /invalid join token/i);
    } finally {
      stopViewer();
    }
  });

  it("POST /api/connect rejects missing token field", async () => {
    const v = await startViewer();
    try {
      const r = await post(`/api/connect?t=${getViewerToken()}`, v.port, {});
      assert.equal(r.status, 400);
    } finally {
      stopViewer();
    }
  });

  it("POST /api/disconnect/<alias> reports zero disconnected for unknown peer", async () => {
    const v = await startViewer();
    try {
      const r = await post(`/api/disconnect/never-existed?t=${getViewerToken()}`, v.port, undefined);
      assert.equal(r.status, 200);
      const parsed = JSON.parse(r.body) as { disconnected: string[] };
      assert.deepEqual(parsed.disconnected, []);
    } finally {
      stopViewer();
    }
  });

  it("404s on unknown paths (with valid token)", async () => {
    const v = await startViewer();
    try {
      const r = await get(`/does-not-exist?t=${getViewerToken()}`, v.port);
      assert.equal(r.status, 404);
    } finally {
      stopViewer();
    }
  });

  it("getViewerUrl includes the token", async () => {
    const v = await startViewer();
    try {
      const url = getViewerUrl("/wall");
      assert.ok(url);
      assert.match(url!, /\?t=[a-f0-9]{32}$/);
      assert.equal(new URL(url!).port, String(v.port));
    } finally {
      stopViewer();
    }
  });

  it("startViewer is idempotent (same instance reused)", async () => {
    const v1 = await startViewer();
    const v2 = await startViewer();
    try {
      assert.equal(v1.port, v2.port);
      assert.equal(v1.token, v2.token);
    } finally {
      stopViewer();
    }
  });

  it("stopViewer returns false when nothing is running", () => {
    assert.equal(stopViewer(), false);
  });
});
