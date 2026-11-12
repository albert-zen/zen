import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  symlink,
  rename,
  rm,
  realpath,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ZenXProjectProjection } from "../src/main/project-projection.js";
import { ZenXBundledAutomationPluginService } from "../src/main/automation-plugin-service.js";

async function fixture(configuredPath: string) {
  const projection = new ZenXProjectProjection(process.platform);
  await projection.updateConfiguration([configuredPath], null);
  let starts = 0;
  let lastCwd: string | null = null;
  const service = new ZenXBundledAutomationPluginService(
    { request: async () => ({}) as never, onNotification: () => () => {} },
    {
      read: async () => ({ triggers: [], history: [], rooms: [] }),
      write: async () => {},
    },
    new Set(),
    undefined,
    {
      projectProjection: projection,
      request: async () => ({ data: [], nextCursor: null }),
    },
    async () => ({
      model: "model",
      modelId: "model",
      providerProfileId: "fake",
      reasoningEffort: null,
      sandbox: "danger-full-access",
      approvalPolicy: "never",
      processEpoch: "epoch",
      revision: 1,
    }),
    async (preview) => {
      starts++;
      lastCwd = preview.resolvedWorkspace;
      return {
        thread: { id: "idle" },
        cwd: preview.resolvedWorkspace,
        model: preview.model,
        sandbox: { type: "dangerFullAccess" },
        approvalPolicy: preview.approvalPolicy,
        reasoningEffort: preview.reasoningEffort,
      };
    },
  );
  return {
    service,
    get starts() {
      return starts;
    },
    get lastCwd() {
      return lastCwd;
    },
  };
}

test("automation confirmation pins the existing physical directory behind a configured alias", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "zen-r2-link-fixed-"));
  try {
    const a = path.join(root, "before"),
      b = path.join(root, "after"),
      link = path.join(root, "selected");
    await mkdir(a);
    await mkdir(b);
    await symlink(a, link);
    const stable = await fixture(link);
    const previewA = await stable.service.previewTarget(link);
    assert.equal(previewA.workspace, link);
    assert.equal(previewA.resolvedWorkspace, await realpath(a));
    assert.equal(
      (await stable.service.createTarget(link, previewA)).effective
        .resolvedWorkspace,
      await realpath(a),
    );
    assert.equal(stable.lastCwd, await realpath(a)); // thread/start receives physical cwd, never mutable alias.
    await rename(link, `${link}-old`);
    await symlink(b, link);
    await assert.rejects(
      stable.service.createTarget(link, previewA),
      /changed|review/,
    );
    assert.equal(stable.starts, 1);
    const previewB = await stable.service.previewTarget(link);
    assert.equal(previewB.resolvedWorkspace, await realpath(b));
    await stable.service.createTarget(link, previewB); // current trusted configured alias, new explicit confirmation.
    assert.equal(stable.starts, 2);
    assert.equal(stable.lastCwd, await realpath(b));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("missing or non-directory configured target cannot be previewed or admitted", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "zen-r2-missing-fixed-"));
  const dir = path.join(root, "configured");
  await mkdir(dir);
  try {
    const target = await fixture(dir);
    const preview = await target.service.previewTarget(dir);
    await rm(dir, { recursive: true });
    await assert.rejects(
      target.service.createTarget(dir, preview),
      /missing|directory/,
    );
    await assert.rejects(
      target.service.previewTarget(dir),
      /missing|directory/,
    );
    await writeFile(dir, "not a directory");
    await assert.rejects(
      target.service.createTarget(dir, preview),
      /missing|directory/,
    );
    assert.equal(target.starts, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("real Host thread/start records the confirmed physical cwd for a configured alias", async () => {
  const { AppServerManager } =
    await import("../src/main/app-server-manager.js");
  const { createBundledAutomationPluginService } =
    await import("../src/main/automation-plugin-service.js");
  const root = await mkdtemp(path.join(os.tmpdir(), "zen-r2-host-alias-"));
  const a = path.join(root, "a"),
    b = path.join(root, "b"),
    link = path.join(root, "selected");
  await mkdir(a);
  await mkdir(b);
  await symlink(a, link);
  const projection = new ZenXProjectProjection(process.platform);
  await projection.updateConfiguration([link], null);
  const manager = new AppServerManager({
    entryPath: path.resolve("src/main/app-server-host.ts"),
    tokenFile: path.join(root, "runtime", "token"),
    hostConfig: {
      cwd: a,
      dataDirectory: path.join(root, "data"),
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
    const service = await createBundledAutomationPluginService({
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
      startThread: async (preview) =>
        await manager.request("thread/start", {
          cwd: preview.resolvedWorkspace,
          model: preview.model,
          sandbox: preview.sandbox,
          approvalPolicy: preview.approvalPolicy,
          ...(preview.reasoningEffort === null
            ? {}
            : { effort: preview.reasoningEffort }),
        }),
    });
    const first = await service.previewTarget(link);
    const created = await service.createTarget(link, first);
    assert.equal(
      (await manager.request("thread/read", { threadId: created.threadId }))
        .thread.cwd,
      await realpath(a),
    );
    await rename(link, link + "-old");
    await symlink(b, link);
    await assert.rejects(service.createTarget(link, first), /changed|review/);
    const second = await service.previewTarget(link);
    const createdB = await service.createTarget(link, second);
    assert.equal(
      (await manager.request("thread/read", { threadId: createdB.threadId }))
        .thread.cwd,
      await realpath(b),
    );
    assert.notEqual(created.threadId, createdB.threadId);
  } finally {
    await manager.stop();
    await rm(root, { recursive: true, force: true });
  }
});
