import assert from "node:assert/strict";
import { mkdtemp, mkdir, copyFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { AppServerManager } from "../src/main/app-server-manager.js";
import { ZenXProjectProjection } from "../src/main/project-projection.js";
import {
  createBundledAutomationPluginService,
  type AutomationTargetPreview,
} from "../src/main/automation-plugin-service.js";
import { ZenXCapabilityService } from "../src/main/capability-service.js";
import { ZenXTriggersCapabilityPackage } from "../src/main/capabilities/automation-control-package.js";
import { createDelegatingFirstPartyProfileLoader } from "../src/main/first-party-profile-loader.js";
import {
  createZenXRoomsProfileLoader,
  ZENX_ROOMS_TARBALL,
} from "../src/main/rooms-profile-loader.js";
import type { ZenXRoom } from "../src/main/trigger-types.js";

test(
  "packaged PAW trusted UI creates a new canonical Thread with real Host defaults without starting a Turn",
  { timeout: 60_000 },
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), "zenx-paw-profile-create-"));
    const workspace = path.join(root, "workspace");
    const resources = path.join(root, "resources");
    await mkdir(workspace);
    await mkdir(path.join(resources, "plugins"), { recursive: true });
    for (const file of [ZENX_ROOMS_TARBALL, "zenx-triggers-plugin-1.0.0.tgz"])
      await copyFile(
        path.resolve("resources/plugins", file),
        path.join(resources, "plugins", file),
      );
    const projection = new ZenXProjectProjection();
    await projection.updateConfiguration([workspace], workspace);
    const manager = new AppServerManager({
      entryPath: path.resolve("src/main/app-server-host.ts"),
      tokenFile: path.join(root, "runtime", "token"),
      hostConfig: {
        cwd: workspace,
        dataDirectory: path.join(root, "data"),
        model: "fake",
        models: ["fake"],
        approvalPolicy: "never",
        provider: { type: "fake" },
      },
      execArgv: ["--import", "tsx"],
      startupTimeoutMs: 10_000,
    });
    let capabilities: ZenXCapabilityService | undefined;
    try {
      await manager.start();
      const domain = await createBundledAutomationPluginService({
        userDataDirectory: path.join(root, "profile"),
        appServer: {
          request: (method, params) => manager.request(method, params),
          onNotification: (listener) => manager.onNotification(listener),
        },
        threadTargets: {
          projectProjection: projection,
          request: (method, params) => manager.request(method, params),
        },
        targetDefaults: async () => {
          const current = await manager.currentConfiguration();
          const defaults = current.threadStartDefaults!;
          const model = (await manager.request("model/list", {})).data.find(
            (entry) => entry.isDefault,
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
        startThread: (preview) =>
          manager.request("thread/start", {
            cwd: preview.resolvedWorkspace,
            model: preview.model,
            sandbox: preview.sandbox,
            approvalPolicy: preview.approvalPolicy,
            ...(preview.reasoningEffort === null
              ? {}
              : { effort: preview.reasoningEffort }),
          }),
      });
      const triggers = new ZenXTriggersCapabilityPackage(domain);
      capabilities = new ZenXCapabilityService({
        userDataDirectory: path.join(root, "profile"),
        resourcesDirectory: resources,
        pnpmCliPath: path.resolve("../../node_modules/pnpm/bin/pnpm.cjs"),
        bundledProvidersOnly: true,
        trustedProfileLoaders: {
          "zenx-rooms": createZenXRoomsProfileLoader(() => domain),
          "zenx-triggers": createDelegatingFirstPartyProfileLoader(
            () => triggers,
          ),
        },
      });
      await capabilities.initialize();
      await capabilities.installBuiltInPlugin("zenx-rooms");
      await capabilities.installBuiltInPlugin("zenx-triggers");
      const command = (id: string, input?: unknown) =>
        capabilities!.executePluginCommand("zenx-rooms", id, input);
      assert.deepEqual(await command("workspaces"), [workspace]);
      const preview = (await command("preview-target", {
        workspace,
      })) as AutomationTargetPreview;
      assert.equal(preview.resolvedWorkspace, await realpath(workspace));
      assert.equal((await manager.request("thread/list", {})).data.length, 0);
      const input = {
        name: "Named PAW",
        memberName: "Paw",
        operationId: "confirmed-new-paw",
        target: { kind: "new", workspace, expected: preview },
      };
      const room = (await command("create-assistant", input)) as ZenXRoom;
      assert.ok(room.assistant?.threadId);
      const threadId = room.assistant!.threadId;
      const read = await manager.request("thread/read", {
        threadId,
        includeTurns: true,
      });
      assert.equal(read.thread.cwd, await realpath(workspace));
      assert.equal(read.thread.turns.length, 0);
      const resumed = await manager.request("thread/resume", { threadId });
      assert.equal(resumed.model, preview.model);
      assert.equal(
        resumed.sandbox.type,
        preview.sandbox === "danger-full-access"
          ? "dangerFullAccess"
          : preview.sandbox === "read-only"
            ? "readOnly"
            : "workspaceWrite",
      );
      assert.equal(resumed.approvalPolicy, preview.approvalPolicy);
      assert.equal(resumed.reasoningEffort, preview.reasoningEffort);
      assert.equal(domain.snapshot().triggers[0]?.threadId, threadId);
      assert.equal(domain.snapshot().history.length, 0);
      assert.deepEqual(await command("create-assistant", input), room);
      assert.equal((await manager.request("thread/list", {})).data.length, 1);
      await assert.rejects(
        command("create-assistant", { ...input, name: "Changed" }),
        /different input/,
      );
      assert.equal(domain.snapshot().rooms.length, 1);
    } finally {
      await capabilities?.close();
      await manager.stop();
      await rm(root, { recursive: true, force: true });
    }
  },
);
