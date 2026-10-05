import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { createHostedAppServer } from "../../cli/src/host.js";
import { InMemoryThreadJournal } from "../../../src/journal.js";
import { ShellToolRuntime, ToolEnvironment } from "../../../src/tool.js";
import {
  RemoteHostAccess,
  type RemoteShellPort,
} from "../../../src/protocol/native/remote-host.js";
import { serveRemoteHost } from "../../../src/protocol/native/remote-transport.js";
import { FleetShellGateway } from "../src/main/fleet-shell.js";
import {
  FleetRouter,
  type NativeFleetDevice,
  type FleetRequest,
} from "../src/main/fleet.js";
import {
  NativeFleetClient,
  type NativeFleetCredential,
} from "../src/main/fleet-native.js";
import { ZenXFleetCapabilityPackage } from "../src/main/capabilities/fleet-package.js";
import type { FleetSettingsService } from "../src/main/fleet-settings.js";
import type { ZenXSelfControlCapabilityPackage } from "../src/main/capabilities/self-control-package.js";
import { fleetManifest } from "../../../packages/zenx-fleet-plugin/src/manifest.js";

// Two throwaway in-process Hosts on loopback TLS, not physical-machine validation.
async function loopback(
  t: TestContext,
  wrap?: (shell: RemoteShellPort) => RemoteShellPort,
) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "fleet-shell-native-"));
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
  const tools = new ToolEnvironment({
    runtimes: [new ShellToolRuntime({ terminationGraceMs: 50 })],
  });
  const app = createHostedAppServer({
    cwd,
    dataDirectory: path.join(cwd, "data"),
    provider: { type: "fake" },
    model: "fake",
    journal: new InMemoryThreadJournal(),
    approvalPolicy: "never",
    toolEnvironment: tools,
  });
  const gateway = new FleetShellGateway(tools);
  const host = new RemoteHostAccess({
    appServer: app,
    hostId: "target",
    access: "control",
    shellEnabled: true,
    shell: wrap ? wrap(gateway) : gateway,
    workspaces: () => [{ id: "workspace", label: "Loopback", cwd }],
  });
  const server = await serveRemoteHost({
    enabled: true,
    listen: "127.0.0.1",
    port: 0,
    tls: { cert, key },
    access: host,
  });
  const peer: NativeFleetDevice = {
    id: "remote",
    label: "Target fixture",
    transport: "https",
    endpoint: server.url.replace(/^wss:/, "https:").replace(/\/remote$/, ""),
    hostId: "target",
    access: "control",
    shellEnabled: true,
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
  const router = new FleetRouter(
    async () => ({ version: 1, devices: [peer] }),
    undefined,
    client,
  );
  const thread = await app.startThread({ cwd });
  await client.pair(peer, host.createPairingCode());
  t.after(async () => {
    await server.close();
    host.close();
    await app.closeHostResources();
    await tools.close();
    await rm(cwd, { recursive: true, force: true });
  });
  const request = (
    command = "printf remote",
    extra: Record<string, unknown> = {},
  ): FleetRequest => ({
    version: 1,
    name: "zenx_fleet_shell",
    arguments: {
      workspace: "workspace",
      targetThreadId: thread.id,
      command,
      ...extra,
    },
    callId: "caller-call",
    threadId: "caller-thread",
  });
  return {
    cwd,
    app,
    tools,
    host,
    server,
    peer,
    client,
    router,
    thread,
    request,
  };
}
async function started(file: string) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    try {
      return Number(await readFile(file, "utf8"));
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Loopback shell never started");
}

test("loopback TLS shell returns in the caller's canonical Fleet result with no target transcript mutation", async (t) => {
  const f = await loopback(t);
  const before = await f.app.readThread(f.thread.id);
  const package_ = new ZenXFleetCapabilityPackage({
    fleet: { router: f.router } as FleetSettingsService,
    threads: {} as ZenXSelfControlCapabilityPackage,
  });
  const definition = fleetManifest.tools.find(
    (tool) => tool.name === "zenx_fleet_shell",
  )!;
  const callerTools = new ToolEnvironment({
    bundles: [
      {
        identity: { kind: "external", id: "fleet-fixture" },
        tools: [
          {
            name: definition.name,
            specification: definition,
            execute: async (invocation) => ({
              output: JSON.stringify(
                await package_.invoke(invocation.name, invocation),
              ),
              exitCode: 0,
            }),
          },
        ],
      },
    ],
  });
  const caller = createHostedAppServer({
    cwd: f.cwd,
    dataDirectory: path.join(f.cwd, "caller-data"),
    provider: { type: "fake" },
    model: "fake",
    journal: new InMemoryThreadJournal(),
    approvalPolicy: "never",
    toolEnvironment: callerTools,
    toolPresentation: "direct",
  });
  t.after(async () => {
    await caller.closeHostResources();
    await callerTools.close();
  });
  const callerThread = await caller.startThread({});
  const turn = await caller.startTurn(
    callerThread.id,
    `!tool zenx_fleet_shell ${JSON.stringify({ device: "remote", ...f.request().arguments })}`,
  );
  await turn.done;
  const callerState = await caller.readThread(callerThread.id);
  const result = callerState.items.find((item) => item.type === "tool_result");
  assert.ok(result && result.type === "tool_result");
  assert.equal(result.exitCode, 0);
  const receipt = JSON.parse(result.output);
  assert.equal(receipt.device, "remote");
  assert.equal(receipt.result.output, "remote");
  assert.equal(receipt.result.targetThreadId, f.thread.id);
  const after = await f.app.readThread(f.thread.id);
  assert.deepEqual(after.items, before.items);
  assert.deepEqual(after.turns, before.turns);
});

test("loopback TLS shell cancellation waits for the original terminal cleanup result", async (t) => {
  const f = await loopback(t);
  const controller = new AbortController();
  const pidFile = path.join(f.cwd, "pid");
  const done = f.client.invoke(
    f.peer,
    f.request(`printf '%s' $$ > '${pidFile}'; sleep 20`, { timeout_ms: 3000 }),
    controller.signal,
  );
  const pid = await started(pidFile);
  controller.abort();
  const result = (await done) as { status: string; exitCode: number };
  assert.equal(result.status, "cancelled");
  assert.equal(result.exitCode, 130);
  assert.throws(
    () => process.kill(pid, 0),
    (error: unknown) => (error as NodeJS.ErrnoException).code === "ESRCH",
  );
  assert.equal(f.tools.taskManager.activeTaskCount, 0);
});

test("disconnected loopback shell stops its process and is never automatically replayed", async (t) => {
  let executions = 0;
  const f = await loopback(t, (gateway) => ({
    execute: async (...args) => {
      executions++;
      return await gateway.execute(...args);
    },
  }));
  const pidFile = path.join(f.cwd, "pid");
  const done = f.client.invoke(
    f.peer,
    f.request(`printf '%s' $$ > '${pidFile}'; sleep 20`, { timeout_ms: 3000 }),
    new AbortController().signal,
  );
  const rejected = assert.rejects(
    done,
    /admission may be unknown.*No automatic retry/,
  );
  const pid = await started(pidFile);
  await f.server.close();
  await rejected;
  const deadline = Date.now() + 3000;
  while (f.tools.taskManager.activeTaskCount && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(f.tools.taskManager.activeTaskCount, 0);
  assert.throws(
    () => process.kill(pid, 0),
    (error: unknown) => (error as NodeJS.ErrnoException).code === "ESRCH",
  );
  assert.equal(executions, 1);
});

test("lost shell completion acknowledgement remains unknown and does not re-admit", async (t) => {
  let executions = 0;
  const f = await loopback(t, (gateway) => ({
    execute: async (...args) => {
      executions++;
      await gateway.execute(...args);
      throw new Error("Fixture lost shell completion acknowledgement");
    },
  }));
  const file = path.join(f.cwd, "effects");
  await assert.rejects(
    f.client.invoke(
      f.peer,
      f.request(`printf once >> '${file}'`),
      new AbortController().signal,
    ),
    (error: unknown) =>
      error instanceof Error &&
      /outcome unknown.*No automatic retry/.test(error.message) &&
      !(error as { confirmedRejection?: boolean }).confirmedRejection,
  );
  assert.equal(await readFile(file, "utf8"), "once");
  assert.equal(executions, 1);
});
