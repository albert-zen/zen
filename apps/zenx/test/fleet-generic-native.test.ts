import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { WebSocket } from "ws";
import { createHostedAppServer } from "../../cli/src/host.js";
import { InMemoryThreadJournal } from "../../../src/journal.js";
import { ToolEnvironment, type ToolRuntime } from "../../../src/tool.js";
import { RemoteHostAccess } from "../../../src/protocol/native/remote-host.js";
import { FleetToolGateway } from "../../../src/protocol/native/remote-tools.js";
import { serveRemoteHost } from "../../../src/protocol/native/remote-transport.js";
import { REMOTE_METHODS } from "../../../src/protocol/native/remote-wire.js";
import {
  makeRemoteToolAdmissionId,
  type RemoteToolResult,
} from "../../../src/protocol/native/remote-tool-wire.js";
import { FleetToolTransportAdapter } from "../src/main/fleet-tool-router.js";
import {
  NativeFleetClient,
  type NativeFleetCredential,
  type NativeFleetExecuteInput,
} from "../src/main/fleet-native.js";
import {
  fleetDeviceKey,
  parseFleetConfig,
  type NativeFleetDevice,
} from "../src/main/fleet.js";

async function fixture(
  t: TestContext,
  options: {
    hostOptIn?: boolean;
    clientOptIn?: boolean;
    runtime?: ToolRuntime;
    afterGateway?: (
      operation: "execute" | "wait" | "cancel",
      result: RemoteToolResult,
    ) => Promise<void>;
  } = {},
) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "fleet-generic-native-"));
  const certFile = path.join(cwd, "cert.pem"),
    keyFile = path.join(cwd, "key.pem");
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
  const cert = await readFile(certFile),
    key = await readFile(keyFile);
  let executions = 0;
  const tools = new ToolEnvironment({
    runtimes: [
      options.runtime ?? {
        name: "echo",
        remoteExecution: "text-json",
        enforcesSandbox: true,
        specification: {
          name: "echo",
          description: "Fixture echo",
          inputSchema: { type: "object" },
        },
        async execute(invocation) {
          executions++;
          return { output: String(invocation.arguments.text), exitCode: 0 };
        },
      },
    ],
  });
  const app = createHostedAppServer({
    cwd,
    dataDirectory: path.join(cwd, "data"),
    provider: { type: "fake" },
    model: "fake",
    journal: new InMemoryThreadJournal(),
    approvalPolicy: "never",
    toolEnvironment: tools,
    toolPresentation: "direct",
  });
  let workspaceAllowed = true;
  const access = new RemoteHostAccess({
    appServer: app,
    hostId: "target",
    access: "control",
    toolsEnabled: options.hostOptIn ?? true,
    tools: (identity) => {
      const gateway = new FleetToolGateway({ ...identity, tools });
      // These hooks run after the real gateway has retained its receipt. They
      // isolate the Host's final disclosure fence from its admission checks.
      const execute = gateway.execute.bind(gateway);
      gateway.execute = async (...args) => {
        const result = await execute(...args);
        await options.afterGateway?.("execute", result);
        return result;
      };
      const wait = gateway.wait.bind(gateway);
      gateway.wait = async (...args) => {
        const result = await wait(...args);
        await options.afterGateway?.("wait", result);
        return result;
      };
      const cancel = gateway.cancel.bind(gateway);
      gateway.cancel = async (...args) => {
        const result = await cancel(...args);
        await options.afterGateway?.("cancel", result);
        return result;
      };
      return gateway;
    },
    workspaces: () =>
      workspaceAllowed ? [{ id: "work", label: "Work", cwd }] : [],
  });
  const server = await serveRemoteHost({
    enabled: true,
    listen: "127.0.0.1",
    port: 0,
    tls: { cert, key },
    access,
  });
  const peer: NativeFleetDevice = {
    id: "remote",
    label: "Remote fixture",
    transport: "https",
    endpoint: server.url.replace(/^wss:/, "https:").replace(/\/remote$/, ""),
    hostId: "target",
    access: "control",
    toolsEnabled: options.clientOptIn ?? true,
  };
  const vault = new Map<string, NativeFleetCredential>();
  const client = new NativeFleetClient({
    ca: cert,
    credentials: {
      get: async (id) => vault.get(id) ?? null,
      set: async (id, value) => {
        vault.set(id, value);
      },
      delete: async (id) => {
        vault.delete(id);
      },
    },
  });
  const thread = await app.startThread({ cwd });
  await client.pair(peer, access.createPairingCode());
  const catalogRequest = {
    sourceThreadId: "source",
    workspaceId: "work",
    targetThreadId: thread.id,
  };
  const request = async (
    admissionId = "admission",
  ): Promise<NativeFleetExecuteInput> => {
    const catalog = await client.catalog(peer, catalogRequest);
    const definition = catalog.tools.find(
      ({ definition }) => definition.name === (options.runtime?.name ?? "echo"),
    )!;
    const createdAtMs = Date.now(),
      expiresAtMs = createdAtMs + 60_000;
    return {
      ...catalogRequest,
      processEpoch: catalog.processEpoch,
      admissionId: makeRemoteToolAdmissionId(
        createdAtMs,
        expiresAtMs,
        admissionId,
      ),
      createdAtMs,
      expiresAtMs,
      name: definition.definition.name,
      toolGeneration: definition.generation,
      arguments: { text: "remote value" },
      yieldTimeMs: 1,
      timeoutMs: 10_000,
      maxOutputBytes: 1024,
    };
  };
  t.after(async () => {
    await server.close();
    access.close();
    await app.closeHostResources();
    await tools.close();
    await rm(cwd, { recursive: true, force: true });
  });
  return {
    client,
    peer,
    app,
    access,
    server,
    vault,
    cert,
    thread,
    request,
    catalogRequest,
    cwd,
    setWorkspaceAllowed: (allowed: boolean) => {
      workspaceAllowed = allowed;
    },
    executions: () => executions,
  };
}

async function rpc(
  socket: WebSocket,
  id: string,
  method: string,
  params: unknown,
): Promise<Record<string, unknown>> {
  const received = new Promise<Record<string, unknown>>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("RPC timeout")), 5000);
    const listener = (data: unknown) => {
      const value = JSON.parse(String(data));
      if (value.id === id) {
        clearTimeout(timer);
        socket.removeListener("message", listener);
        resolve(value);
      }
    };
    socket.on("message", listener);
  });
  socket.send(JSON.stringify({ id, method, params }));
  return await received;
}
async function raw(f: Awaited<ReturnType<typeof fixture>>) {
  const credential = f.vault.get(f.peer.id)!;
  const socket = new WebSocket(f.server.url, {
    ca: f.cert,
    rejectUnauthorized: true,
    headers: {
      authorization: `Bearer ${credential.token}`,
      "x-zen-device-id": credential.deviceId,
      "x-zen-host-id": f.peer.hostId,
    },
    perMessageDeflate: false,
  });
  await once(socket, "open");
  const hello = await rpc(socket, "hello", REMOTE_METHODS.hello, {
    hostId: f.peer.hostId,
    version: 1,
  });
  return {
    socket,
    epoch: (hello.result as { processEpoch: string }).processEpoch,
  };
}

test("TLS generic tools execute through target environment and preserve origin without target transcript mutation", async (t) => {
  const f = await fixture(t),
    before = await f.app.readThread(f.thread.id),
    request = await f.request();
  const result = await f.client.execute(f.peer, request);
  assert.equal(result.output, "remote value");
  assert.equal(result.origin.hostId, "target");
  assert.equal(result.paths, "remote-host");
  assert.deepEqual((await f.app.readThread(f.thread.id)).items, before.items);
  assert.equal(f.executions(), 1);
  assert.deepEqual(await f.client.execute(f.peer, request), result);
  assert.equal(f.executions(), 1);
  const status = await f.client.status(f.peer, {
    ...f.catalogRequest,
    processEpoch: request.processEpoch,
    admissionId: request.admissionId,
    taskId: result.taskId,
  });
  assert.equal(status.status, "completed");
});

test("TLS generic transport fails closed for local opt-out, old Host capability and stale epoch", async (t) => {
  const f = await fixture(t),
    request = await f.request();
  await assert.rejects(
    f.client.catalog({ ...f.peer, toolsEnabled: false }, f.catalogRequest),
    /separate tools permission/,
  );
  await assert.rejects(
    f.client.execute(f.peer, { ...request, processEpoch: "previous" }),
    /resync_required/,
  );
  assert.equal(f.executions(), 0);
  const old = await fixture(t, { hostOptIn: false });
  await assert.rejects(
    old.client.catalog(old.peer, old.catalogRequest),
    /does not expose tools-v1/,
  );
  assert.equal(old.executions(), 0);
  await assert.rejects(
    f.client.catalog(
      { ...f.peer, transport: "ssh" } as unknown as NativeFleetDevice,
      f.catalogRequest,
    ),
    /requires an HTTPS device/,
  );
});

test("generic config opt-in is independent and included in destination identity; SSH cannot enable it", () => {
  const native: NativeFleetDevice = {
    id: "remote",
    label: "Remote",
    transport: "https",
    endpoint: "https://target.test",
    hostId: "target",
    access: "control",
    shellEnabled: true,
  };
  assert.notEqual(
    fleetDeviceKey(native),
    fleetDeviceKey({ ...native, toolsEnabled: true }),
  );
  assert.equal(
    parseFleetConfig({ version: 1, devices: [native] }).devices[0]!
      .toolsEnabled,
    undefined,
  );
  assert.throws(
    () =>
      parseFleetConfig({
        version: 1,
        devices: [{ ...native, access: "read", toolsEnabled: true }],
      }),
    /Invalid Fleet device/,
  );
  assert.throws(
    () =>
      parseFleetConfig({
        version: 1,
        devices: [
          {
            id: "ssh",
            label: "SSH",
            transport: "ssh",
            sshHost: "host",
            command: ["zen"],
            access: "control",
            toolsEnabled: true,
          },
        ],
      }),
    /Invalid Fleet device/,
  );
});

test("dispatch survives dropped socket and lost response is recovered by exact admission replay", async (t) => {
  let started!: () => void,
    release!: () => void,
    executions = 0;
  const dispatched = new Promise<void>((resolve) => {
      started = resolve;
    }),
    finish = new Promise<void>((resolve) => {
      release = resolve;
    });
  const f = await fixture(t, {
    runtime: {
      name: "slow",
      remoteExecution: "text-json",
      enforcesSandbox: true,
      specification: {
        name: "slow",
        description: "Slow fixture",
        inputSchema: { type: "object" },
      },
      async execute(invocation) {
        executions++;
        started();
        await finish;
        assert.equal(invocation.signal.aborted, false);
        return { output: "survived", exitCode: 0 };
      },
    },
  });
  const request = await f.request("lost"),
    connection = await raw(f);
  connection.socket.send(
    JSON.stringify({
      id: "lost-execute",
      method: REMOTE_METHODS.toolsExecute,
      params: {
        ...request,
        version: 1,
        hostId: f.peer.hostId,
        yieldTimeMs: 1000,
      },
    }),
  );
  await dispatched;
  connection.socket.terminate();
  await once(connection.socket, "close");
  release();
  // Exact execute replay must use the same payload, including its yield option.
  const replay = await f.client.execute(f.peer, {
    ...request,
    yieldTimeMs: 1000,
  });
  assert.equal(replay.output, "survived");
  assert.equal(executions, 1);
  const status = await f.client.status(f.peer, {
    ...f.catalogRequest,
    processEpoch: request.processEpoch,
    admissionId: request.admissionId,
  });
  assert.equal(status.taskId, replay.taskId);
  assert.equal(status.status, "completed");
});

test("explicit generic cancel targets the authenticated task without replaying its body", async (t) => {
  let started!: () => void,
    stopped!: () => void,
    executions = 0;
  const dispatched = new Promise<void>((resolve) => {
    started = resolve;
  });
  const cancelled = new Promise<void>((resolve) => {
    stopped = resolve;
  });
  const f = await fixture(t, {
    runtime: {
      name: "cancelable",
      remoteExecution: "text-json",
      enforcesSandbox: true,
      specification: {
        name: "cancelable",
        description: "Cancelable fixture",
        inputSchema: { type: "object" },
      },
      async execute(invocation) {
        executions++;
        started();
        await new Promise<void>((_resolve, reject) => {
          invocation.signal.addEventListener(
            "abort",
            () => {
              stopped();
              reject(invocation.signal.reason);
            },
            { once: true },
          );
        });
        return { output: "unreachable", exitCode: 0 };
      },
    },
  });
  const request = await f.request("cancel-me");
  const running = await f.client.execute(f.peer, request);
  await dispatched;
  assert.ok(["queued", "running"].includes(running.status));
  const cancel = {
    ...f.catalogRequest,
    processEpoch: request.processEpoch,
    admissionId: request.admissionId,
    taskId: running.taskId,
    ackCursor: running.cursor,
    yieldTimeMs: 100,
    maxOutputBytes: 1024,
  };
  const result = await f.client.cancel(f.peer, cancel);
  await cancelled;
  assert.ok(
    ["cancelled", "cancel_requested", "cancellation_unconfirmed"].includes(
      result.status,
    ),
  );
  assert.equal(executions, 1);
  assert.equal(result.taskId, running.taskId);
});

test("replacing a device grant cannot recover the previous grant's admission", async (t) => {
  const f = await fixture(t),
    request = await f.request("old-grant");
  const result = await f.client.execute(f.peer, request);
  const original = f.vault.get(f.peer.id)!;
  const replacement = await f.access.pair({
    hostId: f.peer.hostId,
    deviceId: original.deviceId,
    code: f.access.createPairingCode(),
    access: "control",
    toolsEnabled: true,
  });
  f.vault.set(f.peer.id, { ...original, token: replacement.token });
  await assert.rejects(
    f.client.status(f.peer, {
      ...f.catalogRequest,
      processEpoch: request.processEpoch,
      admissionId: request.admissionId,
      taskId: result.taskId,
    }),
    /outcome unknown/,
  );
  const newRequest = await f.request("new-grant");
  assert.equal(
    (await f.client.execute(f.peer, newRequest)).output,
    "remote value",
  );
  assert.equal(f.executions(), 2);
});

test("generic wire rejects extra identity and target permission fields before dispatch", async (t) => {
  const f = await fixture(t),
    request = await f.request("extra");
  await assert.rejects(
    f.client.execute(f.peer, {
      ...request,
      hostId: "attacker",
    } as unknown as NativeFleetExecuteInput),
    /identity is selected/,
  );
  await assert.rejects(
    f.client.execute(f.peer, {
      ...request,
      sandbox: "danger-full-access",
    } as unknown as NativeFleetExecuteInput),
    /Unexpected request/,
  );
  const { socket } = await raw(f);
  try {
    const response = await rpc(socket, "extra", REMOTE_METHODS.toolsExecute, {
      ...request,
      version: 1,
      hostId: f.peer.hostId,
      peerId: "attacker",
    });
    assert.equal(
      (response.error as { data: { code: string } }).data.code,
      "invalid_request",
    );
    assert.equal(f.executions(), 0);
  } finally {
    socket.terminate();
  }
});

test("generic transport has an independent bounded admission budget with definite pre-send failures", async (t) => {
  const f = await fixture(t);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  t.after(() => release());
  const original = f.client.options.credentials.get;
  let reads = 0;
  f.client.options.credentials.get = async (deviceId) => {
    if (++reads <= 4) await gate;
    return await original(deviceId);
  };
  const catalogs = Array.from({ length: 4 }, () =>
    f.client.catalog(f.peer, f.catalogRequest),
  );
  await assert.rejects(
    f.client.catalog(f.peer, f.catalogRequest),
    (error: unknown) =>
      error instanceof Error &&
      "confirmedRejection" in error &&
      error.confirmedRejection === true &&
      /busy; no operation was sent/u.test(error.message),
  );
  // Legacy reads keep their own budget while the generic connection setup waits.
  assert.equal((await f.client.test(f.peer)).status, "connected");
  release();
  await Promise.all(catalogs);
  const request = await f.request("invalid-before-send");
  await assert.rejects(
    f.client.execute(f.peer, { ...request, timeoutMs: 0 }),
    (error: unknown) =>
      error instanceof Error &&
      "confirmedRejection" in error &&
      error.confirmedRejection === true,
  );
  f.vault.clear();
  await assert.rejects(
    f.client.execute(f.peer, request),
    (error: unknown) =>
      error instanceof Error &&
      "confirmedRejection" in error &&
      error.confirmedRejection === true &&
      /unpaired/u.test(error.message),
  );
  assert.equal(f.executions(), 0);
});

async function tlsAdapter(f: Awaited<ReturnType<typeof fixture>>) {
  const file = path.join(f.cwd, "fleet.json");
  await writeFile(file, JSON.stringify({ version: 1, devices: [f.peer] }));
  const execute = f.client.execute.bind(f.client);
  let sent: NativeFleetExecuteInput | undefined;
  let nativeError: unknown;
  f.client.execute = async (device, request, signal) => {
    sent ??= structuredClone(request);
    try {
      return await execute(device, request, signal);
    } catch (error) {
      nativeError = error;
      throw error;
    }
  };
  return {
    adapter: new FleetToolTransportAdapter(
      { file, native: f.client },
      () => {},
    ),
    sent: () => sent!,
    nativeError: () => nativeError,
  };
}

function adapterExecute(
  f: Awaited<ReturnType<typeof fixture>>,
  request: NativeFleetExecuteInput,
) {
  return {
    name: "zenx_fleet_execute",
    callId: "effect-call",
    canonicalToolCallId: "canonical-effect-call",
    threadId: request.sourceThreadId,
    cwd: f.cwd,
    signal: AbortSignal.timeout(10_000),
    arguments: {
      device: f.peer.id,
      deviceKey: fleetDeviceKey(f.peer),
      workspace: request.workspaceId,
      targetThreadId: request.targetThreadId,
      processEpoch: request.processEpoch,
      toolGeneration: request.toolGeneration,
      name: request.name,
      arguments: request.arguments,
      yield_time_ms: 1000,
      timeout_ms: request.timeoutMs,
      max_output_bytes: request.maxOutputBytes,
    },
  };
}

function assertUnknown(error: unknown): asserts error is Error {
  assert.ok(error instanceof Error);
  assert.notEqual(
    (error as Error & { confirmedRejection?: boolean }).confirmedRejection,
    true,
    "an effectful operation must not be classified as definitely rejected",
  );
  assert.match(error.message, /outcome unknown|admission may be unknown/u);
  assert.doesNotMatch(error.message, /withheld-sensitive-result/u);
}

function recoveryHandle(error: Error) {
  const handle = error.message.match(/task_id: (fleet-tool:v1:[\w-]+)/u)?.[1];
  assert.ok(
    handle,
    "unknown admission must retain a qualified recovery handle",
  );
  const metadata = JSON.parse(
    Buffer.from(handle.slice("fleet-tool:v1:".length), "base64url").toString(
      "utf8",
    ),
  ) as Record<string, unknown>;
  const identityKeys = [
    "device",
    "deviceKey",
    "hostId",
    "sourceThreadId",
    "workspaceId",
    "targetThreadId",
    "processEpoch",
    "admissionId",
  ];
  return {
    handle,
    metadata,
    binding: Object.fromEntries(
      identityKeys.map((key) => [key, metadata[key]]),
    ),
  };
}

for (const scopeLoss of [
  "archive",
  "workspace removal",
  "revocation",
] as const) {
  test(`TLS effect then ${scopeLoss} withholds result and preserves exact adapter admission`, async (t) => {
    let f!: Awaited<ReturnType<typeof fixture>>;
    let effects = 0;
    f = await fixture(t, {
      runtime: {
        name: "effect",
        remoteExecution: "text-json",
        enforcesSandbox: true,
        specification: {
          name: "effect",
          description: "Effect followed by authorization loss",
          inputSchema: { type: "object" },
        },
        async execute() {
          effects++;
          await writeFile(path.join(f.cwd, "effect.txt"), scopeLoss);
          if (scopeLoss === "archive")
            await f.app.setThreadArchived(f.thread.id, true);
          else if (scopeLoss === "workspace removal")
            f.setWorkspaceAllowed(false);
          else f.access.revoke(f.vault.get(f.peer.id)!.deviceId);
          return { output: "withheld-sensitive-result", exitCode: 0 };
        },
      },
    });
    const request = await f.request(scopeLoss.replaceAll(" ", "-"));
    const transport = await tlsAdapter(f);
    let adapterError!: Error;
    await assert.rejects(
      transport.adapter.invoke(adapterExecute(f, request)),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        adapterError = error;
        return true;
      },
    );
    assert.equal(
      await readFile(path.join(f.cwd, "effect.txt"), "utf8"),
      scopeLoss,
    );
    assert.equal(effects, 1);
    if (scopeLoss === "archive")
      assert.equal((await f.app.readThread(f.thread.id)).archived, true);
    assertUnknown(transport.nativeError());
    assert.equal(adapterError.cause, transport.nativeError());
    assert.doesNotMatch(adapterError.message, /withheld-sensitive-result/u);
    const { handle, binding } = recoveryHandle(adapterError);
    const sent = transport.sent();
    assert.deepEqual(binding, {
      device: f.peer.id,
      deviceKey: fleetDeviceKey(f.peer),
      hostId: f.peer.hostId,
      sourceThreadId: sent.sourceThreadId,
      workspaceId: sent.workspaceId,
      targetThreadId: sent.targetThreadId,
      processEpoch: sent.processEpoch,
      admissionId: sent.admissionId,
    });
    assert.notEqual(sent.admissionId, request.admissionId);
    if (scopeLoss === "revocation") return;
    if (scopeLoss === "archive")
      await f.app.setThreadArchived(f.thread.id, false);
    else f.setWorkspaceAllowed(true);
    const status = await transport.adapter.invoke({
      name: "zenx_fleet_tool_status",
      arguments: { task_id: handle },
      callId: "recover-effect",
      threadId: sent.sourceThreadId,
      cwd: f.cwd,
      signal: AbortSignal.timeout(10_000),
    });
    const recovered = JSON.parse(status.output);
    assert.equal(recovered.admissionId, sent.admissionId);
    assert.equal(recovered.status, "completed");
    const replay = await f.client.execute(f.peer, sent);
    assert.equal(replay.output, "withheld-sensitive-result");
    assert.equal(replay.taskId, recovered.taskId);
    assert.equal(
      effects,
      1,
      "read-only recovery and exact replay must not rerun the body",
    );
  });
}

for (const operation of ["wait", "cancel"] as const) {
  test(`TLS post-${operation} archive cannot turn a destructive observation into confirmed rejection`, async (t) => {
    let f!: Awaited<ReturnType<typeof fixture>>;
    let release!: () => void;
    let effects = 0;
    let observations = 0;
    let cancellations = 0;
    let withheldReceipt: RemoteToolResult | undefined;
    const finish = new Promise<void>((resolve) => {
      release = resolve;
    });
    t.after(() => release());
    f = await fixture(t, {
      runtime: {
        name: "drain",
        remoteExecution: "text-json",
        enforcesSandbox: true,
        specification: {
          name: "drain",
          description: "Destructive observation fixture",
          inputSchema: { type: "object" },
        },
        async execute(invocation) {
          effects++;
          await new Promise<void>((resolve, reject) => {
            void finish.then(resolve);
            invocation.signal.addEventListener(
              "abort",
              () => {
                cancellations++;
                reject(invocation.signal.reason);
              },
              { once: true },
            );
          });
          return { output: "withheld-sensitive-result", exitCode: 0 };
        },
      },
      async afterGateway(completed, receipt) {
        if (completed === operation && observations++ === 0) {
          withheldReceipt = structuredClone(receipt);
          await f.app.setThreadArchived(f.thread.id, true);
        }
      },
    });
    const request = await f.request(`post-${operation}`);
    const running = await f.client.execute(f.peer, request);
    assert.ok(["queued", "running"].includes(running.status));
    const observation = {
      ...f.catalogRequest,
      processEpoch: request.processEpoch,
      admissionId: request.admissionId,
      taskId: running.taskId,
      ackCursor: running.cursor,
      yieldTimeMs: 1000,
      maxOutputBytes: 1024,
    };
    // Scope loss before observation is still a definite no-drain rejection.
    await f.app.setThreadArchived(f.thread.id, true);
    await assert.rejects(
      f.client[operation](f.peer, observation),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(
          (error as Error & { confirmedRejection?: boolean })
            .confirmedRejection,
          true,
        );
        assert.match(error.message, /stale_thread/u);
        return true;
      },
    );
    assert.equal(observations, 0);
    assert.equal(cancellations, 0);
    await f.app.setThreadArchived(f.thread.id, false);
    if (operation === "wait") release();
    await assert.rejects(
      f.client[operation](f.peer, observation),
      (error: unknown) => {
        assertUnknown(error);
        return true;
      },
    );
    assert.equal((await f.app.readThread(f.thread.id)).archived, true);
    assert.equal(observations, 1);
    assert.equal(cancellations, operation === "cancel" ? 1 : 0);
    await f.app.setThreadArchived(f.thread.id, false);
    const replay = await f.client[operation](f.peer, observation);
    assert.deepEqual(
      replay,
      withheldReceipt,
      "the exact ACK must recover the withheld cursor and output without draining again",
    );
    assert.equal(replay.taskId, running.taskId);
    assert.equal(replay.admissionId, request.admissionId);
    if (operation === "wait")
      assert.equal(replay.output, "withheld-sensitive-result");
    else
      assert.ok(
        ["cancelled", "cancel_requested", "cancellation_unconfirmed"].includes(
          replay.status,
        ),
      );
    assert.equal(effects, 1);
  });
}

test("TLS adapter preserves confirmed pre-admission archival rejection without creating a recovery handle", async (t) => {
  const f = await fixture(t);
  const request = await f.request("archived-before-admission");
  const transport = await tlsAdapter(f);
  await f.app.setThreadArchived(f.thread.id, true);
  await assert.rejects(
    transport.adapter.invoke(adapterExecute(f, request)),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(
        (error as Error & { confirmedRejection?: boolean }).confirmedRejection,
        true,
      );
      assert.match(error.message, /stale_thread/u);
      assert.doesNotMatch(error.message, /fleet-tool:v1:/u);
      return true;
    },
  );
  assert.equal(f.executions(), 0);
});

test("TLS adapter retains an admitted running task when waitForCompletion loses scope before its first wait", async (t) => {
  let release!: () => void;
  let effects = 0;
  const finish = new Promise<void>((resolve) => {
    release = resolve;
  });
  t.after(() => release());
  const f = await fixture(t, {
    runtime: {
      name: "pending-effect",
      remoteExecution: "text-json",
      enforcesSandbox: true,
      specification: {
        name: "pending-effect",
        description: "Pending effect retained across scope restoration",
        inputSchema: { type: "object" },
      },
      async execute(invocation) {
        effects++;
        await finish;
        assert.equal(invocation.signal.aborted, false);
        return { output: "original admitted result", exitCode: 0 };
      },
    },
  });
  const request = await f.request("admitted-before-wait");
  const transport = await tlsAdapter(f);
  const execute = f.client.execute.bind(f.client);
  let accepted: RemoteToolResult | undefined;
  let executeRequests = 0;
  f.client.execute = async (...args) => {
    executeRequests++;
    accepted = await execute(...args);
    assert.ok(["queued", "running"].includes(accepted.status));
    // Execute has already returned a successful admitted receipt over TLS.
    // Only its subsequent observation loses scope before being sent.
    await f.app.setThreadArchived(f.thread.id, true);
    return accepted;
  };
  const wait = f.client.wait.bind(f.client);
  const waits: Parameters<NativeFleetClient["wait"]>[1][] = [];
  let waitError: unknown;
  f.client.wait = async (device, observation, signal) => {
    waits.push(structuredClone(observation));
    try {
      return await wait(device, observation, signal);
    } catch (error) {
      waitError = error;
      throw error;
    }
  };
  const invocation = adapterExecute(f, request);
  let adapterError!: Error;
  await assert.rejects(
    transport.adapter.invoke({
      ...invocation,
      task: { waitForCompletion: true },
      arguments: { ...invocation.arguments, yield_time_ms: 1 },
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      adapterError = error;
      return true;
    },
  );
  assert.ok(waitError instanceof Error);
  assert.equal(
    (waitError as Error & { confirmedRejection?: boolean }).confirmedRejection,
    true,
    "the individual wait was definitely rejected before observation",
  );
  assert.match(waitError.message, /stale_thread/u);
  assert.notEqual(
    (adapterError as Error & { confirmedRejection?: boolean })
      .confirmedRejection,
    true,
    "the already admitted execution is not a definitely rejected mutation",
  );
  assert.equal(adapterError.cause, waitError);
  assert.match(adapterError.message, /do not rerun the mutation/u);
  const { handle, binding } = recoveryHandle(adapterError);
  const sent = transport.sent();
  assert.deepEqual(binding, {
    device: f.peer.id,
    deviceKey: fleetDeviceKey(f.peer),
    hostId: f.peer.hostId,
    sourceThreadId: sent.sourceThreadId,
    workspaceId: sent.workspaceId,
    targetThreadId: sent.targetThreadId,
    processEpoch: sent.processEpoch,
    admissionId: sent.admissionId,
  });
  assert.equal(waits.length, 1);
  assert.equal(waits[0]!.admissionId, sent.admissionId);
  assert.equal(waits[0]!.taskId, accepted!.taskId);
  assert.equal(waits[0]!.ackCursor, accepted!.cursor);
  assert.equal(effects, 1);
  await f.app.setThreadArchived(f.thread.id, false);
  const observe = (name: "wait" | "zenx_fleet_tool_status", taskId: string) =>
    transport.adapter.invoke({
      name,
      arguments:
        name === "wait"
          ? { task_id: taskId, yield_time_ms: 1000 }
          : { task_id: taskId },
      callId: "recover-running-effect",
      threadId: sent.sourceThreadId,
      cwd: f.cwd,
      signal: AbortSignal.timeout(10_000),
    });
  const pending = JSON.parse(
    (await observe("zenx_fleet_tool_status", handle)).output,
  );
  assert.equal(
    pending.status,
    "running",
    "body must remain pending until released",
  );
  assert.equal(pending.admissionId, sent.admissionId);
  assert.equal(pending.taskId, accepted!.taskId);
  release();
  // The original operation identity and last receipt reobserve the admitted task.
  const current = await observe("wait", handle);
  const qualified = (current.structuredContent as { task_id: string }).task_id;
  const completed = await observe("wait", qualified);
  assert.equal(
    (completed.structuredContent as { status: string }).status,
    "completed",
  );
  assert.match(completed.output, /original admitted result/u);
  assert.ok(
    waits.every((observation) => observation.admissionId === sent.admissionId),
  );
  assert.equal(effects, 1);
  assert.equal(
    executeRequests,
    1,
    "restored-scope recovery must never resend execute",
  );
});
