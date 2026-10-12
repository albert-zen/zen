import assert from "node:assert/strict";
import {
  execFileSync,
  spawn,
  spawnSync,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { once } from "node:events";
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { request } from "node:https";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { WebSocket } from "ws";

const cli = path.resolve("dist/apps/cli/src/cli.js");

test("headless Fleet hosting requires an intentional config, data directory and provider", () => {
  for (const [args, error] of [
    [[], /fleet-host requires --config/],
    [["--config", "/nonexistent"], /explicit absolute, non-default --data-dir/],
    [
      ["--config", "/nonexistent", "--data-dir", "/tmp/test-host"],
      /explicit --provider/,
    ],
    [
      [
        "--config",
        "/nonexistent",
        "--data-dir",
        "/tmp/test-host",
        "--provider",
        "openai-compatible",
      ],
      /requires --context-window/,
    ],
    [["--listen", "ws:\/\/0.0.0.0:4500"], /not supported by fleet-host/],
    [["--remote-host-config", "/nonexistent"], /not supported by fleet-host/],
  ] as const) {
    const result = spawnSync(process.execPath, [cli, "fleet-host", ...args], {
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, error);
  }
  const experimental = spawnSync(
    process.execPath,
    [
      cli,
      "app-server",
      "--remote-host-config",
      "/nonexistent",
      "--data-dir",
      "/tmp/test-host",
      "--provider",
      "openai-compatible",
    ],
    { encoding: "utf8", timeout: 10_000 },
  );
  assert.match(
    experimental.stderr,
    /only supports the deterministic fake provider/,
  );
});

// All identities, keys, grants and model traffic here are throwaway fixtures.
// This proves the production CLI composition, not physical-device verification.
test("headless real-provider composition preserves pairing, canonical threads and revocation across process restarts", async (t) => {
  const f = await fixture(t, { access: "control" });
  if (!f) return;
  const seen: Array<{
    authorization: string | undefined;
    body: Record<string, unknown>;
  }> = [];
  const model = createServer((incoming, response) => {
    let raw = "";
    incoming.on("data", (part) => (raw += String(part)));
    incoming.on("end", () => {
      seen.push({
        authorization: incoming.headers.authorization,
        body: JSON.parse(raw) as Record<string, unknown>,
      });
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        'data: {"choices":[{"index":0,"delta":{"content":"Headless fixture reply"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      );
    });
  });
  model.listen(0, "127.0.0.1");
  await once(model, "listening");
  const address = model.address();
  assert(address && typeof address !== "string");
  const provider = [
    "--provider",
    "openai-compatible",
    "--model",
    "headless-test-model",
    "--context-window",
    "16384",
    "--base-url",
    `http://127.0.0.1:${address.port}/v1`,
    "--api-key-env",
    "FLEET_HEADLESS_TEST_KEY",
  ];
  let processHost: Running | undefined;
  let socket: WebSocket | undefined;
  try {
    processHost = await launch(f, ["--pair", ...provider]);
    const code = (await readFile(f.pairCodeFile, "utf8")).trim();
    assert(!processHost.output().includes(code));
    const paired = await pair(processHost.url, f.cert, {
      hostId: f.hostId,
      deviceId: "controller",
      code,
      access: "control",
      shellEnabled: true,
    });
    assert.equal(paired.status, 200);
    const token = paired.body.token as string;
    socket = await connect(processHost.url, f.cert, "controller", token);
    const hello = await rpc(socket, "zen/remote/hello", {
      hostId: f.hostId,
      version: 1,
    });
    assert(!JSON.stringify(hello).includes('"shell"'));
    const models = await rpc(socket, "zen/remote/models", {});
    assert(JSON.stringify(models).includes("headless-test-model"));
    assert(!JSON.stringify(models).includes("fixture-key"));
    const created = await rpc(socket, "zen/remote/create", {
      workspaceId: "workspace",
    });
    const threadId = (created.result as { id: string }).id;
    assert.equal(
      (
        await rpc(socket, "zen/remote/send", {
          workspaceId: "workspace",
          threadId,
          clientId: "one-turn",
          text: "hello mock provider",
        })
      ).error,
      undefined,
    );
    await eventually(async () =>
      JSON.stringify(
        (
          await rpc(socket!, "zen/remote/resume", {
            workspaceId: "workspace",
            threadId,
          })
        ).result,
      ).includes("Headless fixture reply"),
    );
    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.authorization, "Bearer fixture-key");
    assert.equal(seen[0]?.body.model, "headless-test-model");
    const grants = JSON.parse(await readFile(f.grantFile, "utf8")) as {
      devices: Array<{ access: string; shellEnabled: boolean; digest: string }>;
    };
    assert.equal(grants.devices[0]?.access, "control");
    assert.equal(grants.devices[0]?.shellEnabled, false);
    assert(!JSON.stringify(grants).includes(token));
    if (process.platform !== "win32")
      assert.equal((await stat(f.grantFile)).mode & 0o077, 0);
    socket.close();
    socket = undefined;
    await processHost.stop();
    await assert.rejects(stat(f.pairCodeFile), /ENOENT/);
    processHost = await launch(f, provider);
    await assert.rejects(
      stat(f.pairCodeFile),
      /ENOENT/,
      "restarting does not automatically open pairing",
    );
    socket = await connect(processHost.url, f.cert, "controller", token);
    await rpc(socket, "zen/remote/hello", { hostId: f.hostId, version: 1 });
    assert(
      JSON.stringify(
        (
          await rpc(socket, "zen/remote/resume", {
            workspaceId: "workspace",
            threadId,
          })
        ).result,
      ).includes("Headless fixture reply"),
    );
    const revoked = processHost.waitFor(/Device durably revoked/);
    const disconnected = once(socket, "close");
    processHost.child.stdin.write("revoke controller\n");
    await revoked;
    await disconnected;
    socket = undefined;
    await processHost.stop();
    processHost = await launch(f, provider);
    await assert.rejects(
      connect(processHost.url, f.cert, "controller", token),
      /401/,
    );
    assert.equal(
      seen.length,
      1,
      "recovery and revocation do not replay a model turn",
    );
  } finally {
    socket?.terminate();
    await processHost?.stop();
    await new Promise<void>((resolve, reject) =>
      model.close((error) => (error ? reject(error) : resolve())),
    );
    await f.close();
  }
});

test("headless shutdown interrupts an active provider stream instead of waiting indefinitely", async (t) => {
  const f = await fixture(t, { access: "control" });
  if (!f) return;
  let accepted!: () => void;
  const started = new Promise<void>((resolve) => {
    accepted = resolve;
  });
  let providerDisconnected = false;
  const model = createServer((incoming, response) => {
    incoming.resume();
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(
      'data: {"choices":[{"index":0,"delta":{"content":"partial"},"finish_reason":null}]}\n\n',
    );
    response.on("close", () => {
      providerDisconnected = true;
    });
    accepted();
  });
  model.listen(0, "127.0.0.1");
  await once(model, "listening");
  const address = model.address();
  assert(address && typeof address !== "string");
  let host: Running | undefined;
  let socket: WebSocket | undefined;
  try {
    host = await launch(f, [
      "--pair",
      "--provider",
      "openai-compatible",
      "--model",
      "streaming-fixture",
      "--context-window",
      "16384",
      "--base-url",
      `http://127.0.0.1:${address.port}/v1`,
      "--api-key-env",
      "FLEET_HEADLESS_TEST_KEY",
    ]);
    const paired = await pair(host.url, f.cert, {
      hostId: f.hostId,
      deviceId: "controller",
      access: "control",
      code: (await readFile(f.pairCodeFile, "utf8")).trim(),
    });
    socket = await connect(
      host.url,
      f.cert,
      "controller",
      paired.body.token as string,
    );
    await rpc(socket, "zen/remote/hello", { hostId: f.hostId, version: 1 });
    const threadId = (
      (await rpc(socket, "zen/remote/create", { workspaceId: "workspace" }))
        .result as { id: string }
    ).id;
    await rpc(socket, "zen/remote/send", {
      workspaceId: "workspace",
      threadId,
      clientId: "active-shutdown",
      text: "wait",
    });
    await started;
    await host.stop();
    await eventually(async () => providerDisconnected);
    const journal = await readFile(
      path.join(f.dir, "host-data", "threads", `${threadId}.jsonl`),
      "utf8",
    );
    assert(journal.includes('"type":"turn_aborted"'));
  } finally {
    socket?.terminate();
    await host?.stop();
    model.closeAllConnections();
    await new Promise<void>((resolve) => model.close(() => resolve()));
    await f.close();
  }
});

test("read-only grants are durable even when enrollment requests control", async (t) => {
  const f = await fixture(t, { access: "read" });
  if (!f) return;
  let host: Running | undefined;
  let socket: WebSocket | undefined;
  try {
    host = await launch(f, ["--pair", "--provider", "fake"]);
    const paired = await pair(host.url, f.cert, {
      hostId: f.hostId,
      deviceId: "reader",
      code: (await readFile(f.pairCodeFile, "utf8")).trim(),
      access: "control",
    });
    const token = paired.body.token as string;
    socket = await connect(host.url, f.cert, "reader", token);
    await rpc(socket, "zen/remote/hello", { hostId: f.hostId, version: 1 });
    assert.equal(
      (await rpc(socket, "zen/remote/create", { workspaceId: "workspace" }))
        .error?.data?.code,
      "operation_forbidden",
    );
    socket.close();
    socket = undefined;
    await host.stop();
    host = await launch(f, ["--provider", "fake"]);
    socket = await connect(host.url, f.cert, "reader", token);
    await rpc(socket, "zen/remote/hello", { hostId: f.hostId, version: 1 });
    assert.equal(
      (await rpc(socket, "zen/remote/create", { workspaceId: "workspace" }))
        .error?.data?.code,
      "operation_forbidden",
    );
  } finally {
    socket?.terminate();
    await host?.stop();
    await f.close();
  }
});

test("headless shell uses target Host tools, explicit grants and target admission without creating a turn", async (t) => {
  const f = await fixture(t, { access: "control", shellEnabled: true });
  if (!f) return;
  let host: Running | undefined;
  let socket: WebSocket | undefined;
  try {
    host = await launch(f, [
      "--pair",
      "--provider",
      "openai-compatible",
      "--model",
      "shell-fixture-model",
      "--context-window",
      "16384",
      "--base-url",
      "http://127.0.0.1:1/v1",
      "--api-key-env",
      "FLEET_HEADLESS_TEST_KEY",
      "--approval",
      "never",
    ]);
    const paired = await pair(host.url, f.cert, {
      hostId: f.hostId,
      deviceId: "shell-caller",
      code: (await readFile(f.pairCodeFile, "utf8")).trim(),
      access: "control",
      shellEnabled: true,
    });
    const token = paired.body.token as string;
    socket = await connect(host.url, f.cert, "shell-caller", token);
    const hello = await rpc(socket, "zen/remote/hello", {
      hostId: f.hostId,
      version: 1,
    });
    assert(JSON.stringify(hello).includes('"shell"'));
    const threadId = (
      (await rpc(socket, "zen/remote/create", { workspaceId: "workspace" }))
        .result as { id: string }
    ).id;
    const before = (
      await rpc(socket, "zen/remote/resume", {
        workspaceId: "workspace",
        threadId,
      })
    ).result;
    const shellParams = {
      workspaceId: "workspace",
      targetThreadId: threadId,
      command: 'printf \'%s|%s\' "$PWD" "${FLEET_HEADLESS_TEST_KEY-unset}"',
      timeoutMs: 1000,
      maxOutputBytes: 1024,
    };
    const output = (await rpc(socket, "zen/remote/shell", shellParams))
      .result as { output: string; status: string; exitCode: number };
    assert.deepEqual(output, {
      output: `${f.dir}|unset`,
      status: "completed",
      exitCode: 0,
      sourceTruncated: false,
    });
    assert.deepEqual(
      (
        await rpc(socket, "zen/remote/resume", {
          workspaceId: "workspace",
          threadId,
        })
      ).result,
      before,
    );
    socket.close();
    socket = undefined;
    await host.stop();
    host = await launch(f, ["--provider", "fake"]);
    socket = await connect(host.url, f.cert, "shell-caller", token);
    await rpc(socket, "zen/remote/hello", { hostId: f.hostId, version: 1 });
    const guardedThreadId = (
      (await rpc(socket, "zen/remote/create", { workspaceId: "workspace" }))
        .result as { id: string }
    ).id;
    assert.equal(
      (
        await rpc(socket, "zen/remote/shell", {
          ...shellParams,
          targetThreadId: guardedThreadId,
        })
      ).error?.data?.code,
      "approval_required",
    );
    socket.close();
    socket = undefined;
    await host.stop();
    const legacy = JSON.parse(await readFile(f.grantFile, "utf8")) as {
      devices: Array<{ shellEnabled?: boolean }>;
    };
    delete legacy.devices[0]!.shellEnabled;
    await writeFile(f.grantFile, JSON.stringify(legacy));
    host = await launch(f, ["--provider", "fake", "--approval", "never"]);
    socket = await connect(host.url, f.cert, "shell-caller", token);
    assert(
      !JSON.stringify(
        await rpc(socket, "zen/remote/hello", { hostId: f.hostId, version: 1 }),
      ).includes('"shell"'),
    );
    assert.equal(
      (await rpc(socket, "zen/remote/shell", shellParams)).error?.data?.code,
      "operation_forbidden",
    );
  } finally {
    socket?.terminate();
    await host?.stop();
    await f.close();
  }
});

async function fixture(
  t: TestContext,
  settings: { access: "read" | "control"; shellEnabled?: boolean },
) {
  if (process.platform === "win32") {
    t.skip(
      "Production headless command requires POSIX private-file validation",
    );
    return;
  }
  const dir = await mkdtemp(path.join(os.tmpdir(), "fleet-headless-cli-"));
  const keyFile = path.join(dir, "key.pem"),
    certFile = path.join(dir, "cert.pem");
  try {
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        keyFile,
        "-out",
        certFile,
        "-days",
        "1",
        "-subj",
        "/CN=localhost",
        "-addext",
        "subjectAltName=DNS:localhost,IP:127.0.0.1",
      ],
      { stdio: "ignore" },
    );
  } catch {
    await rm(dir, { recursive: true, force: true });
    t.skip("OpenSSL unavailable for ephemeral trusted TLS fixture");
    return;
  }
  await chmod(keyFile, 0o600);
  const hostId = "headless-fixture",
    file = path.join(dir, "host.json"),
    grantFile = path.join(dir, "grants.json"),
    pairCodeFile = path.join(dir, "pair-code");
  await writeFile(
    file,
    JSON.stringify({
      enabled: true,
      hostId,
      bindAddress: "127.0.0.1",
      port: 0,
      tlsCertificateFile: certFile,
      tlsKeyFile: keyFile,
      grantFile,
      pairCodeFile,
      ...settings,
      workspaces: [{ id: "workspace", label: "Throwaway", cwd: dir }],
    }),
    { mode: 0o600 },
  );
  return {
    dir,
    hostId,
    file,
    grantFile,
    pairCodeFile,
    cert: await readFile(certFile),
    close: async () => rm(dir, { recursive: true, force: true }),
  };
}

type Fixture = NonNullable<Awaited<ReturnType<typeof fixture>>>;
type Running = Awaited<ReturnType<typeof launch>>;
async function launch(f: Fixture, extra: string[]) {
  const child = spawn(
    process.execPath,
    [
      cli,
      "fleet-host",
      "--config",
      f.file,
      "--data-dir",
      path.join(f.dir, "host-data"),
      "--tool-presentation",
      "direct",
      ...extra,
    ],
    {
      stdio: "pipe",
      env: { ...process.env, FLEET_HEADLESS_TEST_KEY: "fixture-key" },
    },
  );
  let output = "";
  child.stderr.on("data", (part) => (output += String(part)));
  const waitFor = async (pattern: RegExp) => {
    await eventually(async () => {
      if (pattern.test(output)) return true;
      if (child.exitCode !== null)
        throw new Error(`CLI exited ${child.exitCode}: ${output}`);
      return false;
    });
  };
  try {
    await waitFor(/Fleet Host headless-fixture listening on/);
  } catch (error) {
    child.kill("SIGTERM");
    if (child.exitCode === null) await once(child, "exit");
    throw error;
  }
  const url = /listening on (wss:\/\/[^\s]+)/u.exec(output)?.[1];
  assert(url);
  return {
    child: child as ChildProcessWithoutNullStreams,
    url,
    output: () => output,
    waitFor,
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      const deadline = setTimeout(() => child.kill("SIGKILL"), 5000);
      try {
        await exited;
      } finally {
        clearTimeout(deadline);
      }
      assert.equal(child.exitCode, 0, output);
    },
  };
}

async function pair(endpoint: string, ca: Buffer, body: unknown) {
  const url = new URL(endpoint);
  url.protocol = "https:";
  url.pathname = "/pair";
  return await new Promise<{ status: number; body: Record<string, unknown> }>(
    (resolve, reject) => {
      const req = request(
        url,
        { method: "POST", ca, headers: { "content-type": "application/json" } },
        (response) => {
          let raw = "";
          response.on("data", (part) => (raw += String(part)));
          response.on("end", () =>
            resolve({
              status: response.statusCode ?? 0,
              body: JSON.parse(raw) as Record<string, unknown>,
            }),
          );
        },
      );
      req.on("error", reject);
      req.end(JSON.stringify(body));
    },
  );
}
async function connect(
  endpoint: string,
  ca: Buffer,
  deviceId: string,
  token: string,
) {
  const socket = new WebSocket(endpoint, {
    ca,
    headers: { authorization: `Bearer ${token}`, "x-zen-device-id": deviceId },
  });
  await once(socket, "open");
  return socket;
}
let rpcId = 0;
type Reply = { result?: unknown; error?: { data?: { code?: string } } };
async function rpc(
  socket: WebSocket,
  method: string,
  params: unknown,
): Promise<Reply> {
  const id = `headless:${++rpcId}`;
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off("message", onMessage);
      reject(new Error(`RPC ${method} timed out`));
    }, 5000);
    const onMessage = (raw: unknown) => {
      const reply = JSON.parse(String(raw)) as Reply & { id?: string };
      if (reply.id !== id) return;
      clearTimeout(timer);
      socket.off("message", onMessage);
      resolve(reply);
    };
    socket.on("message", onMessage);
    socket.send(JSON.stringify({ id, method, params }));
  });
}
async function eventually(check: () => Promise<boolean>) {
  const deadline = Date.now() + 10_000;
  while (!(await check())) {
    if (Date.now() > deadline)
      throw new Error("Timed out awaiting headless fixture behavior");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
