import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { addPeer, getPeer, listPeers, pickAlias, removePeer } from "../../src/core/peers.js";
import type { Peer } from "../../src/core/peers.js";
import type { TLSSocket } from "node:tls";

function fakeSocket(): TLSSocket {
  // Minimal stub — peers.ts uses .end() and pending Map only.
  return {
    end: () => undefined,
    on: () => undefined,
    once: () => undefined,
    write: () => true,
    remoteAddress: "127.0.0.1",
    remotePort: 65000,
  } as unknown as TLSSocket;
}

function makePeer(alias: string): Peer {
  return {
    alias,
    remoteAlias: alias,
    socket: fakeSocket(),
    status: "connected",
    origin: "accepted",
    remoteAddr: "127.0.0.1:65000",
    connectedAt: Date.now(),
    pending: new Map(),
  };
}

describe("peers.addPeer / getPeer / listPeers / removePeer", () => {
  it("round-trips a peer", () => {
    const alias = `t-${Math.random().toString(36).slice(2, 8)}`;
    addPeer(makePeer(alias));
    assert.ok(getPeer(alias));
    assert.equal(listPeers().some((p) => p.alias === alias), true);
    removePeer(alias);
    assert.equal(getPeer(alias), undefined);
  });

  it("removePeer returns the removed peer", () => {
    const alias = `t-${Math.random().toString(36).slice(2, 8)}`;
    addPeer(makePeer(alias));
    const removed = removePeer(alias);
    assert.ok(removed);
    assert.equal(removed!.alias, alias);
  });

  it("removePeer of unknown alias returns undefined", () => {
    assert.equal(removePeer("never-existed-12345"), undefined);
  });
});

describe("peers.pickAlias", () => {
  it("returns the requested alias when free", () => {
    const alias = `free-${Math.random().toString(36).slice(2, 8)}`;
    assert.equal(pickAlias(alias, "fallback"), alias);
  });

  it("falls back when requested is empty", () => {
    const fallback = `fb-${Math.random().toString(36).slice(2, 8)}`;
    assert.equal(pickAlias(undefined, fallback), fallback);
    assert.equal(pickAlias("   ", fallback), fallback);
  });

  it("disambiguates on collision", () => {
    const base = `dup-${Math.random().toString(36).slice(2, 8)}`;
    addPeer(makePeer(base));
    const next = pickAlias(base, "fallback");
    assert.equal(next, `${base}-2`);
    addPeer(makePeer(next));
    const third = pickAlias(base, "fallback");
    assert.equal(third, `${base}-3`);
    removePeer(base);
    removePeer(next);
  });
});
