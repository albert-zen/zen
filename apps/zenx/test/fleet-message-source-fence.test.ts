import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import os from "node:os";
import test from "node:test";
import { FleetSettingsService } from "../src/main/fleet-settings.js";
import { FleetProductService } from "../src/main/fleet-product.js";
import { fleetDeviceKey, type FleetConfig } from "../src/main/fleet.js";
import type { AppServerManager } from "../src/main/app-server-manager.js";

// Each case starts with an otherwise valid canonical source receipt. Mutation
// happens inside a specific await that preceded the old authorization decision.
for (const phase of [
  "read-workspace",
  "send-canonical",
  "send-native-preparation",
  "read-final-status",
  "product-read",
] as const)
  for (const change of [
    "binding",
    "grant",
    "access",
    "scope",
    "manager",
    "epoch",
    "repair",
    "credentials",
  ] as const)
    test(`source fence rejects ${change} during ${phase} without disclosing history or dispatching`, async (t) => {
      const directory = await mkdtemp(path.join(os.tmpdir(), "source-fence-"));
      t.after(() => rm(directory, { recursive: true, force: true }));
      const peer = {
        id: "peer",
        transport: "https" as const,
        hostId: "source-host",
        endpoint: "https://source.invalid",
        workspace: "source-workspace",
        access: "control" as const,
        label: "Same label",
      };
      const binding = {
        inboundDeviceId: "incoming",
        hostId: peer.hostId,
        workspaceId: peer.workspace,
        deviceId: peer.id,
        deviceKey: fleetDeviceKey(peer),
      };
      const config: FleetConfig = {
        version: 1,
        devices: [peer],
        messageSources: [binding],
        hosting: {
          enabled: true,
          bindAddress: "127.0.0.1",
          port: 4443,
          tlsCertificateFile: "/cert.pem",
          tlsKeyFile: "/key.pem",
          access: "control",
        },
      };
      const workspace = createHash("sha256")
        .update(directory)
        .digest("hex")
        .slice(0, 24);
      const grant = {
        deviceId: "incoming",
        revoked: false,
        access: "control",
        workspaceIds: [workspace],
        digest: "a".repeat(64),
      };
      const thread = {
        id: "receiver",
        cwd: directory,
        items: [
          {
            id: "receipt",
            type: "thread_message",
            sender: {
              deviceId: "incoming",
              threadId: "source",
              toolCallId: "origin",
              callId: "origin",
              origin: { hostId: peer.hostId, workspaceId: peer.workspace },
              returnRoute: {
                receiverHostId: "receiver-host",
                hostId: peer.hostId,
                workspaceId: peer.workspace,
                deviceId: peer.id,
                deviceKey: binding.deviceKey,
              },
            },
          },
          { id: "reply-tool", type: "tool_call", callId: "reply-call" },
        ],
      };
      const saveConfig = () =>
        writeFile(path.join(directory, "fleet.json"), JSON.stringify(config));
      const saveGrant = () =>
        writeFile(
          path.join(directory, "fleet-device-grants.json"),
          JSON.stringify({
            version: 1,
            hostId: "receiver-host",
            devices: [grant],
          }),
        );
      await saveConfig();
      await saveGrant();
      await writeFile(path.join(directory, "fleet-host-id"), "receiver-host");
      let changed = false,
        reads = 0,
        scopes = 0,
        statuses = 0,
        dispatched = 0,
        publicReads = 0;
      const mutate = async () => {
        if (changed) return;
        changed = true;
        if (change === "binding") {
          config.messageSources = [];
          await saveConfig();
        }
        if (change === "grant") {
          grant.revoked = true;
          await saveGrant();
        }
        if (change === "access") {
          grant.access = "read";
          await saveGrant();
        }
        if (change === "scope") {
          grant.workspaceIds = [];
          await saveGrant();
        }
        if (change === "manager") currentManager = { ...manager };
        if (change === "epoch") manager.processEpoch = "restarted";
        if (change === "repair") {
          grant.digest = "b".repeat(64);
          await saveGrant();
        }
        if (change === "credentials")
          await writeFile(
            path.join(directory, "fleet-vault.json"),
            "new encrypted synthetic credential generation",
          );
      };
      const manager = {
        processEpoch: "epoch-one",
        request: async () => {
          if (++reads === 2 && phase === "send-canonical") await mutate();
          return { thread };
        },
        fleetControl: async () => {
          const result = {
            enabled: true,
            hostId: "receiver-host",
            clients: [{ ...grant, workspaceIds: [...grant.workspaceIds] }],
          };
          if (++statuses === 4 && phase === "read-final-status") await mutate();
          return result;
        },
      };
      let currentManager = manager;
      const fleet = new FleetSettingsService({
        directory,
        manager: () => currentManager as unknown as AppServerManager,
        workspaces: async () => {
          if (++scopes === 2 && phase === "read-workspace") await mutate();
          return [{ cwd: directory, label: "Receiver" }];
        },
        encryption: {
          isEncryptionAvailable: () => true,
          encryptString: (v) => Buffer.from(v),
          decryptString: (v) => v.toString(),
        },
      });
      fleet.native.invoke = async (_peer, request, _signal, fence) => {
        if (request.name === "zenx_threads_send") {
          if (phase === "send-native-preparation") await mutate();
          assert.ok(
            fence,
            "source reply must propagate its local fence to native dispatch",
          );
          await fence.revalidate();
          fence.assertUnchanged();
          dispatched++;
          return { threadId: "source", turnId: "must-not-send" };
        }
        if (++publicReads === 2 && phase === "product-read") await mutate();
        return { threadId: "source", items: [{ text: "MUST_NOT_DISCLOSE" }] };
      };
      await assert.rejects(
        phase === "product-read"
          ? new FleetProductService(fleet).sourceHistory({
              receipt: { threadId: "receiver", itemId: "receipt" },
              locator: {
                deviceId: peer.id,
                deviceKey: binding.deviceKey,
                hostId: peer.hostId,
                workspace: peer.workspace,
                threadId: "source",
              },
              cursor: "page",
            })
          : fleet.messageSource(
              { threadId: "receiver", itemId: "receipt" },
              phase.startsWith("send")
                ? {
                    name: "zenx_fleet_source_send",
                    arguments: { text: "must-not-send" },
                    threadId: "receiver",
                    canonicalToolCallId: "reply-tool",
                    callId: "reply-call",
                    cwd: directory,
                    signal: AbortSignal.timeout(5000),
                  }
                : undefined,
            ),
        /authorization changed|inbound authorization changed/,
      );
      assert.equal(
        changed,
        true,
        "the intended asynchronous seam was exercised",
      );
      assert.equal(dispatched, 0);
    });
