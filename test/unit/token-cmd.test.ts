// `telepathy token` CLI tests. End-to-end via subprocess: stand up a fake
// IPC server that mimics the wrapper's get_token responses, point the CLI
// at it via TELEPATHY_SOCKET, and assert on stdout/stderr/exit code.
//
// Why end-to-end via subprocess: the command's whole job is to be invoked
// from a child shell of `telepathy host`. Mocking the env in-process would
// hide bugs in env handling, exit codes, and stdio choice (stdout vs stderr).

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  buildPipePath,
  startIpcServer,
  sendIpc,
  readIpc,
  type WrapperToExtension,
  type ExtensionToWrapper,
} from "../../src/core/ipc.js";
import type { Server } from "node:net";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI = join(ROOT, "dist", "cli.js");

type RunResult = { stdout: string; stderr: string; status: number | null };

function runCli(args: string[], envOverride: Record<string, string | undefined>): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    // Build env: start from the parent env, but explicitly delete
    // TELEPATHY_SOCKET so the test controls whether it's set. Then
    // overlay envOverride. NO_COLOR keeps assertions stable.
    const env: Record<string, string | undefined> = {
      ...process.env,
      NO_COLOR: "1",
      TELEPATHY_SOCKET: undefined,
    };
    for (const [k, v] of Object.entries(envOverride)) {
      env[k] = v;
    }
    const child = spawn(process.execPath, [CLI, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      env: env as NodeJS.ProcessEnv,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (b: Buffer) => {
      stdout += b.toString("utf8"); 
    });
    child.stderr?.on("data", (b: Buffer) => {
      stderr += b.toString("utf8"); 
    });
    child.on("error", reject);
    child.on("close", (status) => resolve({ stdout, stderr, status }));
    // Hard cap so a hung command doesn't hang the whole test file.
    setTimeout(() => {
      try {
        child.kill("SIGKILL"); 
      } catch { /* ignore */ }
    }, 15_000).unref();
  });
}

// Stand up a fake wrapper IPC server with a programmable get_token reply.
async function startFakeWrapper(replyOrUndefined: WrapperToExtension | "no-reply"): Promise<{ pipe: string; close: () => void; server: Server }> {
  const pipe = buildPipePath();
  const server = startIpcServer({
    pipePath: pipe,
    onClient: (sock) => {
      sock.on("error", () => undefined);
      readIpc<ExtensionToWrapper>(sock, (msg) => {
        if (msg.type !== "get_token") {
          return;
        }
        if (replyOrUndefined === "no-reply") {
          // Drop the connection without replying — exercises the timeout path.
          try {
            sock.end(); 
          } catch { /* ignore */ }
          return;
        }
        try {
          sendIpc(sock, replyOrUndefined);
        } catch { /* ignore */ }
      });
    },
  });
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  return {
    pipe,
    server,
    close: () => {
      try {
        server.close(); 
      } catch { /* ignore */ }
    },
  };
}

describe("telepathy token CLI", () => {
  it("prints the token + addr + bindHost from the wrapper's reply", async () => {
    const fake = await startFakeWrapper({
      type: "token",
      token: "TLP1ABCDEFGHIJK",
      addr: "192.168.1.99:7423",
      bindHost: "0.0.0.0",
    });
    try {
      const r = await runCli(["token"], { TELEPATHY_SOCKET: fake.pipe });
      assert.equal(r.status, 0, `expected exit 0; stderr=${r.stderr}; stdout=${r.stdout}`);
      assert.match(r.stdout, /TLP1ABCDEFGHIJK/, "stdout should contain the token");
      assert.match(r.stdout, /192\.168\.1\.99:7423/, "stdout should contain the addr");
      assert.match(r.stdout, /0\.0\.0\.0/, "stdout should contain the bindHost");
    } finally {
      fake.close();
    }
  });

  it("--json emits a parseable JSON object with ok:true and the fields", async () => {
    const fake = await startFakeWrapper({
      type: "token",
      token: "TLP1XYZ",
      addr: "10.0.0.5:9000",
      bindHost: "0.0.0.0",
    });
    try {
      const r = await runCli(["token", "--json"], { TELEPATHY_SOCKET: fake.pipe });
      assert.equal(r.status, 0, `expected exit 0; stderr=${r.stderr}`);
      const parsed = JSON.parse(r.stdout) as { ok: boolean; token?: string; addr?: string; bindHost?: string };
      assert.equal(parsed.ok, true);
      assert.equal(parsed.token, "TLP1XYZ");
      assert.equal(parsed.addr, "10.0.0.5:9000");
      assert.equal(parsed.bindHost, "0.0.0.0");
    } finally {
      fake.close();
    }
  });

  it("exits non-zero with a clear remediation when TELEPATHY_SOCKET is unset", async () => {
    const r = await runCli(["token"], {});
    assert.notEqual(r.status, 0, "must not exit 0 when TELEPATHY_SOCKET is unset");
    assert.match(r.stderr, /not running inside a `telepathy host` wrapped shell/);
    assert.match(r.stderr, /TELEPATHY_SOCKET/);
  });

  it("exits non-zero and surfaces the wrapper's `token_error` text", async () => {
    const fake = await startFakeWrapper({
      type: "token_error",
      error: "host has no active listener (started with --no-listen?)",
    });
    try {
      const r = await runCli(["token"], { TELEPATHY_SOCKET: fake.pipe });
      assert.notEqual(r.status, 0, "token_error must propagate as a non-zero exit");
      assert.match(r.stderr, /no active listener/);
    } finally {
      fake.close();
    }
  });

  it("--json on token_error emits {ok:false, error}", async () => {
    const fake = await startFakeWrapper({
      type: "token_error",
      error: "no listener",
    });
    try {
      const r = await runCli(["token", "--json"], { TELEPATHY_SOCKET: fake.pipe });
      assert.notEqual(r.status, 0);
      const parsed = JSON.parse(r.stdout) as { ok: boolean; error?: string };
      assert.equal(parsed.ok, false);
      assert.match(parsed.error ?? "", /no listener/);
    } finally {
      fake.close();
    }
  });

  it("times out cleanly if the wrapper never replies", async () => {
    const fake = await startFakeWrapper("no-reply");
    try {
      const r = await runCli(["token"], { TELEPATHY_SOCKET: fake.pipe });
      assert.notEqual(r.status, 0, "no-reply scenario must not exit 0");
      // Either "wrapper closed the IPC pipe before replying" (likely path —
      // we close the socket) or "timed out" (if the close races slow). Both
      // are clear, no-leak paths.
      assert.match(r.stderr, /(closed the IPC pipe|timed out)/, `stderr was: ${r.stderr}`);
    } finally {
      fake.close();
    }
  });

  it("token --help describes the command", async () => {
    const r = await runCli(["token", "--help"], {});
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Reprint the current join token/);
    assert.match(r.stdout, /--json/);
  });
});
