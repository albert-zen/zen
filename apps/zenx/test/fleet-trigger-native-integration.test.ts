import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, chmod } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createHostedAppServer } from "../../cli/src/host.js";
import { InMemoryThreadJournal } from "../../../src/journal.js";
import { FleetHostService } from "../src/main/fleet-host.js";
import { FleetSettingsService } from "../src/main/fleet-settings.js";
import { AppServerManager } from "../src/main/app-server-manager.js";
import { createBundledAutomationPluginService } from "../src/main/automation-plugin-service.js";
import {
  ZenXRoomsCapabilityPackage,
  ZenXTriggersCapabilityPackage,
} from "../src/main/capabilities/automation-control-package.js";
import { deliverAssistantInput } from "../src/main/assistant-preset.js";
import type { ZenXTrigger } from "../src/main/trigger-types.js";

async function until(check: () => boolean, maximum = 10_000) {
  const end = Date.now() + maximum;
  while (!check() && Date.now() < end)
    await new Promise((resolve) => setTimeout(resolve, 20));
  assert(
    check(),
    "Native completion did not reach the expected canonical result",
  );
}

test(
  "native source completion reaches a canonical local assistant wakeup and an explicit Rooms tool post",
  { timeout: 30_000 },
  async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "fleet-native-assistant-slice-"),
    );
    const remoteDirectory = path.join(directory, "remote");
    const localDirectory = path.join(directory, "local");
    await mkdir(remoteDirectory);
    await mkdir(localDirectory);
    const certFile = path.join(directory, "cert.pem");
    const keyFile = path.join(directory, "key.pem");
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
    await chmod(keyFile, 0o600);
    const sourceHost = createHostedAppServer({
      cwd: remoteDirectory,
      dataDirectory: path.join(remoteDirectory, "data"),
      model: "fake",
      provider: { type: "fake" },
      journal: new InMemoryThreadJournal(),
      approvalPolicy: "never",
    });
    const sourceGateway = new FleetHostService(sourceHost, {
      request: async () => ({ rooms: [] }),
      subscribe: () => () => {},
    });
    const manager = new AppServerManager({
      entryPath: fileURLToPath(
        new URL("../src/main/app-server-host.ts", import.meta.url),
      ),
      tokenFile: path.join(localDirectory, "runtime/token"),
      descriptorFile: path.join(localDirectory, "runtime/app-server.json"),
      hostConfig: {
        cwd: localDirectory,
        dataDirectory: path.join(localDirectory, "data"),
        model: "fake",
        models: ["fake"],
        approvalPolicy: "never",
        provider: { type: "fake" },
      },
      execArgv: ["--import", "tsx"],
      startupTimeoutMs: 10_000,
    });
    let automation:
      | Awaited<ReturnType<typeof createBundledAutomationPluginService>>
      | undefined;
    try {
      await sourceGateway.control("configure", {
        enabled: true,
        hostId: "native-source-fixture",
        bindAddress: "127.0.0.1",
        port: 0,
        tlsCertificateFile: certFile,
        tlsKeyFile: keyFile,
        grantFile: path.join(remoteDirectory, "grants.json"),
        access: "read",
        workspaces: [
          { id: "remote-work", label: "Remote Work", cwd: remoteDirectory },
        ],
      });
      await manager.start();
      const fleet = new FleetSettingsService({
        directory: localDirectory,
        nativeCa: await readFile(certFile),
        encryption: {
          isEncryptionAvailable: () => true,
          encryptString: (s) => Buffer.from([...s].reverse().join("")),
          decryptString: (b) => [...b.toString()].reverse().join(""),
        },
        manager: () => manager,
        workspaces: async () => [],
      });
      const pairing = (await sourceGateway.control("pair")) as { code: string };
      await fleet.pair({
        id: "source",
        label: "Source Host",
        transport: "https",
        hostId: "native-source-fixture",
        endpoint: sourceGateway.status().url!,
        workspace: "remote-work",
        access: "read",
        code: pairing.code,
      });
      automation = await createBundledAutomationPluginService({
        userDataDirectory: localDirectory,
        threadTargets: {
          projectProjection: { canonicalKeys: async (values) => values },
          request: (method, params) => manager.request(method, params),
        },
        appServer: {
          request: (method, params) => manager.request(method, params),
          onNotification: (listener) => manager.onNotification(listener),
          readThread: (threadId) =>
            manager.request("thread/read", { threadId, includeTurns: true }),
          sendAssistant: (params, signal) =>
            deliverAssistantInput(manager, params, signal),
          resolveRemoteThread: (device, workspace, target) =>
            fleet.resolveRemoteThread(device, workspace, target),
          readRemoteThread: (device, workspace, threadId, turnId) =>
            fleet.readRemoteThread(device, workspace, threadId, turnId),
          subscribeRemoteThread: (
            device,
            workspace,
            threadId,
            options,
            signal,
          ) =>
            fleet.subscribeRemoteThread(
              device,
              workspace,
              threadId,
              options,
              signal,
            ),
        },
      });
      await automation.startPlugin("zenx-rooms", {} as never);
      await automation.startPlugin("zenx-triggers", {} as never);
      const assistant = (await manager.request("thread/start", {})).thread;
      const room = await automation.createAssistantRoom({
        name: "Assistant",
        members: [{ name: "Assistant", threadId: assistant.id }],
      });
      const source = await sourceHost.startThread();
      const triggers = new ZenXTriggersCapabilityPackage(automation);
      const watch = (await triggers.invoke("zenx_triggers_create", {
        name: "zenx_triggers_create",
        callId: "install-remote-watch",
        threadId: assistant.id,
        cwd: localDirectory,
        signal: new AbortController().signal,
        arguments: {
          kind: "thread",
          watchedThreadId: source.id,
          sourceDevice: "source",
          sourceWorkspace: "Remote Work",
          label: "Source done",
          prompt: `Read the exact source Turn and post its result to Room ${room.id}`,
        },
      })) as ZenXTrigger;
      assert.equal(watch.watch?.sourceWorkspace, "remote-work");
      assert.equal(watch.threadId, assistant.id);
      const turn = await sourceHost.startTurn(source.id, [
        { type: "text", text: "Remote source completed its fake task" },
      ]);
      await turn.done;
      await until(() =>
        automation!
          .snapshot()
          .history.some(
            (entry) =>
              entry.triggerId === watch.id && entry.status === "completed",
          ),
      );
      const history = automation
        .snapshot()
        .history.find((entry) => entry.triggerId === watch.id)!;
      assert.equal(history.sourceDevice, "source");
      assert.equal(history.sourceWorkspace, "remote-work");
      assert.equal(history.sourceThreadId, source.id);
      assert.equal(history.sourceTurnId, turn.id);
      assert.equal(
        automation
          .snapshot()
          .triggers.find((trigger) => trigger.id === watch.id)?.active,
        false,
      );
      const local = await manager.request("thread/read", {
        threadId: assistant.id,
        includeTurns: true,
      });
      const inputs = local.thread.turns
        .flatMap((value) => value.items)
        .filter(
          (item) =>
            item.type === "userMessage" &&
            item.clientId === history.clientUserMessageId,
        );
      assert.equal(inputs.length, 1);
      assert.match(JSON.stringify(inputs), /Source device: source/u);
      assert.match(JSON.stringify(inputs), new RegExp(turn.id, "u"));
      assert.equal(
        automation
          .snapshot()
          .rooms.find((value) => value.id === room.id)
          ?.messages.filter((message) => message.kind === "agent").length,
        0,
      );
      const result = await automation.result(history.id);
      assert.equal(result.turnId, turn.id);
      assert.match(result.preview, /Remote source completed its fake task/u);
      // Deterministic fake-assistant decision: read the actual result, then invoke
      // the real Agent Rooms tool. Completion does not auto-post final output.
      const rooms = new ZenXRoomsCapabilityPackage(automation);
      await rooms.invoke("zenx_rooms_post_message", {
        name: "zenx_rooms_post_message",
        callId: "explicit-result-post",
        threadId: assistant.id,
        cwd: localDirectory,
        signal: new AbortController().signal,
        arguments: {
          roomId: room.id,
          text: `Remote task completed: ${result.preview}`,
        },
      });
      const posted = automation
        .snapshot()
        .rooms.find((value) => value.id === room.id)!
        .messages.filter((message) => message.kind === "agent");
      assert.equal(posted.length, 1);
      assert.match(posted[0]!.text, /Remote source completed its fake task/u);
      assert.equal(
        automation
          .snapshot()
          .history.filter((entry) => entry.triggerId === watch.id).length,
        1,
      );
    } finally {
      await automation?.stopPlugin("zenx-triggers");
      await automation?.stopPlugin("zenx-rooms");
      await manager.stop();
      await sourceGateway.close();
      await sourceHost.closeHostResources();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
