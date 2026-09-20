import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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

test("completion setup resolves readable targets without ambiguous writes and reads the exact source result", async () => {
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
      projectProjection: { canonicalKeys: async (values) => values },
      request: async (_method, params) => ({
        data: params.archived ? [] : rows,
        nextCursor: null,
      }),
    },
  );
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
  } finally {
    await service.stopPlugin("zenx-triggers");
  }
});
