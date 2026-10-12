import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createHostedAppServer } from "../../cli/src/host.js";
import { InMemoryThreadJournal } from "../../../src/journal.js";
import { RemoteHostAccess } from "../../../src/protocol/native/remote-host.js";
import { serveRemoteHost } from "../../../src/protocol/native/remote-transport.js";
import { FleetSettingsService } from "../src/main/fleet-settings.js";
import { FleetProductService } from "../src/main/fleet-product.js";
import type { AppServerManager } from "../src/main/app-server-manager.js";

test("two synthetic TLS Hosts expose distinct catalogs; desktop Fleet create/send/read stays on its selected Host", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "fleet-product-native-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const certFile = path.join(root, "cert.pem"),
    keyFile = path.join(root, "key.pem");
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
  const targets = await Promise.all(
    ["a", "b"].map(async (id) => {
      const app = createHostedAppServer({
        cwd: root,
        dataDirectory: path.join(root, id),
        provider: { type: "fake" },
        model: `model-${id}`,
        models: [`model-${id}`],
        journal: new InMemoryThreadJournal(),
        approvalPolicy: "never",
      });
      const access = new RemoteHostAccess({
        appServer: app,
        hostId: `host-${id}`,
        access: "control",
        workspaces: () => [
          { id: `workspace-${id}`, label: `${id} workspace`, cwd: root },
        ],
      });
      const server = await serveRemoteHost({
        enabled: true,
        listen: "127.0.0.1",
        port: 0,
        tls: { cert, key },
        access,
      });
      t.after(async () => {
        access.close();
        await server.close();
        await app.closeHostResources();
      });
      return {
        id,
        app,
        access,
        endpoint: server.url
          .replace(/^wss:/u, "https:")
          .replace(/\/remote$/u, ""),
      };
    }),
  );
  const fleet = new FleetSettingsService({
    directory: path.join(root, "client"),
    nativeCa: cert,
    encryption: {
      isEncryptionAvailable: () => true,
      encryptString: (value) => Buffer.from(value),
      decryptString: (value) => value.toString(),
    },
    manager: () =>
      ({
        fleetControl: async () => ({ enabled: false, clients: [] }),
      }) as unknown as AppServerManager,
    workspaces: async () => [],
  });
  for (const target of targets)
    await fleet.pair({
      id: target.id,
      label: target.id,
      description: `Use ${target.id} only for its own tasks`,
      endpoint: target.endpoint,
      hostId: `host-${target.id}`,
      code: target.access.createPairingCode(),
      access: "control",
    });
  const product = new FleetProductService(fleet);
  const [a, b] = await Promise.all([
    product.catalog("a"),
    product.catalog("b"),
  ]);
  assert.notEqual(a.models[0]!.id, b.models[0]!.id);
  assert.match(a.models[0]!.id, /model-a/u);
  assert.match(b.models[0]!.id, /model-b/u);
  const locator = await product.create({
    deviceId: "b",
    deviceKey: b.machine.key,
    workspace: b.workspaces[0]!.id,
    model: b.models[0]!.id,
  });
  assert.equal(locator.hostId, "host-b");
  await product.send({
    locator,
    text: "Hello from the selected machine fixture",
  });
  const until = Date.now() + 3000;
  while (
    (await product.status(locator)).status === "active" &&
    Date.now() < until
  )
    await new Promise((resolve) => setTimeout(resolve, 10));
  const read = await product.read(locator);
  assert.ok(Array.isArray(read.items));
  assert.ok(
    read.items.some(
      (entry) => (entry as { type: string }).type === "agent_message",
    ),
  );
  assert.equal((await targets[0]!.app.listThreads()).length, 0);
  assert.equal(
    (await targets[1]!.app.readThread(locator.threadId)).modelId,
    "model-b",
  );
  await assert.rejects(
    product.read({ ...locator, hostId: "host-a" }),
    /another Host identity/u,
  );
  const target = targets[1]!;
  const originalList = target.access.threads.bind(target.access);
  let archiveAfterList = false;
  target.access.threads = async (...args) => {
    const result = await originalList(...args);
    if (archiveAfterList) {
      archiveAfterList = false;
      await target.app.setThreadArchived(locator.threadId, true);
    }
    return result;
  };
  const completedTurnId = (
    await target.app.readThread(locator.threadId)
  ).turns.at(-1)!.id;
  for (const action of [
    () => product.read(locator),
    () => product.status(locator),
    () =>
      fleet.invoke({
        device: "b",
        name: "zenx_self_control_threads_wait",
        arguments: {
          threadId: locator.threadId,
          workspace: locator.workspace,
          turnId: completedTurnId,
          timeoutSeconds: 1,
        },
      }),
    ...(["guidance", "follow_up", "replacement"] as const).map(
      (messageType) => () =>
        product.send({
          locator,
          text: "Never admit an archived exact target",
          messageType,
        }),
    ),
  ]) {
    await target.app.setThreadArchived(locator.threadId, false);
    archiveAfterList = true;
    const before = (await target.app.readThread(locator.threadId)).items.length;
    await assert.rejects(
      action,
      /stale_thread|operation_forbidden|exact remote Thread is unavailable/u,
    );
    assert.equal(
      (await target.app.readThread(locator.threadId)).items.length,
      before,
    );
  }
  target.access.threads = originalList;
  await target.app.setThreadArchived(locator.threadId, false);

  // Archive after the gateway's canonical check but before the locked Core
  // admission. The target, not a caller-side preflight, must enforce this fence.
  const originalStart = target.app.startTurn.bind(target.app);
  target.app.startTurn = async (...args) => {
    await target.app.setThreadArchived(args[0], true);
    return await originalStart(...args);
  };
  const beforeStart = (await target.app.readThread(locator.threadId)).items
    .length;
  await assert.rejects(
    product.send({
      locator,
      text: "Never admit archive raced before Core lock",
    }),
    /operation_forbidden/u,
  );
  assert.equal(
    (await target.app.readThread(locator.threadId)).items.length,
    beforeStart,
  );
  target.app.startTurn = originalStart;
  await target.app.setThreadArchived(locator.threadId, false);
  const originalQueue = target.app.queueMessage.bind(target.app);
  target.app.queueMessage = async (...args) => {
    await target.app.setThreadArchived(args[0], true);
    return await originalQueue(...args);
  };
  const beforeQueue = (await target.app.readThread(locator.threadId)).items
    .length;
  await assert.rejects(
    product.send({
      locator,
      text: "Never enqueue on archive raced before Core lock",
      messageType: "follow_up",
    }),
    /operation_forbidden/u,
  );
  assert.equal(
    (await target.app.readThread(locator.threadId)).items.length,
    beforeQueue,
  );
  target.app.queueMessage = originalQueue;
  await target.app.setThreadArchived(locator.threadId, false);

  const other = await targets[1]!.app.startThread({ cwd: root });
  await targets[1]!.app.setThreadName(other.id, locator.threadId);
  await targets[1]!.app.setThreadArchived(locator.threadId, true);
  for (const action of [
    () => product.read(locator),
    () => product.status(locator),
    () =>
      product.send({
        locator,
        text: "Never deliver an immutable locator to a title collision",
      }),
    () =>
      product.send({
        locator: { ...locator, threadId: other.id.slice(0, 8) },
        text: "Never expand an exact locator prefix",
      }),
  ])
    await assert.rejects(action, /exact remote Thread is unavailable/u);
  assert.equal(
    (await targets[1]!.app.readThread(other.id)).items.filter(
      (item) => item.type === "user_message",
    ).length,
    0,
  );
  assert.equal(
    (await targets[1]!.app.readThread(locator.threadId)).items.filter(
      (item) => item.type === "user_message",
    ).length,
    1,
  );
  const exactWait = await fleet.invoke({
    device: "b",
    name: "zenx_self_control_threads_wait",
    arguments: {
      threadId: locator.threadId,
      workspace: locator.workspace,
      turnId: "never-select-another-turn",
      timeoutSeconds: 1,
    },
  });
  assert.equal(
    (exactWait as { result: { status: string } }).result.status,
    "not_found",
  );
  const explicitFuzzy = await fleet.invoke({
    device: "b",
    name: "zenx_threads_status",
    arguments: { target: locator.threadId, workspace: locator.workspace },
  });
  assert.equal(
    (explicitFuzzy as { result: { threadId: string } }).result.threadId,
    other.id,
  );
});
