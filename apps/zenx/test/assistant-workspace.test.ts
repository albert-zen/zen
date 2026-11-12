import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { ZenXTriggerStore } from "../src/main/trigger-store.js";
import { ZenXTriggerService } from "../src/main/trigger-service.js";
import type { AssistantWorkspace } from "../src/main/trigger-types.js";
import { createZenXTrustedPlugin } from "../../../packages/zenx-rooms-plugin/src/runtime.js";

const draft = (): Pick<AssistantWorkspace, "matters" | "memory"> => ({
  matters: [
    {
      id: "matter",
      title: "Ship prototype",
      plan: "Review the next result",
      statusNote: "Waiting for a reply",
      notes: "https://example.com/context",
      references: [
        {
          kind: "thread",
          device: "local",
          workspace: "/workspace/project",
          threadId: "delegated",
          label: "Local implementation",
        },
        {
          kind: "thread",
          device: "laptop",
          workspace: "remote-workspace",
          threadId: "remote-thread",
          label: "Remote check",
        },
        {
          kind: "trigger",
          triggerId: "completion-watch",
          label: "Completion notification",
        },
      ],
    },
  ],
  memory: [
    {
      id: "memory",
      title: "Project decision",
      text: "Use the existing Room as the communication channel",
    },
  ],
});
async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zenx-workspace-"));
  const file = path.join(directory, "state.json");
  const store = new ZenXTriggerStore(file);
  let modelCalls = 0;
  const service = new ZenXTriggerService(
    {
      request: async () => {
        modelCalls++;
        throw Error("No execution expected");
      },
      onNotification: () => () => {},
    } as never,
    store,
  );
  await service.start();
  const room = await service.createAssistantRoom({
    name: "Companion",
    members: [{ name: "Companion", threadId: "assistant-thread" }],
  });
  return {
    service,
    room,
    store,
    file,
    modelCalls: () => modelCalls,
    close: async () => {
      await service.stop();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("PAW annotations explicitly read/update and survive restart without executing work", async () => {
  const f = await fixture();
  try {
    assert.deepEqual(f.service.assistantWorkspace(f.room.id), {
      revision: 0,
      updatedAt: 0,
      matters: [],
      memory: [],
    });
    const result = await f.service.updateAssistantWorkspace({
      roomId: f.room.id,
      expectedRevision: 0,
      ...draft(),
    });
    assert.equal(result.revision, 1);
    assert.ok(result.updatedAt > 0);
    assert.deepEqual(result.matters, draft().matters);
    result.matters[0]!.title = "caller mutation";
    assert.equal(
      f.service.assistantWorkspace(f.room.id).matters[0]!.title,
      "Ship prototype",
    );
    assert.equal(
      (await f.store.read()).rooms[0]?.assistantWorkspace?.revision,
      1,
    );
    assert.equal(f.modelCalls(), 0);
    await f.service.stop();
    await f.service.start();
    assert.equal(
      f.service.assistantWorkspace(f.room.id).memory[0]!.text,
      draft().memory[0]!.text,
    );
    assert.equal(f.modelCalls(), 0);
  } finally {
    await f.close();
  }
});

test("PAW defaults preserve saved Companion names, labels and custom prompts", async () => {
  const f = await fixture();
  try {
    assert.equal(f.service.snapshot().triggers[0]?.label, "PAW");
    await f.service.stop();
    const saved = await f.store.read();
    saved.triggers[0]!.label = "Companion";
    saved.triggers[0]!.prompt = "My custom Companion instructions";
    await f.store.write(saved);
    await f.service.start();
    const loaded = f.service.snapshot();
    assert.equal(loaded.rooms[0]?.name, "Companion");
    assert.equal(loaded.rooms[0]?.members[0]?.name, "Companion");
    assert.equal(loaded.triggers[0]?.label, "Companion");
    assert.equal(
      loaded.triggers[0]?.prompt,
      "My custom Companion instructions",
    );
    assert.equal(f.modelCalls(), 0);
  } finally {
    await f.close();
  }
});

test("concurrent CAS has one winner and preserves rejected editor's original version", async () => {
  const f = await fixture();
  try {
    const outcomes = await Promise.allSettled([
      f.service.updateAssistantWorkspace({
        roomId: f.room.id,
        expectedRevision: 0,
        ...draft(),
      }),
      f.service.updateAssistantWorkspace({
        roomId: f.room.id,
        expectedRevision: 0,
        matters: [],
        memory: [],
      }),
    ]);
    assert.equal(
      outcomes.filter((value) => value.status === "fulfilled").length,
      1,
    );
    const failed = outcomes.find(
      (value) => value.status === "rejected",
    ) as PromiseRejectedResult;
    assert.match(String(failed.reason), /changed.*refresh/i);
    assert.equal(failed.reason.currentRevision, 1);
    assert.equal(f.service.assistantWorkspace(f.room.id).revision, 1);
    assert.equal(
      (await f.store.read()).rooms[0]?.assistantWorkspace?.revision,
      1,
    );
  } finally {
    await f.close();
  }
});

test("failed annotation commit changes neither public snapshot nor disk nor notifications", async () => {
  const f = await fixture();
  try {
    const original = await readFile(f.file, "utf8");
    let notifications = 0;
    const dispose = f.service.onChange(() => {
      notifications++;
    });
    const write = f.store.write.bind(f.store);
    f.store.write = async () => {
      throw Error("simulated write failure");
    };
    await assert.rejects(
      f.service.updateAssistantWorkspace({
        roomId: f.room.id,
        expectedRevision: 0,
        ...draft(),
      }),
      /simulated write failure/,
    );
    assert.equal(notifications, 0);
    assert.equal(f.service.assistantWorkspace(f.room.id).revision, 0);
    assert.equal(await readFile(f.file, "utf8"), original);
    f.store.write = write;
    dispose();
  } finally {
    await f.close();
  }
});

test("strict annotation limits reject missing attribution, duplicate IDs, execution facts and oversized UTF-8/documents", async () => {
  const f = await fixture();
  try {
    const bad = [
      { ...draft(), matters: [{ ...draft().matters[0], status: "completed" }] },
      { ...draft(), matters: [draft().matters[0], draft().matters[0]] },
      { ...draft(), memory: [draft().memory[0], draft().memory[0]] },
      {
        ...draft(),
        matters: [
          {
            ...draft().matters[0],
            references: [
              {
                kind: "thread",
                device: "local",
                threadId: "missing-workspace",
                label: "Bad",
              },
            ],
          },
        ],
      },
      {
        ...draft(),
        matters: [{ ...draft().matters[0], title: "你".repeat(100) }],
      },
      {
        ...draft(),
        memory: Array.from({ length: 65 }, (_, i) => ({
          id: String(i),
          title: "title",
          text: "text",
        })),
      },
      {
        matters: [],
        memory: Array.from({ length: 20 }, (_, i) => ({
          id: String(i),
          title: "title",
          text: "x".repeat(3_000),
        })),
      },
      { ...draft(), author: "user" },
      { ...draft(), matters: new Array(1) },
      { ...draft(), matters: [Object.create(draft().matters[0]!)] },
      {
        ...draft(),
        matters: [
          {
            ...draft().matters[0]!,
            references: [
              {
                kind: "thread",
                device: " ",
                workspace: "/workspace",
                threadId: "thread",
                label: "Bad",
              },
            ],
          },
        ],
      },
    ];
    for (const value of bad)
      await assert.rejects(
        f.service.updateAssistantWorkspace({
          roomId: f.room.id,
          expectedRevision: 0,
          ...value,
        } as never),
      );
    assert.equal(f.service.assistantWorkspace(f.room.id).revision, 0);
    const ordinary = await f.service.createRoom({
      name: "Ordinary",
      members: [{ name: "Agent", threadId: "other" }],
    });
    assert.throws(
      () => f.service.assistantWorkspace(ordinary.id),
      /assistant|PAW/i,
    );
    await assert.rejects(
      f.service.updateAssistantWorkspace({
        roomId: ordinary.id,
        expectedRevision: 0,
        ...draft(),
      }),
      /assistant|PAW/i,
    );
    assert.equal(f.modelCalls(), 0);
  } finally {
    await f.close();
  }
});

test("legacy Room data stays readable and unknown persisted annotation fields are rejected", async () => {
  const f = await fixture();
  try {
    const legacy = JSON.parse(await readFile(f.file, "utf8"));
    assert.equal(legacy.rooms[0].assistantWorkspace, undefined);
    assert.equal(
      (await f.store.read()).rooms[0]?.assistantWorkspace,
      undefined,
    );
    legacy.rooms[0].assistantWorkspace = {
      revision: 0,
      updatedAt: 0,
      ...draft(),
      author: "user",
    };
    await writeFile(f.file, JSON.stringify(legacy));
    await assert.rejects(f.store.read(), /invalid entry shape/);
    delete legacy.rooms[0].assistantWorkspace.author;
    legacy.rooms[0].assistantWorkspace.matters[0].status = "running";
    await writeFile(f.file, JSON.stringify(legacy));
    await assert.rejects(f.store.read(), /invalid entry shape/);
    delete legacy.rooms[0].assistantWorkspace.matters[0].status;
    await writeFile(f.file, JSON.stringify(legacy));
    assert.equal(
      (await f.store.read()).rooms[0]?.assistantWorkspace?.revision,
      0,
    );
  } finally {
    await f.close();
  }
});

test("Rooms workspace tools return explicit bounded data and CAS update, without trusted-author spoofing", async () => {
  const f = await fixture();
  try {
    const runtime = createZenXTrustedPlugin(f.service);
    const invoke = (name: string, args: Record<string, unknown>) =>
      runtime.invoke(name, {
        callId: "call",
        arguments: args,
        cwd: "/workspace",
        signal: new AbortController().signal,
      });
    assert.deepEqual(
      await invoke("zenx_rooms_workspace", { roomId: f.room.id }),
      { revision: 0, updatedAt: 0, matters: [], memory: [] },
    );
    const updated = (await invoke("zenx_rooms_update_workspace", {
      roomId: f.room.id,
      expectedRevision: 0,
      ...draft(),
    })) as { revision: number };
    assert.equal(updated.revision, 1);
    await assert.rejects(
      invoke("zenx_rooms_update_workspace", {
        roomId: f.room.id,
        expectedRevision: 1,
        ...draft(),
        author: "user",
      }),
      /invalid|unknown|field/i,
    );
    assert.equal(f.modelCalls(), 0);
  } finally {
    await f.close();
  }
});

test("Host invocation scope exposes notes explicitly, rejects escaped calls and preserves data across Rooms disable/re-enable", async () => {
  const { createBundledAutomationPluginService } =
    await import("../src/main/automation-plugin-service.js");
  const { createZenXRoomsProfileLoader } =
    await import("../src/main/rooms-profile-loader.js");
  const f = await fixture();
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-workspace-scope-"),
  );
  const sdk = {} as never;
  await new ZenXTriggerStore(
    path.join(directory, "trigger-registry.json"),
  ).write(f.service.snapshot());
  const domain = await createBundledAutomationPluginService({
    userDataDirectory: directory,
    appServer: {
      request: async () => {
        throw Error("No model execution expected");
      },
      onNotification: () => () => {},
    } as never,
  });
  let escaped: ((id: string) => AssistantWorkspace) | undefined;
  const runtime = createZenXRoomsProfileLoader(() => domain)({
    createZenXTrustedPlugin: (
      port: Parameters<typeof createZenXTrustedPlugin>[0],
    ) => {
      escaped = port.assistantWorkspace;
      return createZenXTrustedPlugin(port);
    },
  });
  const invoke = (name: string, args: Record<string, unknown>) =>
    runtime.invoke(name, {
      callId: "call",
      arguments: args,
      cwd: directory,
      signal: new AbortController().signal,
    });
  try {
    await domain.startPlugin("zenx-rooms", sdk);
    await invoke("zenx_rooms_update_workspace", {
      roomId: f.room.id,
      expectedRevision: 0,
      ...draft(),
    });
    const notes = (await invoke("zenx_rooms_workspace", {
      roomId: f.room.id,
    })) as AssistantWorkspace;
    assert.equal(notes.revision, 1);
    assert.equal(notes.memory[0]?.title, "Project decision");
    const list = await invoke("zenx_rooms_list", {});
    assert.equal(JSON.stringify(list).includes("assistantWorkspace"), false);
    assert.equal(JSON.stringify(list).includes("Project decision"), false);
    assert.throws(() => escaped!(f.room.id), /invocation is not active/);
    await domain.stopPlugin("zenx-rooms", sdk);
    assert.throws(
      () => domain.assistantWorkspace(f.room.id),
      /disabled|unavailable/,
    );
    await assert.rejects(
      domain.updateAssistantWorkspace({
        roomId: f.room.id,
        expectedRevision: 1,
        ...draft(),
      }),
      /disabled|unavailable/,
    );
    await domain.startPlugin("zenx-rooms", sdk);
    assert.equal(domain.assistantWorkspace(f.room.id).revision, 1);
    assert.equal(
      domain.assistantWorkspace(f.room.id).memory[0]?.title,
      "Project decision",
    );
    assert.equal(f.modelCalls(), 0);
  } finally {
    await domain.stopPlugin("zenx-rooms", sdk);
    await f.close();
    await rm(directory, { recursive: true, force: true });
  }
});
