import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { buildPtySpawnOptions, encodePtyDataForReplay, observeReconnectInput, startWrapper, type ReconnectInputState } from "../../src/core/pty-wrapper.js";
import { connectIpcClient, readIpc, type WrapperToExtension } from "../../src/core/ipc.js";
import { buildPipePath } from "../../src/core/ipc.js";

let ptyAvailable = true;
try {
  await import("node-pty");
} catch {
  ptyAvailable = false;
}

describe("pty-wrapper reconnect input observer", () => {
  it("detects the local typed reconnect command on Enter", () => {
    const state: ReconnectInputState = { line: "" };
    assert.equal(observeReconnectInput(state, Buffer.from("telepathy reconnect\r", "utf8")), 1);
    assert.equal(state.line, "");
  });

  it("accepts the explicit owner-console prefix variant", () => {
    const state: ReconnectInputState = { line: "" };
    assert.equal(observeReconnectInput(state, Buffer.from(":telepathy reconnect\n", "utf8")), 1);
  });

  it("does not trigger on output-like text or remote command arguments", () => {
    const state: ReconnectInputState = { line: "" };
    assert.equal(observeReconnectInput(state, Buffer.from("echo telepathy reconnect\r", "utf8")), 0);
    assert.equal(observeReconnectInput(state, Buffer.from("telepathy reconnect --json\r", "utf8")), 0);
  });

  it("supports simple backspace while observing local input", () => {
    const state: ReconnectInputState = { line: "" };
    assert.equal(observeReconnectInput(state, Buffer.from("telepathy reconnectx\x7f\r", "utf8")), 1);
  });
});

describe("pty-wrapper PTY output encoding", () => {
  it("requests raw node-pty output bytes instead of decoded strings", () => {
    const opts = buildPtySpawnOptions({
      pipePath: "ignored",
      command: process.execPath,
      args: [],
      cwd: process.cwd(),
      env: {},
    }, 80, 24);
    assert.equal((opts as { encoding?: string | null }).encoding, null);
  });

  it("preserves raw node-pty Buffer output bytes for Unicode terminal glyphs", () => {
    const bytes = Buffer.from("─❯● Copilot uses AI", "utf8");
    assert.deepEqual(encodePtyDataForReplay(bytes), bytes);
  });

  it("repairs Windows ConPTY CP437-mojibaked UTF-8 string output", () => {
    const bytes = Buffer.from("─❯● Copilot uses AI", "utf8");
    assert.deepEqual(encodePtyDataForReplay("ΓöÇΓ¥»ΓùÅ Copilot uses AI"), bytes);
  });

  it("repairs Windows ConPTY CP437-mojibaked UTF-8 Buffer output", () => {
    const bytes = Buffer.from("─❯● Copilot uses AI", "utf8");
    assert.deepEqual(encodePtyDataForReplay(Buffer.from("ΓöÇΓ¥»ΓùÅ Copilot uses AI", "utf8")), bytes);
  });

  it("leaves normal Unicode string output encoded as UTF-8", () => {
    assert.deepEqual(encodePtyDataForReplay("Café"), Buffer.from("Café", "utf8"));
  });
});

describe("pty-wrapper IPC end-to-end", () => {
  it("sends hello with cols/rows on connect, then streams frames", async (t) => {
    if (!ptyAvailable) {
      t.skip("node-pty not available");
      return;
    }
    // Start a fresh wrapper just for this test, so we control its lifetime.
    const localPipe = buildPipePath();
    let exitCode: number | null = -1;
    const exitSeen = new Promise<void>((resolve) => {
      const localWrapper = startWrapper({
        pipePath: localPipe,
        command: process.execPath,
        // Print 5 ticks then exit cleanly.
        args: ["-e", "for(let i=0;i<5;i++)process.stdout.write('tick'+i+'\\n')"],
        cwd: process.cwd(),
        env: process.env as Record<string, string | undefined>,
        attachStdio: false,
        onChildExit: (code) => {
          exitCode = code;
          try {
            localWrapper.then((w) => w?.server.close()); 
          } catch { /* ignore */ }
          resolve();
        },
      });
    });
    await new Promise((r) => setTimeout(r, 50)); // let server bind
    const sock = await connectIpcClient(localPipe);
    const messages: WrapperToExtension[] = [];
    let helloResolve: () => void;
    const gotHello = new Promise<void>((r) => {
      helloResolve = r; 
    });
    let tickResolve: () => void;
    const sawTick = new Promise<void>((r) => {
      tickResolve = r; 
    });
    let tickFound = false;
    readIpc<WrapperToExtension>(sock, (msg) => {
      messages.push(msg);
      if (msg.type === "hello") {
        helloResolve(); 
      }
      if (msg.type === "frame" && !tickFound) {
        const decoded = Buffer.from(msg.dataBase64, "base64").toString("utf8");
        if (decoded.includes("tick")) {
          tickFound = true;
          tickResolve();
        }
      }
    });
    await Promise.race([gotHello, new Promise((_, j) => setTimeout(() => j(new Error("hello timeout")), 3000))]);
    const hello = messages.find((m) => m.type === "hello");
    assert.ok(hello && hello.type === "hello");
    assert.ok(hello.cols > 0);
    assert.ok(hello.rows > 0);
    await Promise.race([sawTick, new Promise((_, j) => setTimeout(() => j(new Error("tick not seen")), 5000))]);
    assert.equal(tickFound, true);
    sock.destroy();
    await Promise.race([exitSeen, new Promise<void>((r) => setTimeout(r, 3000).unref())]);
    assert.equal(exitCode, 0, `child should exit with 0, got ${exitCode}`);
  });
});

// node-pty's native handles can keep the event loop alive even after the
// child exits and our IPC server closes — `beforeExit` won't fire while
// they're held. Schedule a forced exit shortly after this module finishes
// importing/running tests; node:test's auto-start will queue the test
// well before this fires.
setTimeout(() => process.exit(0), 8000).unref();
