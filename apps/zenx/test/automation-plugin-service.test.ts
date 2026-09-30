import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createBundledAutomationPluginService,
  ZenXBundledAutomationPluginService,
} from "../src/main/automation-plugin-service.js";
import type { TriggerSnapshot } from "../src/main/trigger-types.js";
import type { ZenXTriggerAppServerPort } from "../src/main/trigger-service.js";
import type {
  ClientRequestResults,
  ServerNotificationMethod,
  ServerNotificationParams,
  Turn,
} from "../src/protocol-client/index.js";

test("corrupt optional automation state does not block service construction", async () => {
  const userDataDirectory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-automation-service-"),
  );
  try {
    await writeFile(
      path.join(userDataDirectory, "trigger-registry.json"),
      "not-json",
    );
    const service = await createBundledAutomationPluginService({
      userDataDirectory,
      appServer: {
        request: async () => ({}) as never,
        onNotification: () => () => {},
      },
    });
    assert.ok(service);
  } finally {
    await rm(userDataDirectory, { recursive: true, force: true });
  }
});

test("migration preserves an existing Room namespace when the shared Trigger document lacks rooms", async () => {
  const userDataDirectory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-room-migration-authority-"),
  );
  const room = {
    id: "room-1",
    name: "Existing room",
    members: [],
    messages: [],
    operations: [],
    operationEpoch: "epoch-1",
    createdAt: 1,
  };
  try {
    const storageRoot = path.join(userDataDirectory, "plugin-data");
    await mkdir(path.join(storageRoot, "zenx-triggers"), { recursive: true });
    await mkdir(path.join(storageRoot, "zenx-rooms"), { recursive: true });
    await writeFile(
      path.join(storageRoot, "zenx-triggers", "storage.json"),
      JSON.stringify({ version: 1, value: { triggers: [], history: [] } }),
      { mode: 0o600 },
    );
    await writeFile(
      path.join(storageRoot, "zenx-rooms", "storage.json"),
      JSON.stringify({ version: 1, value: { rooms: [room] } }),
      { mode: 0o600 },
    );
    await createBundledAutomationPluginService({
      userDataDirectory,
      appServer: {
        request: async () => ({}) as never,
        onNotification: () => () => {},
      },
    });
    const canonical = JSON.parse(
      await readFile(
        path.join(storageRoot, "zenx-triggers", "storage.json"),
        "utf8",
      ),
    ) as { value: { rooms: unknown[] } };
    assert.deepEqual(canonical.value.rooms, [room]);
  } finally {
    await rm(userDataDirectory, { recursive: true, force: true });
  }
});

test("corrupt Room compatibility projection is rebuilt from canonical storage", async () => {
  const userDataDirectory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-room-projection-recovery-"),
  );
  try {
    const storageRoot = path.join(userDataDirectory, "plugin-data");
    await mkdir(path.join(storageRoot, "zenx-triggers"), { recursive: true });
    await mkdir(path.join(storageRoot, "zenx-rooms"), { recursive: true });
    await writeFile(
      path.join(storageRoot, "zenx-triggers", "storage.json"),
      JSON.stringify({ version: 1, value: { triggers: [], history: [], rooms: [] } }),
      { mode: 0o600 },
    );
    await writeFile(
      path.join(storageRoot, "zenx-rooms", "storage.json"),
      "not-json",
      { mode: 0o600 },
    );
    const service = await createBundledAutomationPluginService({
      userDataDirectory,
      appServer: {
        request: async () => ({}) as never,
        onNotification: () => () => {},
      },
    });
    assert.deepEqual(service.snapshot(), { triggers: [], history: [], rooms: [] });
    assert.deepEqual(
      JSON.parse(
        await readFile(path.join(storageRoot, "zenx-rooms", "storage.json"), "utf8"),
      ),
      { version: 1, value: { rooms: [] } },
    );
  } finally {
    await rm(userDataDirectory, { recursive: true, force: true });
  }
});

test("projection write failure after canonical commit does not fail the mutation", async () => {
  const userDataDirectory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-room-projection-post-commit-"),
  );
  let failProjection = false;
  const storageFileSystem = {
    readFile,
    mkdir,
    writeFile,
    rename: async (source: string, destination: string) => {
      if (failProjection && destination.includes("zenx-rooms")) {
        failProjection = false;
        throw Object.assign(new Error("injected projection failure"), {
          code: "EACCES",
        });
      }
      await rename(source, destination);
    },
    unlink,
  };
  try {
    const service = await createBundledAutomationPluginService({
      userDataDirectory,
      storageFileSystem,
      appServer: {
        request: async () => ({}) as never,
        onNotification: () => () => {},
      },
    });
    await service.startPlugin("zenx-rooms", {} as never);
    await service.startPlugin("zenx-triggers", {} as never);
    failProjection = true;
    const created = await service.create({
      kind: "timer",
      threadId: "target",
      label: "canonical",
      prompt: "committed",
      runAt: Date.now() + 60_000,
    });
    assert.equal(created.label, "canonical");
    const canonical = JSON.parse(
      await readFile(
        path.join(userDataDirectory, "plugin-data", "zenx-triggers", "storage.json"),
        "utf8",
      ),
    ) as { value: { triggers: Array<{ id: string }> } };
    assert.equal(canonical.value.triggers[0]?.id, created.id);
    await service.stopPlugin("zenx-triggers");
    await service.stopPlugin("zenx-rooms");
  } finally {
    await rm(userDataDirectory, { recursive: true, force: true });
  }
});

test("future-version Room projection is preserved and does not block startup", async () => {
  const userDataDirectory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-room-projection-future-"),
  );
  const projection = JSON.stringify({ version: 2, value: { rooms: [] } });
  try {
    const storageRoot = path.join(userDataDirectory, "plugin-data");
    await mkdir(path.join(storageRoot, "zenx-rooms"), { recursive: true });
    await writeFile(
      path.join(storageRoot, "zenx-rooms", "storage.json"),
      projection,
      { mode: 0o600 },
    );
    await createBundledAutomationPluginService({
      userDataDirectory,
      appServer: {
        request: async () => ({}) as never,
        onNotification: () => () => {},
      },
    });
    assert.equal(
      await readFile(
        path.join(storageRoot, "zenx-rooms", "storage.json"),
        "utf8",
      ),
      projection,
    );
  } finally {
    await rm(userDataDirectory, { recursive: true, force: true });
  }
});

test("completion setup resolves readable targets without ambiguous writes and reads the exact source result", async () => {
  const configuredPath = process.cwd();
  let saved: TriggerSnapshot = { triggers: [], history: [], rooms: [] };
  let listener:
    | ((
        method: ServerNotificationMethod,
        params: ServerNotificationParams[ServerNotificationMethod],
      ) => void)
    | undefined;
  const source: Turn = {
    id: "source-turn",
    status: "completed",
    error: null,
    itemsView: "full",
    startedAt: 1,
    completedAt: 2,
    durationMs: 1,
    items: [
      {
        type: "agentMessage",
        id: "answer",
        text: "Exact child result",
        phase: "final_answer",
        memoryCitation: null,
      },
    ],
  };
  const port: ZenXTriggerAppServerPort = {
    request: async () => {
      throw new Error("Completion notifications must use the queue");
    },
    onNotification: (handler) => {
      listener = handler;
      return () => {
        listener = undefined;
      };
    },
    enqueue: async () => {},
    readThread: async (threadId) =>
      ({
        thread: {
          id: threadId,
          turns: [source, { ...source, id: "newer-turn", items: [] }],
        },
      }) as ClientRequestResults["thread/read"],
  };
  const rows = [
    {
      id: "parent-111",
      name: "Parent",
      cwd: "/work",
      status: { type: "idle" as const },
    },
    {
      id: "child-111",
      name: "Child",
      cwd: "/work",
      status: { type: "idle" as const },
    },
    {
      id: "copy-111",
      name: "Duplicate",
      cwd: "/work",
      status: { type: "idle" as const },
    },
    {
      id: "copy-222",
      name: "Duplicate",
      cwd: "/work",
      status: { type: "idle" as const },
    },
  ];
  const archivedRows: typeof rows = [];
  const service = new ZenXBundledAutomationPluginService(
    port,
    {
      read: async () => structuredClone(saved),
      write: async (value) => {
        saved = structuredClone(value);
      },
    },
    new Set(),
    undefined,
    {
      projectProjection: {
        canonicalKeys: async (values) => values,
        configuredWorkspace: async (value) =>
          value === configuredPath ? configuredPath : null,
        configuredWorkspaces: async () => [configuredPath],
      },
      request: async (_method, params) => ({
        data: params.archived ? archivedRows : rows,
        nextCursor: null,
      }),
    },
    async () => ({
      model: "zen-model-v1:fixture",
      providerProfileId: "fake",
      modelId: "fake",
      reasoningEffort: null,
      sandbox: "danger-full-access",
      approvalPolicy: "never",
      processEpoch: "fixture",
      revision: 1,
    }),
    async (preview) => {
      assert.equal(preview.workspace, configuredPath);
      return {
        thread: { id: "dedicated-111" },
        cwd: preview.resolvedWorkspace,
        model: preview.model,
        sandbox: { type: "dangerFullAccess" },
        approvalPolicy: preview.approvalPolicy,
        reasoningEffort: preview.reasoningEffort,
      };
    },
  );
  await assert.rejects(
    service.previewTarget("/not-a-discovered-workspace"),
    /not configured/,
  );
  const preview = await service.previewTarget(configuredPath);
  assert.deepEqual(await service.createTarget(configuredPath, preview), {
    threadId: "dedicated-111",
    effective: preview,
  });
  await service.startPlugin("zenx-triggers", {} as never);
  try {
    await assert.rejects(
      service.create({
        kind: "thread",
        threadId: "Parent",
        watchedThreadId: "Duplicate",
        label: "Watch",
        prompt: "Review",
      }),
      /ambiguous.*copy-111.*copy-222/u,
    );
    assert.equal(service.snapshot().triggers.length, 0);
    const watch = await service.create({
      kind: "thread",
      threadId: "parent-",
      watchedThreadId: "Child",
      label: "Watch",
      prompt: "Review",
      once: true,
    });
    assert.equal(watch.threadId, "parent-111");
    assert.equal(watch.watch?.threadId, "child-111");
    rows[1]!.name = "Renamed child";
    listener?.("turn/completed", { threadId: "child-111", turn: source });
    for (
      let attempt = 0;
      attempt < 50 && service.snapshot().history[0]?.delivery !== "queued";
      attempt++
    )
      await new Promise((resolve) => setTimeout(resolve, 5));
    const entry = service.snapshot().history[0]!;
    assert.equal(entry.delivery, "queued");
    const result = await service.result(entry.id);
    assert.equal(result.turnId, "source-turn");
    assert.match(result.preview, /Exact child result/u);
    assert.doesNotMatch(result.preview, /newer-turn/u);
    assert.equal((await service.threads())[1]?.name, "Renamed child");
    archivedRows.push(rows.splice(0, 1)[0]!);
    await assert.rejects(service.resume(watch.id), /archived/);
    await assert.rejects(
      service.create({
        kind: "timer",
        threadId: "parent-111",
        label: "Invalid target",
        prompt: "Do not run",
        runAt: Date.now() + 60_000,
      }),
      /archived/,
    );
  } finally {
    await service.stopPlugin("zenx-triggers");
  }
});

test("configured workspace and Host defaults are rechecked before dedicated Thread admission", async () => {
  const configuredPath = process.cwd();
  let configured = true;
  let revision = 3;
  let starts = 0;
  const service = new ZenXBundledAutomationPluginService(
    { request: async () => ({}) as never, onNotification: () => () => {} },
    {
      read: async () => ({ triggers: [], history: [], rooms: [] }),
      write: async () => {},
    },
    new Set(),
    undefined,
    {
      projectProjection: {
        canonicalKeys: async (paths) => paths,
        configuredWorkspace: async (workspace) =>
          configured && workspace === configuredPath ? workspace : null,
        configuredWorkspaces: async () => (configured ? [configuredPath] : []),
      },
      request: async () => ({
        data: [
          { id: "old", name: "Old", cwd: "/old", status: { type: "idle" } },
        ],
        nextCursor: null,
      }),
    },
    async () => ({
      model: "model-key",
      modelId: "model",
      providerProfileId: "provider",
      reasoningEffort: null,
      sandbox: "danger-full-access",
      approvalPolicy: "never",
      processEpoch: "epoch",
      revision,
    }),
    async (preview) => {
      starts++;
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
  await assert.rejects(service.previewTarget("/old"), /not configured/);
  assert.deepEqual(await service.workspaces(), [configuredPath]);
  const preview = await service.previewTarget(configuredPath);
  revision++;
  await assert.rejects(
    service.createTarget(configuredPath, preview),
    /changed/,
  );
  assert.equal(starts, 0);
  const fresh = await service.previewTarget(configuredPath);
  configured = false;
  await assert.rejects(
    service.createTarget(configuredPath, fresh),
    /not configured/,
  );
  assert.equal(starts, 0);
  configured = true;
  const accepted = await service.previewTarget(configuredPath);
  assert.equal(
    (await service.createTarget(configuredPath, accepted)).threadId,
    "idle",
  );
  assert.equal(starts, 1);
});

test("blocked resume never enables a different definition, same-target edit or cancel", async () => {
  let saved: TriggerSnapshot = { triggers: [], history: [], rooms: [] };
  let blockNext = false;
  let reached!: () => void;
  let unblock!: () => void;
  const blocked = () =>
    new Promise<void>((resolve) => {
      reached = resolve;
    });
  const service = new ZenXBundledAutomationPluginService(
    { request: async () => ({}) as never, onNotification: () => () => {} },
    {
      read: async () => structuredClone(saved),
      write: async (value) => {
        saved = structuredClone(value);
      },
    },
    new Set(),
    undefined,
    {
      projectProjection: { canonicalKeys: async (paths) => paths },
      request: async (_method, params) => {
        if (blockNext) {
          blockNext = false;
          reached();
          await new Promise<void>((resolve) => {
            unblock = resolve;
          });
        }
        return {
          data: params.archived
            ? []
            : [
                {
                  id: "target",
                  name: "Target",
                  cwd: "/work",
                  status: { type: "idle" },
                },
              ],
          nextCursor: null,
        };
      },
    },
  );
  await service.startPlugin("zenx-triggers", {} as never);
  try {
    const original = await service.create({
      kind: "timer",
      threadId: "target",
      label: "Timer",
      prompt: "Old",
      runAt: Date.now() + 60_000,
    });
    await service.cancel(original.id);
    const prior = service.snapshot().triggers[0]!;
    const waiting = blocked();
    blockNext = true;
    const attempt = service.resume(original.id, prior.definitionRevision ?? 0);
    await waiting;
    await service.update({
      id: original.id,
      kind: "signal",
      threadId: "target",
      label: "Signal",
      prompt: "New",
      signalName: "changed",
    });
    unblock();
    await assert.rejects(attempt, /definition changed/);
    assert.equal(service.snapshot().triggers[0]?.active, false);
    await assert.rejects(
      service.resume(original.id, prior.definitionRevision ?? 0),
      /definition changed/,
    );
    const current = service.snapshot().triggers[0]!;
    await service.resume(original.id, current.definitionRevision ?? 0);
    assert.equal(service.snapshot().triggers[0]?.active, true);
    await service.cancel(original.id);
    const paused = service.snapshot().triggers[0]!;
    const waitingAgain = blocked();
    blockNext = true;
    const second = service.resume(original.id, paused.definitionRevision ?? 0);
    await waitingAgain;
    await service.cancel(original.id); // same paused state, distinct explicit intent
    unblock();
    await assert.rejects(second, /definition changed/);
    assert.equal(service.snapshot().triggers[0]?.active, false);
  } finally {
    await service.stopPlugin("zenx-triggers");
  }
});

test("resume rejects same-target prompt, timer, program and deletion races", async () => {
  let state: TriggerSnapshot = { triggers: [], history: [], rooms: [] };
  let held = false;
  let archived = false;
  let entered!: () => void;
  let release!: () => void;
  const service = new ZenXBundledAutomationPluginService(
    { request: async () => ({}) as never, onNotification: () => () => {} },
    {
      read: async () => structuredClone(state),
      write: async (next) => {
        state = structuredClone(next);
      },
    },
    new Set(),
    undefined,
    {
      projectProjection: { canonicalKeys: async (paths) => paths },
      request: async (_method, params) => {
        if (held && !params.archived) {
          held = false;
          entered();
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
        return {
          data:
            params.archived === archived
              ? [
                  {
                    id: "target",
                    name: "Target",
                    cwd: "/work",
                    status: { type: "idle" },
                  },
                ]
              : [],
          nextCursor: null,
        };
      },
    },
  );
  await service.startPlugin("zenx-triggers", {} as never);
  try {
    for (const change of ["prompt", "time", "program", "delete"] as const) {
      const created = await service.create({
        kind: "timer",
        threadId: "target",
        label: change,
        prompt: "original",
        runAt: Date.now() + 600_000,
      });
      await service.cancel(created.id);
      const revision = service
        .snapshot()
        .triggers.find((item) => item.id === created.id)!.definitionRevision!;
      const arrived = new Promise<void>((resolve) => {
        entered = resolve;
      });
      held = true;
      const attempting = service.resume(created.id, revision);
      await arrived;
      if (change === "delete") await service.delete(created.id);
      else
        await service.update({
          id: created.id,
          kind: "timer",
          threadId: "target",
          label: change,
          prompt: change === "prompt" ? "changed" : "original",
          runAt: Date.now() + (change === "time" ? 800_000 : 600_000),
          ...(change === "program"
            ? {
                program: {
                  action: { command: "fixture", env: { SECRET: "private" } },
                },
              }
            : {}),
        });
      release();
      await assert.rejects(attempting, /definition changed|not found/);
      assert.equal(
        service.snapshot().triggers.find((item) => item.id === created.id)
          ?.active,
        change === "delete" ? undefined : false,
      );
    }
    const target = await service.create({
      kind: "timer",
      threadId: "target",
      label: "Archive",
      prompt: "Wait",
      runAt: Date.now() + 600_000,
    });
    await service.cancel(target.id);
    archived = true;
    await assert.rejects(
      service.resume(
        target.id,
        service.snapshot().triggers.find((item) => item.id === target.id)
          ?.definitionRevision,
      ),
      /archived/,
    );
    assert.equal(
      service.snapshot().triggers.find((item) => item.id === target.id)?.active,
      false,
    );
  } finally {
    await service.stopPlugin("zenx-triggers");
  }
});

test("overlapping enabled Trigger runtime generations keep durable wakeup admission until the last lease closes", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-trigger-runtime-lease-"),
  );
  const service = await createBundledAutomationPluginService({
    userDataDirectory: directory,
    appServer: {
      request: async () => ({}) as never,
      onNotification: () => () => {},
      enqueue: async () => {},
    },
  });
  try {
    await service.startPlugin("zenx-triggers", {} as never); // committed runtime
    await service.startPlugin("zenx-rooms", {} as never);
    await service.startPlugin("zenx-triggers", {} as never); // staged replacement starts
    await service.stopPlugin("zenx-triggers"); // previous generation retires after publish
    const created = await service.create({
      kind: "timer",
      threadId: "target",
      label: "Retained",
      prompt: "Fake local wakeup",
      runAt: Date.now() + 60_000,
    });
    const stored = JSON.parse(
      await readFile(
        path.join(directory, "plugin-data", "zenx-triggers", "storage.json"),
        "utf8",
      ),
    ) as {
      value: { triggers: Array<{ id: string }> };
    };
    assert.equal(
      stored.value.triggers.find((trigger) => trigger.id === created.id)?.id,
      created.id,
      "enabled Catalog tool success must commit its Trigger definition before returning",
    );
  } finally {
    await service.stopPlugin("zenx-triggers");
    await service.stopPlugin("zenx-rooms");
    await rm(directory, { recursive: true, force: true });
  }
});

test("a failed shared-container rename leaves both namespaces at the prior snapshot after reopen", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-automation-container-fault-"),
  );
  let failNextRename = false;
  const storageFileSystem = {
    readFile,
    mkdir,
    writeFile,
    rename: async (source: string, destination: string) => {
      if (failNextRename) {
        failNextRename = false;
        throw Object.assign(
          new Error("injected second namespace write failure"),
          {
            code: "EACCES",
          },
        );
      }
      await rename(source, destination);
    },
    unlink,
  };
  const appServer = {
    request: async () => ({}) as never,
    onNotification: () => () => {},
    enqueue: async () => {},
  };
  try {
    const service = await createBundledAutomationPluginService({
      userDataDirectory: directory,
      appServer,
      storageFileSystem,
    });
    await service.startPlugin("zenx-triggers", {} as never);
    failNextRename = true;
    await assert.rejects(
      service.create({
        kind: "timer",
        threadId: "target",
        label: "faulted",
        prompt: "must not commit",
        runAt: Date.now() + 60_000,
      }),
      /injected second namespace write failure/u,
    );
    const reopened = await createBundledAutomationPluginService({
      userDataDirectory: directory,
      appServer,
    });
    await reopened.startPlugin("zenx-triggers", {} as never);
    assert.deepEqual(reopened.snapshot(), {
      triggers: [],
      history: [],
      rooms: [],
    });
    await reopened.stopPlugin("zenx-triggers");
    await service.stopPlugin("zenx-triggers").catch(() => {});
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
