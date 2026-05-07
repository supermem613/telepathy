# telepathy architecture notes

This file captures load-bearing design decisions that aren't obvious from the
code alone. If you're about to add a new peer-side feature, a new local
control surface, or a new way for two telepathy processes to talk to each
other, **read this first.**

The repo's `README.md` is the user-facing tour; this file is the engineer's.

---

## Peer RPC rides the live TLS-PSK link

> **If a feature needs one telepathy process (CLI, app, viewer) to ask another
> for something it has, the answer almost always is: send a message over the
> existing TLS-PSK link. Do not invent a new local IPC, env var, discovery
> file, or named-pipe contract.**

### Why this matters

Telepathy is, structurally, a small distributed system: a host process owns a
ConPTY + listener; one or more peers (CLI dialer, Electron viewer, future
agents) connect over TLS-PSK. The TLS handshake itself is the
authentication boundary — successful PSK handshake means *"this party holds
the current token, therefore they are authorized to act as a peer."*

Once a TLS-PSK socket is up, both sides can exchange any
`src/core/protocol.ts` `Message` variant. That includes request/response
pairs (correlated by `id` via `core/peers.ts` `sendRequest`), fire-and-forget
events, and bidirectional streams (`pty_frame`, `pty_input`).

### Worked example: `spawn_host`

`spawn_host` (`src/core/spawn-host.ts`,
`src/core/orchestrator.ts:380`), where the Electron viewer asks the host to
launch a sibling `telepathy host` in a new terminal window.

### When to use this pattern

- Any peer-initiated action that needs the host's authority or state
  (spawn child host, future "list peers", future "set my alias", future
  "subscribe to event X").
- Any host→peer push where the peer cares (resize, exit, frame, new event).
- Anything where the alternative is "but the CLI is on the same box, surely
  there's a faster local channel" — there usually is, but it's almost
  always the wrong call because it forks the auth model.

### When NOT to use this pattern

- Wrapper ↔ in-process MCP extension PTY traffic (`core/ipc.ts`). That's a
  parent/child stdio-equivalent inside one process tree; TLS-PSK over the
  loopback would be silly.
- Anything that needs to work *before* a TLS-PSK link exists, or after the
  last peer disconnects and the single-use token is already burnt. Use the
  owner-console re-pair path instead.
- Side-channel debug printf to `stderr`. That's not RPC.

### Authentication cheat-sheet

| Action | Authentication |
|---|---|
| Dial as a peer | Hold a current valid token; complete TLS-PSK handshake. |
| Spawn a sibling host | Same. |
| Mutate PTY (input, resize) | Same. |
| Read PTY frames | Same. |
| Anything from outside the TLS-PSK boundary | Not authorized. Get a token and dial. |

### Implementation ergonomics

- New message types: add to `src/core/protocol.ts` `Message` union with
  request/ack pair where applicable.
- Server-side handler: add a `case` in
  `src/core/orchestrator.ts:handleFrameForPeer`. Mirror `spawn_host` for
  fire-and-forget; mirror the `*_ack` correlation pattern for responses.
- Client-side caller: use `core/peers.ts` `sendRequest<AckType>(peer, frame, timeoutMs)`.
- Frame routing on the dialer side is automatic via the same dispatcher;
  acks resolve through `peer.pending`.

---

## Token security model: TTL + single-use + owner-console re-pair

Every join token has two compounding constraints:

1. **Hard 10-minute TTL** (`api.ts ACCEPT_TOKEN_TTL_MS`) enforced in
   `core/transport.ts pskCallback` via the `getExpiresAt` gate.
   Past expiry, the listener returns `null` for any new handshake.
2. **Single-use** (`core/transport.ts onConsume`). The first successful
   pskCallback flips `acceptState.expiresAt` to `0`, so the very next
   handshake hits the TTL gate. Concurrent dials race; the loser fails.

The escape hatch after an app disconnect is typing `telepathy reconnect` in the
original host terminal. The wrapper observes that local stdin line and calls
`api.ts rotateListenerSecret({ ttlMs: 60_000 })`, which:

- generates a new 8-byte secret,
- swaps the live listener's PSK in place via the `setSecret` mutator
  exposed on `TelepathyServer`,
- recomputes the token (host+port unchanged),
- resets `acceptState.expiresAt = now + ttlMs`.

Because TLS-PSK derives session keys at handshake (not from the live PSK
value), **currently-connected sockets survive the swap**. Only future
handshakes are affected.

The `reconnect` CLI command is not a host-discovery client. If it runs outside
the original host terminal, it cannot locate a host or fetch a token. This keeps
token material in RAM plus the owner-visible terminal only: no env var, disk
cache, PID walk, or local control socket.

---

## Module dependency cycle (intentional, scoped)

`core/api.ts` imports from `core/orchestrator.ts` (`adoptIncoming`,
`adoptOutgoing`, etc.). Keep this one-way unless a new use is confined to
function-body references; top-level calls across a cycle can deadlock module
load.
