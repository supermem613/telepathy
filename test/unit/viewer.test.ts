import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { request as httpRequest } from "node:http";
import { startViewer, stopViewer, getViewerToken, getViewerUrl } from "../../src/core/viewer.js";

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
      assert.match(r.body, /<title>telepathy wall<\/title>/i);
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
