import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AppServerManager } from "../src/main/app-server-manager.js";
import { createBundledAutomationPluginService } from "../src/main/automation-plugin-service.js";
import { ZenXTriggersCapabilityPackage } from "../src/main/capabilities/automation-control-package.js";
import { ZenXPluginCatalog } from "../src/main/capabilities/plugin-catalog.js";
import { MemoryZenXPluginCatalogStore } from "../src/main/capabilities/plugin-catalog-store.js";
import type { TriggerHistoryEntry } from "../src/main/trigger-types.js";

// Execute through the same public capability tools as the trusted UI, with an
// isolated Host store and real fake-provider App Server; no renderer clock.
test(
  "public timer and one-shot watch wake canonical Threads while UI is absent",
  { timeout: 20_000 },
  async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "zenx-trigger-public-"),
    );
    const manager = new AppServerManager({
      entryPath: path.resolve("src/main/app-server-host.ts"),
      tokenFile: path.join(directory, "runtime", "token"),
      hostConfig: {
        cwd: process.cwd(),
        dataDirectory: path.join(directory, "data"),
        model: "fake",
        models: ["fake"],
        approvalPolicy: "never",
        provider: { type: "fake" },
      },
      execArgv: ["--import", "tsx"],
      startupTimeoutMs: 10_000,
    });
    try {
      await manager.start();
      const thread = (await manager.request("thread/start", {})).thread;
      const domain = await createBundledAutomationPluginService({
        userDataDirectory: directory,
        appServer: {
          request: (method, params) => manager.request(method, params),
          enqueue: async (params) => {
            await manager.request("turn/queue", params);
          },
          onNotification: (listener) => manager.onNotification(listener),
        },
        threadTargets: {
          projectProjection: { canonicalKeys: async (values) => values },
          request: (method, params) => manager.request(method, params),
        },
        startThread: async (cwd) =>
          await manager.request("thread/start", { cwd }),
      });
      const api = new ZenXTriggersCapabilityPackage(domain);
      await domain.startPlugin("zenx-triggers", {} as never);
      const invoke = async (name: string, input: Record<string, unknown>) =>
        await api.invoke(name, {
          name,
          callId: "test",
          threadId: thread.id,
          cwd: process.cwd(),
          signal: new AbortController().signal,
          arguments: { input },
        });
      const bound = (await invoke("zenx_triggers_create_target", {
        workspace: process.cwd(),
      })) as { threadId: string };
      assert.notEqual(bound.threadId, thread.id);
      const created = (await invoke("zenx_triggers_create", {
        kind: "timer",
        threadId: bound.threadId,
        label: "Isolated timer",
        prompt: "Report the result",
        runAt: Date.now() + 180,
      })) as { id: string };
      const deadline = Date.now() + 10_000;
      let entry: TriggerHistoryEntry | undefined;
      while (Date.now() < deadline) {
        const listed = (await invoke("zenx_triggers_list", {})) as {
          history: TriggerHistoryEntry[];
        };
        entry = listed.history.find(
          (value) =>
            value.triggerId === created.id && value.status === "completed",
        );
        if (entry) break;
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
      assert(entry, "Host timer did not complete");
      assert.equal(entry.threadId, bound.threadId);
      const read = await manager.request("thread/read", {
        threadId: bound.threadId,
        includeTurns: true,
      });
      assert(
        read.thread.turns
          .flatMap((turn) => turn.items)
          .some(
            (item) =>
              item.type === "userMessage" &&
              item.clientId === entry?.clientUserMessageId,
          ),
      );
      const snapshot = (await invoke("zenx_triggers_list", {})) as {
        triggers: Array<{ id: string; active: boolean }>;
      };
      assert.equal(
        snapshot.triggers.find((candidate) => candidate.id === created.id)
          ?.active,
        false,
      );
      await domain.stopPlugin("zenx-triggers");
    } finally {
      await manager.stop();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
