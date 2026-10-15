import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fixture } from "../../../test/thread-message-fixture.js";
import { compileModelMessages, type ModelEvent } from "../../../src/model.js";
import { RemoteHostAccess } from "../../../src/protocol/native/remote-host.js";
import { serveRemoteHost } from "../../../src/protocol/native/remote-transport.js";
import {
  FleetSettingsService,
  type FleetMessageSourceView,
} from "../src/main/fleet-settings.js";
import {
  fleetDeviceKey,
  parseFleetConfig,
  type FleetConfig,
  type NativeFleetDevice,
} from "../src/main/fleet.js";
import { ZenXFleetCapabilityPackage } from "../src/main/capabilities/fleet-package.js";
import type { AppServerManager } from "../src/main/app-server-manager.js";
import type { ToolInvocation } from "../../../src/tool.js";
import { createFleetRoomsHandler } from "../src/main/fleet-rooms.js";
import type { ZenXBundledAutomationPluginService } from "../src/main/automation-plugin-service.js";

const invocation = (
  name: string,
  args: Record<string, unknown>,
): ToolInvocation => ({
  name,
  arguments: args,
  callId: "model-call",
  cwd: os.tmpdir(),
  signal: AbortSignal.timeout(10000),
});

test("two real HTTPS Hosts preserve remote source identity and model exact read/reply across asymmetric pairing IDs", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "fleet-source-e2e-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const certFile = path.join(directory, "cert.pem"),
    keyFile = path.join(directory, "key.pem");
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
  const makeHost = async (hostId: string) => {
    const cwd = path.join(directory, hostId);
    await mkdir(cwd);
    const workspace = createHash("sha256")
      .update(cwd)
      .digest("hex")
      .slice(0, 24);
    const f = fixture({
      provider: hostId,
      async *stream(): AsyncIterable<ModelEvent> {
        yield { type: "text_delta", delta: "reply from " + hostId };
      },
    });
    const grantFile = path.join(cwd, "fleet-device-grants.json");
    const triggers: any[] = [];
    const automation = {
      triggersAvailable: () => true,
      snapshot: () => ({ triggers }),
    } as unknown as ZenXBundledAutomationPluginService;
    const accessOptions = {
      appServer: f.server,
      hostId,
      grantFile,
      access: "control" as const,
      workspaces: () => [{ id: workspace, cwd, label: "Same label" }],
      rooms: {
        subscribe: () => () => {},
        request: (
          operation: "list" | "read" | "post" | "trigger",
          params: any,
        ) =>
          createFleetRoomsHandler(manager, () => automation)(operation, params),
      },
    };
    let access = new RemoteHostAccess(accessOptions);
    let server = await serveRemoteHost({
      enabled: true,
      listen: "127.0.0.1",
      port: 0,
      tls: { cert, key },
      access,
    });
    const endpoint = server.url
      .replace(/^wss:/u, "https:")
      .replace(/\/remote$/u, "");
    const manager = {
      request: async (_method: string, params: { threadId: string }) => ({
        thread: await f.server.readThread(params.threadId),
      }),
      fleetControl: async () => ({
        enabled: true,
        hostId,
        clients: access.devices(),
      }),
    } as unknown as AppServerManager;
    await writeFile(path.join(cwd, "fleet-host-id"), hostId);
    const fleet = new FleetSettingsService({
      directory: cwd,
      nativeCa: cert,
      manager: () => manager,
      workspaces: async () => [{ cwd, label: "Same label" }],
      encryption: {
        isEncryptionAvailable: () => true,
        encryptString: (v) => Buffer.from(v),
        decryptString: (v) => v.toString(),
      },
    });
    const config: FleetConfig = {
      version: 1,
      devices: [],
      hosting: {
        enabled: true,
        bindAddress: "127.0.0.1",
        port: Number(new URL(endpoint).port),
        tlsCertificateFile: certFile,
        tlsKeyFile: keyFile,
        access: "control",
      },
    };
    const save = () => writeFile(fleet.file, JSON.stringify(config));
    const restart = async () => {
      await server.close();
      access.close();
      access = new RemoteHostAccess({
        ...accessOptions,
        messageSources: config.messageSources,
      });
      server = await serveRemoteHost({
        enabled: true,
        listen: "127.0.0.1",
        port: Number(new URL(endpoint).port),
        tls: { cert, key },
        access,
      });
    };
    const source = async (threadId?: string) => {
      const thread = threadId
        ? await f.server.readThread(threadId)
        : await f.server.startThread({ cwd });
      const turn = await f.server.startTurn(thread.id, "source");
      await turn.done;
      const call = (await f.server.readThread(thread.id)).items.findLast(
        (item) => item.type === "tool_call",
      )!;
      assert.equal(call.type, "tool_call");
      return {
        threadId: thread.id,
        canonicalToolCallId: call.id,
        callId: call.callId,
        cwd,
      };
    };
    t.after(async () => {
      await server.close();
      access.close();
    });
    return {
      ...f,
      triggers,
      cwd,
      workspace,
      endpoint,
      fleet,
      config,
      save,
      restart,
      source,
      access: () => access,
      offline: () => server.close(),
    };
  };
  const a = await makeHost("host-a"),
    b = await makeHost("host-b");
  const peerA: NativeFleetDevice = {
    id: "outbound-a",
    label: "Same label",
    transport: "https",
    endpoint: a.endpoint,
    hostId: "host-a",
    workspace: a.workspace,
    access: "control",
  };
  const peerB: NativeFleetDevice = {
    id: "outbound-b",
    label: "Same label",
    transport: "https",
    endpoint: b.endpoint,
    hostId: "host-b",
    workspace: b.workspace,
    access: "control",
  };
  a.config.devices = [peerB];
  b.config.devices = [peerA];
  await Promise.all([a.save(), b.save()]);
  const ab = await a.fleet.native.pair(peerB, b.access().createPairingCode());
  const ba = await b.fleet.native.pair(peerA, a.access().createPairingCode());
  assert.notEqual(ab.deviceId, peerA.id);
  assert.notEqual(ba.deviceId, peerB.id);
  b.config.messageSources = [
    {
      inboundDeviceId: ab.deviceId,
      hostId: "host-a",
      workspaceId: a.workspace,
      deviceId: peerA.id,
      deviceKey: fleetDeviceKey(peerA),
    },
  ];
  a.config.messageSources = [
    {
      inboundDeviceId: ba.deviceId,
      hostId: "host-b",
      workspaceId: b.workspace,
      deviceId: peerB.id,
      deviceKey: fleetDeviceKey(peerB),
    },
  ];
  await Promise.all([a.save(), b.save()]);
  await Promise.all([a.restart(), b.restart()]);
  const from = await a.source();
  await a.server.setThreadName(from.threadId, "Display-only source");
  const target = await b.server.startThread({ cwd: b.cwd });
  await a.fleet.router.invoke(peerB.id, {
    ...invocation("zenx_threads_send", {
      threadId: target.id,
      workspace: b.workspace,
      text: "source context",
    }),
    ...from,
  });
  const received = (await b.server.readThread(target.id)).items.find(
    (item) => item.type === "thread_message",
  )!;
  assert.equal(received.type, "thread_message");
  assert.equal(received.sender.deviceId, ab.deviceId);
  assert.equal(received.sender.threadName, "Display-only source");
  assert.deepEqual(received.sender.returnRoute, {
    receiverHostId: "host-b",
    hostId: "host-a",
    workspaceId: a.workspace,
    deviceId: peerA.id,
    deviceKey: fleetDeviceKey(peerA),
  });
  const deniedTarget = await b.server.startThread({ cwd: b.cwd });
  await a.fleet.native.invoke(
    peerB,
    {
      version: 1,
      name: "zenx_threads_send",
      callId: "wrong-source-origin",
      threadId: from.threadId,
      canonicalToolCallId: "peer-reported-call",
      source: { origin: { hostId: "forged-host", workspaceId: a.workspace } },
      arguments: {
        workspace: b.workspace,
        threadId: deniedTarget.id,
        text: "Unbound source claim",
      },
    },
    AbortSignal.timeout(10000),
  );
  const unbound = (await b.server.readThread(deniedTarget.id)).items.find(
    (item) => item.type === "thread_message",
  )!;
  assert.equal(unbound.type, "thread_message");
  assert.equal(unbound.sender.returnRoute, undefined);
  await assert.rejects(
    b.fleet.messageSource({ threadId: deniedTarget.id, itemId: unbound.id }),
    /no verified return binding/,
  );
  await assert.rejects(
    a.fleet.native.invoke(
      peerB,
      {
        version: 1,
        name: "zenx_threads_send",
        callId: "forged-return-route",
        threadId: from.threadId,
        canonicalToolCallId: "peer-reported-call",
        source: {
          origin: { hostId: "host-a", workspaceId: a.workspace },
          returnRoute: received.sender.returnRoute,
        } as any,
        arguments: {
          workspace: b.workspace,
          threadId: deniedTarget.id,
          text: "Must reject forged receiver route",
        },
      },
      AbortSignal.timeout(10000),
    ),
    /invalid_request/,
  );
  const model = JSON.stringify(
    compileModelMessages((await b.server.readThread(target.id)).items),
  );
  assert.match(model, /not a message or authorization from the human/);
  assert.ok(model.includes(received.id));
  assert.ok(model.includes(a.workspace));
  const tools = new ZenXFleetCapabilityPackage({
    fleet: b.fleet,
    threads: {} as never,
  });
  const sourceArgs = { threadId: target.id, itemId: received.id };
  const read = (await tools.invoke(
    "zenx_fleet_source_read",
    invocation("zenx_fleet_source_read", sourceArgs),
  )) as FleetMessageSourceView;
  assert.equal(read.locator.deviceId, peerA.id);
  assert.equal(read.locator.workspace, a.workspace);
  assert.equal(read.history.threadId, from.threadId);
  a.triggers.push({
    id: "exact-trigger",
    threadId: from.threadId,
    kind: "signal",
    active: true,
    label: "Remote source settings",
    prompt: "Real remote prompt",
    signal: { name: "go" },
    program: {
      action: { command: "PRIVATE_COMMAND", env: { SECRET: "PRIVATE_ENV" } },
    },
  });
  const triggerArgs = {
    device: peerA.id,
    deviceKey: fleetDeviceKey(peerA),
    workspace: a.workspace,
    threadId: from.threadId,
    triggerId: "exact-trigger",
  };
  const settings = await tools.invoke(
    "zenx_fleet_trigger_read",
    invocation("zenx_fleet_trigger_read", triggerArgs),
  );
  assert.match(JSON.stringify(settings), /Real remote prompt/);
  assert.doesNotMatch(JSON.stringify(settings), /PRIVATE/);
  await assert.rejects(
    tools.invoke(
      "zenx_fleet_trigger_read",
      invocation("zenx_fleet_trigger_read", {
        ...triggerArgs,
        threadId: target.id,
      }),
    ),
    /exact remote Trigger/,
  );
  // Native public recovery preserves all source metadata rather than flattening it.
  const remoteRead = (await a.fleet.native.invoke(
    peerB,
    {
      version: 1,
      name: "zenx_threads_read",
      callId: "inspect",
      arguments: {
        workspace: b.workspace,
        threadId: target.id,
        granularity: "items",
      },
    },
    AbortSignal.timeout(10000),
  )) as { items: Array<{ sender?: typeof received.sender }> };
  assert.deepEqual(
    remoteRead.items.find((item) => item.sender)?.sender,
    received.sender,
  );
  // Let the admitted target turn settle before generating its genuine canonical reply call.
  for (
    let attempt = 0;
    attempt < 100 &&
    (await b.server.readThread(target.id)).turns.some(
      (turn) => turn.status === "inProgress",
    );
    attempt++
  )
    await new Promise((r) => setTimeout(r, 5));
  const replyCall = await b.source(target.id);
  await assert.rejects(
    tools.invoke(
      "zenx_fleet_source_send",
      invocation("zenx_fleet_source_send", {
        ...sourceArgs,
        text: "Must never become a human message",
      }),
    ),
    /canonical Agent tool call/,
  );
  await assert.rejects(
    tools.invoke("zenx_fleet_source_send", {
      ...invocation("zenx_fleet_source_send", {
        ...sourceArgs,
        text: "Must never choose another target",
        target: deniedTarget.id,
      }),
      ...replyCall,
    }),
    /Unexpected Fleet argument: target/,
  );
  await assert.rejects(
    tools.invoke("zenx_fleet_source_send", {
      ...invocation("zenx_fleet_source_send", {
        ...sourceArgs,
        text: "Must never become a human message",
      }),
      ...replyCall,
      trustedPluginUi: true,
    }),
    /canonical Agent tool call/,
  );
  await tools.invoke("zenx_fleet_source_send", {
    ...invocation("zenx_fleet_source_send", {
      ...sourceArgs,
      text: "exact return reply",
    }),
    ...replyCall,
  });
  // A last synchronous authority change after async validation still cannot
  // cross NativeSession's socket.send boundary (not merely the router seam).
  let lastCheckArmed = false,
    lastCheckChanged = false,
    lastChecks = 0;
  const finalArguments = {
    workspace: b.workspace,
    threadId: target.id,
    get text() {
      if (lastCheckArmed) lastCheckChanged = true;
      return "must not reach socket";
    },
  };
  await assert.rejects(
    a.fleet.native.invoke(
      peerB,
      {
        version: 1,
        name: "zenx_threads_send",
        callId: "socket-fence-call",
        threadId: from.threadId,
        canonicalToolCallId: "socket-fence-tool",
        arguments: finalArguments,
      },
      AbortSignal.timeout(10000),
      {
        revalidate: async () => {
          lastCheckArmed = true;
        },
        assertUnchanged: () => {
          lastChecks++;
          if (lastCheckChanged)
            throw new Error("socket-fence rejected stale authority");
        },
      },
    ),
    /socket-fence rejected/,
  );
  assert.equal(lastChecks, 1);
  const returned = (await a.server.readThread(from.threadId)).items.find(
    (item) => item.type === "thread_message",
  )!;
  assert.equal(returned.type, "thread_message");
  assert.equal(returned.sender.threadId, target.id);
  assert.equal(returned.sender.deviceId, ba.deviceId);
  assert.equal(returned.sender.returnRoute?.deviceId, peerB.id);
  // Labels never redirect; endpoint/access/default workspace changes invalidate captured routes.
  peerA.label = "Renamed label";
  await b.save();
  await b.fleet.messageSource(sourceArgs);
  peerA.workspace = "another-workspace";
  await b.save();
  await assert.rejects(
    b.fleet.messageSource(sourceArgs),
    /removed or reconfigured/,
  );
  peerA.workspace = a.workspace;
  await b.save();
  const original = b.config.messageSources;
  b.config.messageSources = [];
  await b.save();
  await assert.rejects(
    b.fleet.messageSource(sourceArgs),
    /binding is missing or changed/,
  );
  b.config.messageSources = original;
  await b.save();
  await a.server.setThreadArchived(from.threadId, true);
  await assert.rejects(
    b.fleet.messageSource(sourceArgs),
    /exact source Thread/,
  );
  await a.server.setThreadArchived(from.threadId, false);
  await a.offline();
  await assert.rejects(
    b.fleet.messageSource(sourceArgs),
    /connection|connect|ECONNREFUSED|unavailable|TLS/i,
  );
  await a.restart();
  // Real TLS target discovery is delayed until after receipt validation. An
  // inbound revocation here must reach the final native socket-write fence.
  const beforeReplies = (await a.server.readThread(from.threadId)).items.filter(
    (item) => item.type === "thread_message",
  ).length;
  const blockedCall = await b.source(target.id);
  const originalInvoke = b.fleet.native.invoke.bind(b.fleet.native);
  const originalList = a.server.listThreadSummaries.bind(a.server);
  const grantsBefore = await readFile(
    path.join(b.cwd, "fleet-device-grants.json"),
  );
  let preparingSend = false,
    revokedDuringDiscovery = false;
  b.fleet.native.invoke = async (...args) => {
    preparingSend = args[1].name === "zenx_threads_send";
    return await originalInvoke(...args);
  };
  a.server.listThreadSummaries = async (...args) => {
    if (preparingSend && !revokedDuringDiscovery) {
      revokedDuringDiscovery = true;
      await new Promise((resolve) => setTimeout(resolve, 5));
      b.access().revoke(ab.deviceId);
    }
    return await originalList(...args);
  };
  try {
    await assert.rejects(
      tools.invoke("zenx_fleet_source_send", {
        ...invocation("zenx_fleet_source_send", {
          ...sourceArgs,
          text: "must not cross revoked TLS route",
        }),
        ...blockedCall,
      }),
      /authorization changed/,
    );
    assert.equal(revokedDuringDiscovery, true);
    assert.equal(
      (await a.server.readThread(from.threadId)).items.filter(
        (item) => item.type === "thread_message",
      ).length,
      beforeReplies,
    );
  } finally {
    b.fleet.native.invoke = originalInvoke;
    a.server.listThreadSummaries = originalList;
    await writeFile(path.join(b.cwd, "fleet-device-grants.json"), grantsBefore);
    await b.restart();
  }
  a.access().revoke(ba.deviceId);
  await assert.rejects(
    b.fleet.messageSource(sourceArgs),
    /revoked|unauthorized/,
  );
  b.access().revoke(ab.deviceId);
  await assert.rejects(b.fleet.messageSource(sourceArgs), /inbound grant/);
  await assert.rejects(
    b.fleet.assertMessageSourceTarget(sourceArgs, read.locator),
    /inbound grant/,
  );
});

test("message binding configuration rejects duplicated identities, guessed keys and local return paths", () => {
  const binding = {
    inboundDeviceId: "incoming-random-id",
    hostId: "source-host",
    workspaceId: "exact-workspace",
    deviceId: "peer",
    deviceKey: "a".repeat(64),
  };
  assert.equal(
    parseFleetConfig({ version: 1, devices: [], messageSources: [binding] })
      .messageSources?.length,
    1,
  );
  for (const messageSources of [
    [binding, binding],
    [{ ...binding, deviceKey: "guessed" }],
    [{ ...binding, deviceId: "local" }],
    [{ ...binding, injected: true }],
  ])
    assert.throws(() =>
      parseFleetConfig({ version: 1, devices: [], messageSources }),
    );
});
