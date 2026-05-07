# telepathy

> Peer-to-peer terminal sharing over the LAN: expose any process under ConPTY, watch from any other box.

Two boxes on the same intranet. Box A runs `telepathy host` — its shell is now reachable on the LAN behind a TLS-PSK token. Box B runs `telepathy connect <token>` to mirror it in a browser wall (or `telepathy app` for the Electron wall with tabs, mouse selection, renaming, and one-click "spawn another shell on box A" via the per-tab ⎘ button). No cloud, no port-forward, no shared session host.

## Quick start

```bash
git clone https://github.com/<you>/telepathy.git ~/repos/telepathy
cd ~/repos/telepathy
npm install
npm run build
npm link    # makes `telepathy` available globally
```

Then on **box A** (the one whose shell you want to share):

```bash
telepathy host
# 📡 telepathy host ready
#    bound: 0.0.0.0:7423
#    addr:  192.168.1.69:7423
#    token: TLP1YCUACRI477YZWUANC5FW66Y
#    valid: 10 min, single-use
#    if the app disconnects later, type `telepathy reconnect` here to re-pair
#    waiting for a peer to connect, or press Enter / Space to start the shell now…
```

Copy the token. On **box B**:

```bash
telepathy app TLP1YCUACRI477YZWUANC5FW66Y   # opens the Electron wall pre-linked
# OR
telepathy connect TLP1YCUACRI477YZWUANC5FW66Y --term   # mirror in this terminal (Ctrl-] to detach)
```

Box A's shell spawns the moment a peer connects. From the wall: type into the active tab, watch frames stream in real time, double-click a tab label to rename it, click the per-tab ⎘ to spawn a sibling `telepathy host` in a fresh terminal window on that tab's host machine and auto-attach it as a new tab.

### Token lifecycle: TTL + single-use + re-pair

Every join token is **single-use** and has a **10-minute hard TTL** enforced server-side. The first successful TLS-PSK handshake burns the token; any subsequent dial — and any dial after the TTL expires — is rejected by the listener.

If the app disconnects but the original `telepathy host` terminal is still running, type this in that same host terminal:

```bash
telepathy reconnect
```

The wrapper observes that local typed line, rotates the listener secret in memory, and prints a fresh **60-second, single-use** re-pair token on the host terminal. The command is deliberately not a discovery client: if it runs outside the original host terminal, it cannot find a host or return a token.

What this guarantees:

- **No token cache or host discovery.** `telepathy reconnect` does not read env vars, write disk state, open a local socket, or fetch a token.
- **Owner-console authority.** Re-pair is initiated only from the original host terminal's local stdin path. Remote peer input and child process output do not trigger it.
- **Live peer sessions survive.** TLS-PSK derives session keys at handshake; rotating the listener's PSK does not rekey live sockets.
- **The old token dies immediately.** New dials with it fail. The re-pair token is the only valid token for the next dial, and it is single-use too.

## Commands

| Command | What it does |
|---|---|
| `telepathy host` | Wrap your shell (or any command after `--`) under ConPTY, bind a TLS-PSK listener, print a join token |
| `telepathy connect <token>` | Link to a host's wall in a browser (default), or mirror it in this terminal with `--term` |
| `telepathy app [tokens...]` | Open the Electron wall viewer; auto-links any tokens passed as args. Each tab has a ⎘ button that asks the tab's host machine to spawn a sibling `telepathy host` in a fresh terminal window and auto-attaches it as a new tab (Windows host only) |
| `telepathy reconnect` | Re-pair a disconnected app when typed in the original host terminal |
| `telepathy doctor` | Preflight: node version, node-pty availability, default port reachability, browser launcher |
| `telepathy install-shortcut` | Windows-only: create a Start-menu shortcut for `telepathy app` you can pin to taskbar (`--uninstall` to remove) |
| `telepathy update` | Pull the latest commits, `npm install`, and rebuild the local telepathy clone in place |

Bare `telepathy` prints version + the full help. `telepathy <command> --help` for per-command flags. `telepathy --debug <command>` enables verbose stderr traces from the orchestrator and PTY wrapper.

### Common flag patterns

```bash
telepathy host -p 7430                                # pin a specific port (default tries 7423, falls back to a random free port)
telepathy host --no-listen -- node my-tui.js          # wrap a command without exposing it on the LAN
telepathy host -- pwsh -NoProfile                     # wrap a specific shell (everything after `--` is the child command)
telepathy connect <token> --as box-a                  # rename the local peer alias
telepathy connect <token> --term                      # raw stdin/stdout PTY mirror; Ctrl-] to detach
telepathy reconnect                                   # type in the original host terminal to mint a short-lived re-pair token
telepathy doctor                                      # check the install
```

## Conventions

- **Lean deps.** Runtime deps stay small (currently 3: chalk, commander, zod).
  Add a runtime dep only with a clear reason — every dep is supply-chain risk.
- **`doctor` first.** Every CLI ships a `doctor` command that returns
  `CheckResult[]` (name, ok, detail, hint). Hints carry remediation text.
- **`--json` everywhere** that produces output meant for scripting (`doctor`).
- **Plan → preview → confirm → apply** for any command that mutates state on
  disk or remote. Silent auto-apply is an anti-pattern.
- **No env vars for behavior.** Everything is CLI-flag driven (`--debug`,
  `--port`, `--bind`, etc.). Env vars are invisible global state.

## Development

```bash
npm run build               # tsc -> dist/
npm run lint                # eslint + tsc --noEmit (src + test)
npm test                    # all tests (unit + integration; ~28s on Windows)
npm run test:unit           # unit only (fast, hermetic)
npm run test:integration    # Electron + ConPTY end-to-end (slower)
npm run clean               # remove dist/
```

CI runs on Ubuntu + Windows via GitHub Actions (`.github/workflows/ci.yml`).

→ Test conventions and runner internals: [`docs/testing.md`](docs/testing.md)
→ Architecture notes (owner-console re-pair; token security model): [`docs/architecture.md`](docs/architecture.md)

## Project structure

```
src/
  cli.ts                  Entry point — Commander.js dispatcher
  commands/               One file per CLI verb (host, connect, app, reconnect, …)
  core/                   Orchestrator, transport (TLS-PSK), PTY wrapper, IPC, viewer
electron/
  main.cjs                Electron shell + in-process wall HTTP+WS server
viewer/
  wall.html               Tabbed multi-peer viewer (xterm.js + WebSocket per tab)
  peer.html               Single-peer attach view
assets/
  icon.png / icon.ico     App icon (regenerated by scripts/generate-icon.py)
scripts/
  generate-icon.py        Pillow-based icon generator
test/
  unit/                   Unit tests (*.test.ts) — HOME-sandboxed
  integration/            Playwright + ConPTY end-to-end tests
  run.mjs                 Cross-platform test runner
```

## License

MIT
