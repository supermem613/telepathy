# Testing telepathy

Telepathy uses Node's built-in test runner with [tsx](https://github.com/privatenumber/tsx) for TypeScript execution, plus [Playwright](https://playwright.dev/) for end-to-end tests that drive a real Electron BrowserWindow.

## Running tests

```bash
npm test                 # everything (unit + integration)
npm run test:unit        # unit tests only (fast, hermetic)
npm run test:integration # Electron + ConPTY end-to-end (slower)
```

Typical timings on Windows: unit ~23s, integration ~5s, full ~28s.

## Test structure

```
test/
├── unit/                              # Fast, isolated, no native subprocesses
│   ├── auth.test.ts                   # PSK derivation, cross-runtime cipher whitelist
│   ├── cli.test.ts                    # Bare-run banner, --version/--help shape
│   ├── host.test.ts                   # classifyHoldInput escape-sequence policy
│   ├── ipc.test.ts                    # Wrapper ↔ extension named-pipe round-trip
│   ├── mtls.test.ts                   # TOFU cert generation + fingerprint pinning
│   ├── orchestrator.test.ts           # Deferred pty_subscribe, listener merge, dialer disconnect
│   ├── peers.test.ts                  # Peer registry add/remove/dedup
│   ├── protocol.test.ts               # Message-type union exhaustiveness
│   ├── pty-wrapper.test.ts            # node-pty subprocess + IPC stream
│   ├── token.test.ts                  # Token encode/decode/format
│   ├── reconnect-cmd.test.ts          # `telepathy reconnect` CLI shape: no token, no discovery, host-terminal help
│   ├── transport.test.ts              # TLS-PSK accept + dial round-trip, hard-TTL gate, single-use onConsume, setSecret PSK swap
│   └── viewer.test.ts                 # HTTP+WS server: token gate, /api/*, HTML substitution
├── integration/                       # Real CLI subprocess + real Electron window
│   ├── echo-bot.cjs                   # Wrapped subprocess used by Playwright E2E
│   └── electron-input.test.ts         # End-to-end: type → echo round-trip via xterm
└── run.mjs                            # Cross-platform glob runner with HOME sandbox
```

## Writing tests

```ts
import { describe, it } from "node:test";
import { strict as assert } from "node:assert";

describe("myFeature", () => {
  it("does the expected thing", () => {
    assert.equal(myFeature("input"), "expected");
  });
});
```

Both `node:test` and Playwright are imported as plain ESM. No `@playwright/test` runner needed — we keep one runner for everything.

## Tenets

These are non-negotiable. Each one was learned from a regression that wasted real time.

### Tenet 1: tests must never touch `~/.copilot/extensions/telepathy` or the repo dist

Tests must not create, modify, or delete files inside the telepathy repo or in any directory the developer's running telepathy uses (`~/.copilot/extensions/telepathy`, `~/.telepathy`, etc.). Use `os.tmpdir()` for any state. The test runner enforces this by sandboxing `HOME`/`USERPROFILE`/`LOCALAPPDATA` to a throwaway directory (see Tenet 2).

### Tenet 2: tests must never pass locally and fail in CI

If a test passes on your machine but fails in CI, the test is not detecting a CI bug — the test is broken. CI is authoritative; your machine is the lying one. The usual culprit is implicit dependence on developer state (a real config file, an installed Nerd Font, a configured git user, an env var), which the test reads without declaring.

To make local runs match CI, `test/run.mjs` stubs `HOME`/`USERPROFILE`/`LOCALAPPDATA` to a throwaway directory before spawning **unit** tests. **Do not work around this** for unit tests — fix the test to be hermetic instead.

For ad-hoc debugging against your real home:

```bash
TELEPATHY_TEST_REAL_HOME=1 npm test
```

Required properties of every unit test:

- **No reads** of `process.env.HOME`, `os.homedir()`, `~/...`, network endpoints, or any path outside the test's own temp dir, unless the test sets that state itself first.
- **No writes** anywhere except a directory the test created under `os.tmpdir()`.
- **Identical exit code** whether run locally or in CI.

### Tenet 3: integration tests opt out of the HOME sandbox

Integration tests spawn long-lived children (Electron, ConPTY-wrapped subprocesses) whose user-data paths depend on the **real** `USERPROFILE`/`HOME`. With a sandboxed `HOME`, Electron deadlocks on userData dir creation, ConPTY wrappers fail to find `pwsh.exe`, and node-pty native bindings can't locate their cache.

`test/run.mjs` automatically detects integration tests by file path (anything under `test/integration/`) and skips the HOME sandbox for those files only. Unit tests in the same `npm test` run still get the sandbox. Don't put unit-style assertions in `test/integration/` files just to bypass the sandbox — fix the test to be sandbox-friendly.

### Tenet 4: prefer the API over the CLI; prefer the CLI over Electron

Test surface from the inside out:

1. **API-level** (`src/core/api.ts`, `transport.ts`, `orchestrator.ts`) — fast, hermetic, easy to mock. Use for protocol, transport, registry behavior.
2. **CLI-level** (subprocess of `node dist/cli.js host -- ...`) — exercises the wrapper + ConPTY + IPC. Use for shell-spawn behavior, hold-loop semantics, banner formatting.
3. **Electron-level** (Playwright `_electron.launch(...)`) — exercises the full UI + WS + xterm path. Use only for behavior that depends on the actual BrowserWindow/xterm rendering; everything else is faster and more reliable at the lower layers.

Don't reach for Electron when an API test would catch the same bug. The `wall.html` typing regression was an Electron test because the bug literally lived in browser-side JS. The TLS handshake regression is an API test because it lives in `transport.ts`.

### Tenet 5: never use blind waits — poll instead

`setTimeout(..., N)` as a "give it time to settle" wait is a regression in waiting. It's slow when the system is fast and unreliable when the system is slow. Always poll a real condition with a hard timeout:

```ts
async function waitFor(predicate, opts = {}) {
  const timeout = opts.timeout ?? 30_000;
  const interval = opts.interval ?? 100;
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(`waitFor timed out after ${timeout}ms${opts.what ? `: ${opts.what}` : ""}`);
}
```

Cap individual polls at 3 minutes max. For longer operations, loop with progress logging between polls.

## Patterns

### Cross-runtime crypto compatibility (TLS-PSK)

Telepathy speaks TLS-PSK between Node-OpenSSL hosts and Electron-BoringSSL viewers. The two stacks ship **different PSK cipher sets** — picking one that's only in Node causes `NO_CIPHER_MATCH` when the viewer dials. The intersection is locked in by `test/unit/auth.test.ts`:

```ts
it("only contains ciphers in the Node-OpenSSL ↔ Electron-BoringSSL intersection", async () => {
  const { PSK_CIPHERS } = await import("../../src/core/auth.js");
  const tls = await import("node:tls");
  const nodeCiphers = new Set(tls.getCiphers());
  const electronCiphers = new Set([
    "ecdhe-psk-aes128-cbc-sha", "ecdhe-psk-aes256-cbc-sha",
    "ecdhe-psk-chacha20-poly1305",
    "psk-aes128-cbc-sha", "psk-aes256-cbc-sha",
  ]);
  for (const cipher of PSK_CIPHERS.split(":")) {
    const lower = cipher.toLowerCase();
    assert.ok(nodeCiphers.has(lower), `Node OpenSSL doesn't have ${cipher}`);
    assert.ok(electronCiphers.has(lower), `Electron BoringSSL doesn't have ${cipher}`);
  }
});
```

When updating Electron, re-run this test. If it fails, refresh the `electronCiphers` set (verify with `electron --version` then enumerate via a one-shot main.cjs that prints `tls.getCiphers().filter(c => c.includes('psk'))`).

### Server-side regressions for racy state

The orchestrator uses deferred queues (e.g. `pendingPtySubscribes` for peers that connect during the host's hold-for-keypress phase). Always pin these with a unit test that simulates the race:

```ts
it("queues subscribe when no localPty, drains on setLocalPty", async () => {
  const accept = await acceptStart({ port });
  setLocalPty(null);
  const dialer = await connectPeer({ token: accept.token });
  subscribeRemotePty(dialerPeer, "test-sub-1");
  await new Promise((r) => setTimeout(r, 100));
  setLocalPty(fakeLocalPty());
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(pty.state.subscribers.size, 1);
});
```

### Electron end-to-end via Playwright

`test/integration/electron-input.test.ts` is the template. Three steps:

```ts
import { _electron as electron } from "playwright";

// 1. Spawn telepathy host wrapping a known echo-bot
const host = spawn(process.execPath,
  [resolve(ROOT, "dist/cli.js"), "host", "-p", String(port),
   "--", process.execPath, ECHO_BOT],
  { stdio: ["pipe", "pipe", "pipe"] });

// 2. Capture the join token from stderr
await waitFor(() => /token: (TLP1[A-Z2-7]+)/.test(hostStderr));
const token = /token: (TLP1[A-Z2-7]+)/.exec(hostStderr)![1];
host.stdin.write("a\n");  // release the hold

// 3. Drive Electron with Playwright
const app = await electron.launch({
  args: [resolve(ROOT, "electron/main.cjs"), `--token=${token}`],
  cwd: ROOT,
});
const page = await app.firstWindow();
await page.waitForSelector(".tab", { timeout: 10_000 });
await page.click(".term-host.active");
await page.keyboard.type("ping");
await page.keyboard.press("Enter");
await waitForAsync(async () => {
  const text = await page.evaluate(() => document.body.innerText);
  return text.includes("echo:ping");
});
```

**Cleanup tip**: Electron + node-pty native handles can keep the test process alive after the test passes. Use a small `setTimeout(() => process.exit(0), 500).unref()` inside the `after` hook (after `app.close()` and `host.kill()` have run) so node:test's TAP report flushes and then the process is forcibly terminated. Without this, `npm run test:integration` hangs even though the test logically passed.

### Random ports

Tests that bind sockets must use random high ports:

```ts
function randomPort() { return 18000 + Math.floor(Math.random() * 2000); }
```

Don't use the default `7423` — collisions with the developer's running telepathy will make the test fail with `EADDRINUSE` in confusing ways. The accept-side test in `transport.test.ts` is a worked example.

### node-pty cleanup in tests

`startWrapper` calls `process.exit(code)` on child exit by default — fine for production, fatal for tests (it kills the test runner). Tests pass `onChildExit` to override and `attachStdio: false` to avoid hooking the test runner's stdin/stdout:

```ts
const wrapper = await startWrapper({
  pipePath, command, args, cwd, env,
  attachStdio: false,
  onChildExit: (code) => { exitCode = code; resolve(); },
});
```

### Token format regressions

Tokens are user-pasted strings. The format has shifted twice (added prefix, dropped dashes, dropped dot). Each shift left at least one stale placeholder somewhere — modal hints, README examples, error messages. When changing the format, grep the repo for the old format and update everywhere, then run all tests:

```bash
git grep -F "TLP1." -- ":!docs/" ":!CHANGELOG"
```

## Test runner internals (`test/run.mjs`)

The runner enforces hermeticity. The next editor must preserve:

- **HOME sandbox.** `HOME`, `USERPROFILE`, and `LOCALAPPDATA` are pointed at a tmpdir for unit tests. Opt-out via `TELEPATHY_TEST_REAL_HOME=1` (or by placing the test in `test/integration/`).
- **No `node --test` worker subprocesses.** `--test`'s IPC pipe intermittently fails on Windows runners with "Unable to deserialize cloned data" errors. The runner uses `node --import tsx --test-reporter=tap <file>` so node:test auto-starts in-process. Do not switch back to `--test`.
- **TAP aggregation.** The runner parses `# tests/# pass/# fail` lines from each file's TAP output, prints compact `# ok <file> (<pass>/<tests> tests)` lines for passing files, preserves full TAP for failing files, and prints a single `# AGGREGATE` summary before exiting non-zero if any file failed.
- **Per-file env.** Each test file gets its own env built by `envForFile(file)` so unit + integration tests run correctly in the same `npm test` invocation.

## What NOT to test

- Don't write tests for Electron's own behavior (BrowserWindow placement, menu rendering). Those are Electron's responsibility, not ours.
- Don't test xterm.js's rendering. We rely on it; if it breaks we'd see it instantly.
- Don't write tests that require a Nerd Font to be installed. The font chain falls back gracefully; coverage of "did the right glyph render" is out of scope.
- Don't write tests against a real remote machine. Use loopback (`127.0.0.1` or the listener's `0.0.0.0` bind) for everything.
