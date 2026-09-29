import assert from "node:assert/strict";
import { mkdtemp, mkdir, copyFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AppServerManager } from "../src/main/app-server-manager.js";
import { ZenXProjectProjection } from "../src/main/project-projection.js";
import { createBundledAutomationPluginService } from "../src/main/automation-plugin-service.js";
import { ZenXCapabilityService } from "../src/main/capability-service.js";
import { ZenXTriggersCapabilityPackage } from "../src/main/capabilities/automation-control-package.js";
import { captureLiveComponents } from "./trigger-live-ui-r1.mjs";
import { createDelegatingFirstPartyProfileLoader } from "../src/main/first-party-profile-loader.js";
import type { TriggerHistoryEntry } from "../src/main/trigger-types.js";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
test(
  "new fixed normal profile enable + real Host public UI commands/Thread/history",
  { timeout: 60000 },
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "zenx-trigger-profile-"));
    const userData = path.join(root, "profile");
    const resources = path.join(root, "resources");
    await mkdir(path.join(resources, "plugins"), { recursive: true });
    await copyFile(
      path.resolve("resources/plugins/zenx-triggers-plugin-1.0.0.tgz"),
      path.join(resources, "plugins", "zenx-triggers-plugin-1.0.0.tgz"),
    );
    const projection = new ZenXProjectProjection();
    await projection.updateConfiguration([process.cwd()], process.cwd());
    const manager = new AppServerManager({
      entryPath: path.resolve("src/main/app-server-host.ts"),
      tokenFile: path.join(root, "runtime", "token"),
      hostConfig: {
        cwd: process.cwd(),
        dataDirectory: path.join(root, "data"),
        model: "fake",
        models: ["fake"],
        approvalPolicy: "never",
        provider: { type: "fake" },
      },
      execArgv: ["--import", "tsx"],
      startupTimeoutMs: 10000,
    });
    let service: ZenXCapabilityService | undefined;
    try {
      await manager.start();
      const existing = await manager.request("thread/start", {
        cwd: process.cwd(),
      });
      let domain: Awaited<
        ReturnType<typeof createBundledAutomationPluginService>
      >;
      let pkg: ZenXTriggersCapabilityPackage;
      service = new ZenXCapabilityService({
        userDataDirectory: userData,
        resourcesDirectory: resources,
        pnpmCliPath: path.resolve("../../node_modules/pnpm/bin/pnpm.cjs"),
        bundledProvidersOnly: true,
        trustedProfileLoaders: {
          "zenx-triggers": createDelegatingFirstPartyProfileLoader(() => pkg),
        },
      });
      domain = await createBundledAutomationPluginService({
        userDataDirectory: userData,
        appServer: {
          request: (method, params) => manager.request(method, params),
          onNotification: (fn) => manager.onNotification(fn),
          enqueue: async (params) => {
            await manager.request("turn/queue", params);
          },
        },
        threadTargets: {
          projectProjection: projection,
          request: (method, params) => manager.request(method, params),
        },
        targetDefaults: async () => {
          const current = await manager.currentConfiguration();
          const defaults = current.threadStartDefaults!;
          const model = (await manager.request("model/list", {})).data.find(
            (item) => item.isDefault,
          )!;
          return {
            model: model.id,
            providerProfileId: defaults.providerProfileId,
            modelId: defaults.modelId,
            reasoningEffort: defaults.reasoningEffort,
            sandbox: defaults.sandbox,
            approvalPolicy:
              defaults.approvalPolicy === "never"
                ? ("never" as const)
                : ("on-request" as const),
            processEpoch: current.processEpoch,
            revision: current.revision,
          };
        },
        startThread: async (preview) => {
          const result = await manager.request("thread/start", {
            cwd: preview.resolvedWorkspace,
            model: preview.model,
            sandbox: preview.sandbox,
            approvalPolicy: preview.approvalPolicy,
            ...(preview.reasoningEffort === null
              ? {}
              : { effort: preview.reasoningEffort }),
          });
          console.log(
            "dedicated start result",
            JSON.stringify({
              sandbox: result.sandbox,
              approvalPolicy: result.approvalPolicy,
              model: result.model,
              cwd: result.cwd,
            }),
          );
          return result;
        },
      });
      pkg = new ZenXTriggersCapabilityPackage(domain);
      await service.initialize();
      await service.installBuiltInPlugin("zenx-triggers");
      const snapshot = service.pluginSnapshot();
      console.log(
        "catalog",
        snapshot.plugins.map(({ id, lifecycle }) => ({ id, lifecycle })),
        "sidebar",
        snapshot.sidebar.map(({ id }) => id),
        "panels",
        snapshot.panels.map(({ id }) => id),
      );
      assert(
        snapshot.pages.some(
          (item) => item.route === "/plugins/zenx-triggers/triggers",
        ),
      );
      assert(snapshot.panels.some((item) => item.id === "thread-wakeups"));
      const command = async (id: string, input?: unknown) =>
        await service!.executePluginCommand("zenx-triggers", id, input);
      const threads = (await command("threads")) as {
        threads: Array<{ threadId: string; cwd: string }>;
      };
      assert(
        threads.threads.some((item) => item.threadId === existing.thread.id),
      );
      const preview = await command("preview-target", {
        workspace: process.cwd(),
      });
      const target = (await command("create-target", {
        workspace: process.cwd(),
        preview,
      })) as { threadId: string };
      const targetRead = await manager.request("thread/read", {
        threadId: target.threadId,
        includeTurns: true,
      });
      console.log(
        "existing settings",
        JSON.stringify({
          sandbox: existing.sandbox,
          approvalPolicy: existing.approvalPolicy,
          model: existing.model,
          cwd: existing.cwd,
        }),
      );
      console.log("dedicated workspace", targetRead.thread.cwd);
      assert.equal(targetRead.thread.cwd, process.cwd());
      const created = (await command("create", {
        kind: "timer",
        threadId: target.threadId,
        label: "QA timer",
        prompt: "Check",
        runAt: Date.now() + 650,
      })) as { id: string };
      const edited = (await command("update", {
        id: created.id,
        kind: "timer",
        threadId: target.threadId,
        label: "QA edited timer",
        prompt: "Check",
        runAt: Date.now() + 800,
      })) as { id: string };
      assert.equal(edited.id, created.id);
      await command("cancel", { triggerId: created.id });
      assert.equal(
        (
          (await command("list")) as {
            triggers: Array<{ id: string; active: boolean }>;
          }
        ).triggers.find((item) => item.id === created.id)?.active,
        false,
      );
      const resumeList = (await command("list")) as {
        triggers: Array<{ id: string; definitionRevision: number }>;
      };
      await command("resume", {
        triggerId: created.id,
        expectedRevision: resumeList.triggers.find(
          (item) => item.id === created.id,
        )?.definitionRevision,
      });
      // No UI commands during wait: the Host timer is responsible for waking.
      await sleep(1100);
      let history: TriggerHistoryEntry[] = [];
      for (let i = 0; i < 120; i++) {
        history = (
          (await command("list")) as { history: TriggerHistoryEntry[] }
        ).history;
        if (
          history.some(
            (item) =>
              item.triggerId === created.id && item.status === "completed",
          )
        )
          break;
        await sleep(30);
      }
      const entry = history.find((item) => item.triggerId === created.id);
      console.log(
        "history",
        entry && {
          status: entry.status,
          delivery: entry.delivery,
          clientUserMessageId: entry.clientUserMessageId,
          threadId: entry.threadId,
          turnId: entry.turnId,
        },
      );
      assert(entry?.status === "completed");
      const read = await manager.request("thread/read", {
        threadId: target.threadId,
        includeTurns: true,
      });
      const canonical = read.thread.turns
        .flatMap((turn) => turn.items)
        .filter(
          (item) =>
            item.type === "userMessage" &&
            item.clientId === entry.clientUserMessageId,
        );
      assert.equal(canonical.length, 1);
      console.log(
        "canonical",
        canonical.length,
        "target turns",
        read.thread.turns.map((turn) => turn.status),
      );
      const listed = (await command("list")) as {
        triggers: Array<{ id: string; label: string; active: boolean }>;
      };
      assert.equal(
        listed.triggers.find((item) => item.id === created.id)?.label,
        "QA edited timer",
      );
      await command("delete", { triggerId: created.id });
      assert.equal(
        (
          (await command("list")) as { triggers: Array<{ id: string }> }
        ).triggers.some((item) => item.id === created.id),
        false,
      );
      await service.setEnabled("zenx-triggers", false);
      assert(
        !service
          .pluginSnapshot()
          .sidebar.some((item) => item.pluginId === "zenx-triggers"),
      );
      await service.setEnabled("zenx-triggers", true);
      assert(
        service
          .pluginSnapshot()
          .sidebar.some((item) => item.pluginId === "zenx-triggers"),
      );
      const missed = (await command("create", {
        kind: "timer",
        threadId: target.threadId,
        label: "QA missed timer",
        prompt: "Only one missed occurrence",
        runAt: Date.now() + 400,
      })) as { id: string };
      await service.setEnabled("zenx-triggers", false);
      await sleep(750);
      await service.setEnabled("zenx-triggers", true);
      let missedHistory: TriggerHistoryEntry[] = [];
      for (let i = 0; i < 120; i++) {
        missedHistory = (
          (await command("list")) as { history: TriggerHistoryEntry[] }
        ).history.filter((entry) => entry.triggerId === missed.id);
        if (missedHistory[0]?.status === "completed") break;
        await sleep(30);
      }
      assert.equal(missedHistory.length, 1);
      assert.equal(missedHistory[0]?.status, "completed");
      console.log(
        "missed after profile re-enable",
        missedHistory.map((entry) => ({
          id: entry.id,
          status: entry.status,
          delivery: entry.delivery,
        })),
      );
      await command("delete", { triggerId: missed.id });
      console.log(
        "profile end state",
        service
          .pluginSnapshot()
          .plugins.find((item) => item.id === "zenx-triggers")?.lifecycle,
      );
      // A real Host-side program failure, not a synthetic renderer history row.
      const failing = (await command("create", {
        kind: "signal",
        threadId: target.threadId,
        label: "QA failed action",
        prompt: "Do not retry",
        signalName: "qa-fail",
        program: { action: { command: "/nonexistent/zenx-qa-binary" } },
      })) as { id: string };
      await command("signal", { name: "qa-fail", detail: "controlled error" });
      let failure: TriggerHistoryEntry | undefined;
      for (let i = 0; i < 100; i++) {
        failure = (
          (await command("list")) as { history: TriggerHistoryEntry[] }
        ).history.find(
          (item) => item.triggerId === failing.id && item.status === "failed",
        );
        if (failure) break;
        await sleep(30);
      }
      console.log(
        "controlled failure",
        failure && {
          status: failure.status,
          error: failure.error,
          programStatus: failure.programOutcome?.status,
        },
      );
      assert.equal(failure?.status, "failed");
      if (process.env.ZENX_QA_CAPTURE_DIR)
        await captureLiveComponents(
          service,
          target.threadId,
          process.env.ZENX_QA_CAPTURE_DIR,
        );
      await command("delete", { triggerId: failing.id });
      const offline = (await command("create", {
        kind: "timer",
        threadId: target.threadId,
        label: "QA Host restart timer",
        prompt: "Exactly one on restart",
        runAt: Date.now() + 500,
      })) as { id: string };
      await service.close();
      service = undefined;
      await manager.stop();
      await sleep(850);
      await manager.start();
      service = new ZenXCapabilityService({
        userDataDirectory: userData,
        resourcesDirectory: resources,
        pnpmCliPath: path.resolve("../../node_modules/pnpm/bin/pnpm.cjs"),
        bundledProvidersOnly: true,
        trustedProfileLoaders: {
          "zenx-triggers": createDelegatingFirstPartyProfileLoader(() => pkg),
        },
      });
      domain = await createBundledAutomationPluginService({
        userDataDirectory: userData,
        appServer: {
          request: (method, params) => manager.request(method, params),
          onNotification: (fn) => manager.onNotification(fn),
          enqueue: async (params) => {
            await manager.request("turn/queue", params);
          },
        },
        threadTargets: {
          projectProjection: projection,
          request: (method, params) => manager.request(method, params),
        },
        targetDefaults: async () => {
          const current = await manager.currentConfiguration();
          const defaults = current.threadStartDefaults!;
          const model = (await manager.request("model/list", {})).data.find(
            (item) => item.isDefault,
          )!;
          return {
            model: model.id,
            providerProfileId: defaults.providerProfileId,
            modelId: defaults.modelId,
            reasoningEffort: defaults.reasoningEffort,
            sandbox: defaults.sandbox,
            approvalPolicy:
              defaults.approvalPolicy === "never"
                ? ("never" as const)
                : ("on-request" as const),
            processEpoch: current.processEpoch,
            revision: current.revision,
          };
        },
        startThread: async (preview) => {
          const result = await manager.request("thread/start", {
            cwd: preview.resolvedWorkspace,
            model: preview.model,
            sandbox: preview.sandbox,
            approvalPolicy: preview.approvalPolicy,
            ...(preview.reasoningEffort === null
              ? {}
              : { effort: preview.reasoningEffort }),
          });
          console.log(
            "dedicated start result",
            JSON.stringify({
              sandbox: result.sandbox,
              approvalPolicy: result.approvalPolicy,
              model: result.model,
              cwd: result.cwd,
            }),
          );
          return result;
        },
      });
      pkg = new ZenXTriggersCapabilityPackage(domain);
      await service.initialize();
      console.log(
        "restarted catalog",
        service
          .pluginSnapshot()
          .plugins.find((item) => item.id === "zenx-triggers")?.lifecycle,
      );
      let restarted: TriggerHistoryEntry[] = [];
      for (let i = 0; i < 120; i++) {
        restarted = (
          (await command("list")) as { history: TriggerHistoryEntry[] }
        ).history.filter((entry) => entry.triggerId === offline.id);
        if (restarted[0]?.status === "completed") break;
        await sleep(30);
      }
      console.log(
        "Host-exit missed",
        restarted.map((entry) => ({ id: entry.id, status: entry.status })),
      );
      assert.equal(restarted.length, 1);
      assert.equal(restarted[0]?.status, "completed");
      await command("delete", { triggerId: offline.id });
    } finally {
      await service?.close();
      await manager.stop();
      if (process.env.ZENX_QA_KEEP_PROFILE) {
        console.log("retained QA profile", root);
      } else await rm(root, { recursive: true, force: true });
    }
  },
);
