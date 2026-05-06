import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { startWrapper } from "../../src/core/pty-wrapper.js";
import { connectIpcClient, readIpc, sendIpc, type WrapperToExtension } from "../../src/core/ipc.js";
import { buildPipePath } from "../../src/core/ipc.js";

let ptyAvailable = true;
try {
  await import("node-pty");
} catch {
  ptyAvailable = false;
}

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

  it("answers get_token with `token` reply when getListenerToken is wired", async (t) => {
    if (!ptyAvailable) {
      t.skip("node-pty not available");
      return;
    }
    const localPipe = buildPipePath();
    const fakeInfo = { token: "TLP1FAKEXYZ", addr: "10.0.0.1:7423", bindHost: "0.0.0.0" };
    let exitedResolve: () => void;
    const exited = new Promise<void>((r) => {
      exitedResolve = r;
    });
    const wrapper = await startWrapper({
      pipePath: localPipe,
      command: process.execPath,
      // Idle Node that will exit when stdin closes; we sock.destroy + the
      // child exits naturally when the IPC pipe closes (well, indirectly:
      // we kill it via the timeout below). Keep it short.
      args: ["-e", "setTimeout(()=>{},5000)"],
      cwd: process.cwd(),
      env: process.env as Record<string, string | undefined>,
      attachStdio: false,
      getListenerToken: () => fakeInfo,
      onChildExit: () => exitedResolve(),
    });
    assert.ok(wrapper, "wrapper should start with node-pty available");
    try {
      await new Promise((r) => setTimeout(r, 50));
      const sock = await connectIpcClient(localPipe);
      const replies: WrapperToExtension[] = [];
      let tokenResolve: () => void;
      const sawToken = new Promise<void>((r) => {
        tokenResolve = r;
      });
      readIpc<WrapperToExtension>(sock, (msg) => {
        replies.push(msg);
        if (msg.type === "token" || msg.type === "token_error") {
          tokenResolve();
        }
      });
      sendIpc(sock, { type: "get_token" });
      await Promise.race([sawToken, new Promise((_, j) => setTimeout(() => j(new Error("token reply timeout")), 3000))]);
      const reply = replies.find((m) => m.type === "token" || m.type === "token_error");
      assert.ok(reply, "should have received a token reply");
      assert.equal(reply!.type, "token", `expected token, got ${reply!.type}`);
      const t2 = reply as Extract<WrapperToExtension, { type: "token" }>;
      assert.equal(t2.token, fakeInfo.token);
      assert.equal(t2.addr, fakeInfo.addr);
      assert.equal(t2.bindHost, fakeInfo.bindHost);
      sock.destroy();
    } finally {
      try {
        wrapper!.pty.kill();
      } catch { /* ignore */ }
      try {
        wrapper!.server.close();
      } catch { /* ignore */ }
      await Promise.race([exited, new Promise<void>((r) => setTimeout(r, 2000).unref())]);
    }
  });

  it("answers get_token with `token_error` when getListenerToken is absent", async (t) => {
    if (!ptyAvailable) {
      t.skip("node-pty not available");
      return;
    }
    const localPipe = buildPipePath();
    let exitedResolve: () => void;
    const exited = new Promise<void>((r) => {
      exitedResolve = r;
    });
    const wrapper = await startWrapper({
      pipePath: localPipe,
      command: process.execPath,
      args: ["-e", "setTimeout(()=>{},5000)"],
      cwd: process.cwd(),
      env: process.env as Record<string, string | undefined>,
      attachStdio: false,
      // Intentionally no getListenerToken — simulates --no-listen.
      onChildExit: () => exitedResolve(),
    });
    assert.ok(wrapper, "wrapper should start");
    try {
      await new Promise((r) => setTimeout(r, 50));
      const sock = await connectIpcClient(localPipe);
      const replies: WrapperToExtension[] = [];
      let tokenResolve: () => void;
      const sawToken = new Promise<void>((r) => {
        tokenResolve = r;
      });
      readIpc<WrapperToExtension>(sock, (msg) => {
        replies.push(msg);
        if (msg.type === "token" || msg.type === "token_error") {
          tokenResolve();
        }
      });
      sendIpc(sock, { type: "get_token" });
      await Promise.race([sawToken, new Promise((_, j) => setTimeout(() => j(new Error("token reply timeout")), 3000))]);
      const reply = replies.find((m) => m.type === "token" || m.type === "token_error");
      assert.ok(reply);
      assert.equal(reply!.type, "token_error");
    } finally {
      try {
        wrapper!.pty.kill();
      } catch { /* ignore */ }
      try {
        wrapper!.server.close();
      } catch { /* ignore */ }
      await Promise.race([exited, new Promise<void>((r) => setTimeout(r, 2000).unref())]);
    }
  });
});

// node-pty's native handles can keep the event loop alive even after the
// child exits and our IPC server closes — `beforeExit` won't fire while
// they're held. Schedule a forced exit shortly after this module finishes
// importing/running tests; node:test's auto-start will queue the test
// well before this fires.
setTimeout(() => process.exit(0), 8000).unref();
