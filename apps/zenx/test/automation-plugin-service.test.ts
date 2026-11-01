import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  open,
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
import { syncDirectory } from "../../../src/storage-files.js";
import type { TriggerSnapshot } from "../src/main/trigger-types.js";
import type { ZenXTriggerAppServerPort } from "../src/main/trigger-service.js";
import type {
  ClientRequestResults,
  ServerNotificationMethod,
  ServerNotificationParams,
  Turn,
} from "../src/protocol-client/index.js";

const idlePort = {
  request: async () => ({}) as never,
  onNotification: () => () => {},
};

test("corrupt optional legacy state does not block an otherwise empty bootstrap", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-automation-service-"),
  );
  let service: ZenXBundledAutomationPluginService | undefined;
  try {
    const file = path.join(directory, "trigger-registry.json");
    await writeFile(file, "not-json");
    service = await createBundledAutomationPluginService({
      userDataDirectory: directory,
      appServer: idlePort,
    });
    await service.startPlugin("zenx-rooms", {} as never);
    assert.deepEqual(service.snapshot(), {
      triggers: [],
      history: [],
      rooms: [],
    });
    assert.equal(await readFile(file, "utf8"), "not-json");
  } finally {
    await service?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("migration preserves an existing valid v1 Room namespace when shared Trigger data lacks rooms", async () => {
  const directory = await mkdtemp(
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
  let service: ZenXBundledAutomationPluginService | undefined;
  try {
    const root = path.join(directory, "plugin-data");
    for (const plugin of ["zenx-triggers", "zenx-rooms"])
      await mkdir(path.join(root, plugin), { recursive: true });
    await writeFile(
      path.join(root, "zenx-triggers", "storage.json"),
      JSON.stringify({ version: 1, value: { triggers: [], history: [] } }),
      { mode: 0o600 },
    );
    await writeFile(
      path.join(root, "zenx-rooms", "storage.json"),
      JSON.stringify({ version: 1, value: { rooms: [room] } }),
      { mode: 0o600 },
    );
    for (let boot = 0; boot < 2; boot++) {
      service = await createBundledAutomationPluginService({
        userDataDirectory: directory,
        appServer: idlePort,
      });
      await service.startPlugin("zenx-rooms", {} as never);
      const { messageCount, ...restored } = service.snapshot().rooms[0]!;
      assert.deepEqual(restored, room);
      assert.equal(messageCount, 0);
      assert.equal(
        (await service.readRoomPage(room.id)).snapshot?.messageCount,
        0,
      );
      await service.close();
      service = undefined;
    }
  } finally {
    await service?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

for (const [name, roomBytes, expected] of [
  [
    "invalid v1 Room shape",
    JSON.stringify({ version: 1, value: { rooms: { bad: true } } }),
    /invalid entry shape/,
  ],
  ["corrupt Room JSON", "not-json", /JSON|Unexpected token/],
  [
    "future-version Room namespace",
    JSON.stringify({ version: 3, value: { rooms: [] } }),
    /Future automation storage version/,
  ],
] as const)
  test(`${name} fails closed without repairing or overwriting either source`, async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "zenx-room-invalid-source-"),
    );
    try {
      const root = path.join(directory, "plugin-data");
      for (const plugin of ["zenx-triggers", "zenx-rooms"])
        await mkdir(path.join(root, plugin), { recursive: true });
      const sharedFile = path.join(root, "zenx-triggers", "storage.json");
      const roomFile = path.join(root, "zenx-rooms", "storage.json");
      const sharedBytes = JSON.stringify({
        version: 1,
        value: { triggers: [], history: [] },
      });
      await writeFile(sharedFile, sharedBytes, { mode: 0o600 });
      await writeFile(roomFile, roomBytes, { mode: 0o600 });
      await assert.rejects(
        createBundledAutomationPluginService({
          userDataDirectory: directory,
          appServer: idlePort,
        }),
        expected,
      );
      assert.equal(await readFile(sharedFile, "utf8"), sharedBytes);
      assert.equal(await readFile(roomFile, "utf8"), roomBytes);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

test("ordinary journal mutations do not rewrite Room projection markers and persist across restart", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-room-marker-stable-"),
  );
  let forbidProjectionRename = false;
  const storageFileSystem = {
    readFile,
    mkdir,
    writeFile,
    unlink,
    openFile: open,
    syncDirectory,
    rename: async (source: string, destination: string) => {
      if (forbidProjectionRename && destination.includes("zenx-rooms"))
        throw Error("unexpected daily Room projection write");
      await rename(source, destination);
    },
  };
  let service: ZenXBundledAutomationPluginService | undefined;
  try {
    service = await createBundledAutomationPluginService({
      userDataDirectory: directory,
      appServer: idlePort,
      storageFileSystem,
    });
    await service.startPlugin("zenx-rooms", {} as never);
    await service.startPlugin("zenx-triggers", {} as never);
    const marker = path.join(
      directory,
      "plugin-data",
      "zenx-rooms",
      "storage.json",
    );
    const before = await readFile(marker, "utf8");
    const sharedMarker = path.join(
      directory,
      "plugin-data",
      "zenx-triggers",
      "storage.json",
    );
    const sharedBefore = await readFile(sharedMarker, "utf8");
    forbidProjectionRename = true;
    const created = await service.create({
      kind: "timer",
      threadId: "target",
      label: "canonical",
      prompt: "committed",
      runAt: Date.now() + 60_000,
    });
    const room = await service.createRoom({
      name: "Persisted Room",
      members: [{ name: "Member", threadId: "target" }],
    });
    await service.postAgentRoomMessage(
      room.id,
      "Persisted without projection write",
    );
    const message = (await service.readRoomPage(room.id)).messages[0]!;
    assert.equal(service.snapshot().triggers[0]?.id, created.id);
    assert.equal(await readFile(marker, "utf8"), before);
    assert.equal(await readFile(sharedMarker, "utf8"), sharedBefore);
    await service.close();
    service = undefined;
    service = await createBundledAutomationPluginService({
      userDataDirectory: directory,
      appServer: idlePort,
      storageFileSystem,
    });
    await service.startPlugin("zenx-triggers", {} as never);
    assert.equal(service.snapshot().triggers[0]?.id, created.id);
    assert.equal(service.snapshot().triggers[0]?.label, "canonical");
    await service.startPlugin("zenx-rooms", {} as never);
    assert.deepEqual(
      (await service.readRoomMessage(room.id, message.id))?.message,
      message,
    );
    assert.equal(
      (await service.readRoomPage(room.id)).snapshot?.messageCount,
      1,
    );
    assert.equal(await readFile(sharedMarker, "utf8"), sharedBefore);
    assert.equal(await readFile(marker, "utf8"), before);
  } finally {
    await service?.close();
    await rm(directory, { recursive: true, force: true });
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
    request: async (method) => {
      assert.equal(method, "zen/turn/wake");
      return { mode: "queue", queued: true };
    },
    onNotification: (handler) => {
      listener = handler;
      return () => {
        listener = undefined;
      };
    },
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
      deliveryMode: "queue",
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
    await service.close();
  }
});

test("configured workspace and Host defaults are rechecked before dedicated Thread admission", async (t) => {
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
  t.after(() => service.close());
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
    await service.close();
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
    await service.close();
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
    assert.equal(
      service.snapshot().triggers.find((trigger) => trigger.id === created.id)
        ?.id,
      created.id,
    );
    await service.close();
    const reopened = await createBundledAutomationPluginService({
      userDataDirectory: directory,
      appServer: idlePort,
    });
    try {
      await reopened.startPlugin("zenx-triggers", {} as never);
      assert.equal(
        reopened
          .snapshot()
          .triggers.find((trigger) => trigger.id === created.id)?.id,
        created.id,
        "enabled Catalog tool success must commit its Trigger definition before returning",
      );
    } finally {
      await reopened.close();
    }
  } finally {
    await service.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a real append identity failure cannot ACK and reopening preserves both prior namespaces", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-automation-journal-fault-"),
  );
  let dispatches = 0;
  const appServer = {
    request: async () => {
      dispatches++;
      throw Error("No dispatch expected");
    },
    onNotification: () => () => {},
  };
  const service = await createBundledAutomationPluginService({
    userDataDirectory: directory,
    appServer,
  });
  try {
    await service.startPlugin("zenx-triggers", {} as never);
    await service.startPlugin("zenx-rooms", {} as never);
    await service.create({
      kind: "timer",
      threadId: "target",
      label: "Prior trigger",
      prompt: "Prior durable definition",
      runAt: Date.now() + 600_000,
    });
    const room = await service.createRoom({
      name: "Prior room",
      members: [{ name: "Member", threadId: "target" }],
    });
    await service.postAgentRoomMessage(room.id, "Prior message");
    const before = service.snapshot();
    const namespace = path.join(directory, "plugin-data", "zenx-triggers");
    const marker = JSON.parse(
      await readFile(path.join(namespace, "storage.json"), "utf8"),
    );
    const journal = path.join(
      namespace,
      "automation-history",
      `automation-${marker.value.generation}.jsonl`,
    );
    const bytes = await readFile(journal);
    await rename(journal, journal + ".detached");
    await writeFile(journal, bytes, { mode: 0o600 });
    await assert.rejects(
      service.create({
        kind: "timer",
        threadId: "target",
        label: "faulted",
        prompt: "must not ACK",
        runAt: Date.now() + 60_000,
      }),
      /outcome is unknown/,
    );
    assert.throws(() => service.snapshot(), /outcome is unknown/);
    await assert.rejects(
      service.postAgentRoomMessage(
        room.id,
        "Attempt after unknown must not persist",
      ),
      /outcome is unknown/,
    );
    assert.equal(dispatches, 0);
    assert.deepEqual(await readFile(journal), bytes);
    assert.deepEqual(await readFile(journal + ".detached"), bytes);
    await service
      .close()
      .catch((error) => assert.match(String(error), /outcome is unknown/));
    const reopened = await createBundledAutomationPluginService({
      userDataDirectory: directory,
      appServer,
    });
    try {
      await reopened.startPlugin("zenx-triggers", {} as never);
      await reopened.startPlugin("zenx-rooms", {} as never);
      assert.deepEqual(reopened.snapshot(), before);
      assert.equal(
        dispatches,
        0,
        "reopening must not replay the rejected mutation",
      );
      assert.deepEqual(
        (await reopened.readRoomPage(room.id)).messages,
        before.rooms[0]!.messages,
      );
    } finally {
      await reopened.close();
    }
  } finally {
    await service
      .close()
      .catch((error) => assert.match(String(error), /outcome is unknown/));
    await rm(directory, { recursive: true, force: true });
  }
});
