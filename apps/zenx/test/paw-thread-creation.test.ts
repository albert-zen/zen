import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ZenXBundledAutomationPluginService,
  type AutomationTargetPreview,
} from "../src/main/automation-plugin-service.js";
import type { TriggerSnapshot } from "../src/main/trigger-types.js";
import {
  MAX_ROOM_COUNT,
  MAX_TRIGGER_COUNT,
} from "../src/main/trigger-limits.js";
import {
  createZenXTrustedPlugin,
  type ZenXRoomsTrustedService,
} from "../../../packages/zenx-rooms-plugin/src/runtime.js";

async function fixture() {
  const workspace = await mkdtemp(path.join(tmpdir(), "zenx-paw-create-"));
  let saved: TriggerSnapshot = { rooms: [], triggers: [], history: [] };
  let revision = 1;
  let starts = 0;
  const createdIds: string[] = [];
  let failStart = false;
  let failWrite = false;
  let releaseStart: (() => void) | undefined;
  let heldStart: Promise<void> | undefined;
  const service = new ZenXBundledAutomationPluginService(
    {
      request: async () => {
        throw Error("Setup must not start a Turn");
      },
      onNotification: () => () => {},
    },
    {
      read: async () => structuredClone(saved),
      write: async (snapshot) => {
        if (failWrite) throw Error("disk unavailable");
        saved = structuredClone(snapshot);
      },
    },
    new Set(),
    undefined,
    {
      projectProjection: {
        canonicalKeys: async (values) => values,
        configuredWorkspace: async (value) =>
          value === workspace ? workspace : null,
        configuredWorkspaces: async () => [workspace],
      },
      request: async (_method, params) => ({
        data: params.archived
          ? []
          : [
              {
                id: "existing-thread",
                name: "Existing",
                cwd: workspace,
                status: { type: "idle" as const },
              },
              ...createdIds.map((id) => ({
                id,
                name: id,
                cwd: workspace,
                status: { type: "idle" as const },
              })),
            ],
        nextCursor: null,
      }),
    },
    async () => ({
      model: "zen-model-v1:real-default",
      providerProfileId: "provider",
      modelId: "model",
      reasoningEffort: "high",
      sandbox: "workspace-write",
      approvalPolicy: "on-request",
      processEpoch: "host-epoch",
      revision,
    }),
    async (preview) => {
      starts++;
      await heldStart;
      if (failStart) throw Error("unknown thread/start delivery");
      createdIds.push(`new-thread-${starts}`);
      return {
        thread: { id: `new-thread-${starts}` },
        cwd: preview.resolvedWorkspace,
        model: preview.model,
        sandbox: { type: "workspaceWrite" },
        approvalPolicy: preview.approvalPolicy,
        reasoningEffort: preview.reasoningEffort,
      };
    },
  );
  await service.startPlugin("zenx-rooms", {} as never);
  await service.startPlugin("zenx-triggers", {} as never);
  return {
    service,
    workspace,
    starts: () => starts,
    newInput: async (operationId = "create-1") => ({
      name: "My PAW",
      memberName: "Paw",
      operationId,
      target: {
        kind: "new" as const,
        workspace,
        expected: await service.previewTarget(workspace),
      },
    }),
    changeDefaults: () => {
      revision++;
    },
    failStart: () => {
      failStart = true;
    },
    failWrite: (value: boolean) => {
      failWrite = value;
    },
    holdStart: () => {
      heldStart = new Promise<void>((resolve) => {
        releaseStart = resolve;
      });
    },
    releaseStart: () => {
      releaseStart?.();
    },
    close: async () => {
      releaseStart?.();
      failWrite = false;
      await service.stopPlugin("zenx-triggers");
      await service.stopPlugin("zenx-rooms");
      await rm(workspace, { recursive: true, force: true });
    },
  };
}

test("PAW new setup creates a real idle Thread with confirmed defaults, then its Room and Trigger", async () => {
  const f = await fixture();
  try {
    const input = await f.newInput();
    const room = await f.service.createAssistantRoom(input);
    assert.equal(f.starts(), 1);
    assert.equal(room.assistant?.threadId, "new-thread-1");
    assert.deepEqual(room.members, [{ name: "Paw", threadId: "new-thread-1" }]);
    assert.equal(f.service.snapshot().triggers[0]?.threadId, "new-thread-1");
    assert.equal(f.service.snapshot().history.length, 0);
    assert.deepEqual(await f.service.createAssistantRoom(input), room);
    assert.equal(f.starts(), 1);
    await assert.rejects(
      f.service.createAssistantRoom({ ...input, name: "Changed" }),
      /operation.*different|different.*operation/i,
    );
  } finally {
    await f.close();
  }
});

test("concurrent same PAW submission creates only one Thread and one preset", async () => {
  const f = await fixture();
  try {
    const input = await f.newInput();
    f.holdStart();
    const first = f.service.createAssistantRoom(input);
    const second = f.service.createAssistantRoom(structuredClone(input));
    f.releaseStart();
    assert.deepEqual(await first, await second);
    assert.equal(f.starts(), 1);
    assert.equal(f.service.snapshot().rooms.length, 1);
  } finally {
    await f.close();
  }
});

test("PAW validates name, alias, configured Project, defaults and enabled plugins before Thread creation", async () => {
  const f = await fixture();
  try {
    const input = await f.newInput();
    await assert.rejects(
      f.service.createAssistantRoom({ ...input, name: " " }),
      /name.*required/,
    );
    await assert.rejects(
      f.service.createAssistantRoom({ ...input, memberName: "💙".repeat(64) }),
      /byte bound/,
    );
    await assert.rejects(
      f.service.createAssistantRoom({
        ...input,
        target: { ...input.target, workspace: "/unconfigured" },
      }),
      /not configured/,
    );
    f.changeDefaults();
    await assert.rejects(f.service.createAssistantRoom(input), /changed/);
    const fresh = await f.newInput();
    await f.service.stopPlugin("zenx-triggers");
    await assert.rejects(
      f.service.createAssistantRoom(fresh),
      /Enable Rooms and Triggers/,
    );
    assert.equal(f.starts(), 0);
  } finally {
    await f.close();
  }
});

test("PAW capacity is rejected before creating a Thread", async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < MAX_ROOM_COUNT; i++)
      await f.service.createRoom({
        name: `Room ${i}`,
        members: [{ name: "One", threadId: "existing-thread" }],
      });
    await assert.rejects(
      f.service.createAssistantRoom(await f.newInput()),
      /limit/,
    );
    assert.equal(f.starts(), 0);
    assert.equal(f.service.snapshot().triggers.length, 0);
  } finally {
    await f.close();
  }
  const g = await fixture();
  try {
    for (let i = 0; i < MAX_TRIGGER_COUNT; i++)
      await g.service.create({
        kind: "signal",
        threadId: "existing-thread",
        label: `Signal ${i}`,
        prompt: "Wait",
        signalName: `signal-${i}`,
      });
    await assert.rejects(
      g.service.createAssistantRoom(await g.newInput()),
      /limit/,
    );
    assert.equal(g.starts(), 0);
  } finally {
    await g.close();
  }
});

test("PAW reports known orphan Thread after failed store commit and same operation never creates another", async () => {
  const f = await fixture();
  try {
    const input = await f.newInput();
    f.failWrite(true);
    await assert.rejects(
      f.service.createAssistantRoom(input),
      /Thread new-thread-1.*created.*disk unavailable/,
    );
    f.failWrite(false);
    await assert.rejects(
      f.service.createAssistantRoom(input),
      /Thread new-thread-1/,
    );
    assert.equal(f.starts(), 1);
    assert.equal(f.service.snapshot().rooms.length, 0);
    assert.equal(f.service.snapshot().triggers.length, 0);
    const recovered = await f.service.createAssistantRoom({
      name: input.name,
      memberName: input.memberName,
      operationId: "explicit-bind-after-failure",
      target: { kind: "existing", threadId: "new-thread-1" },
    });
    assert.equal(recovered.assistant?.threadId, "new-thread-1");
    assert.equal(f.starts(), 1);
  } finally {
    await f.close();
  }
});

test("PAW retains uncertain Thread-start failure and does not automatically retry it", async () => {
  const f = await fixture();
  try {
    const input = await f.newInput();
    f.failStart();
    await assert.rejects(
      f.service.createAssistantRoom(input),
      /Thread creation.*unknown thread\/start delivery.*inspect/i,
    );
    await assert.rejects(
      f.service.createAssistantRoom(input),
      /unknown thread\/start delivery/,
    );
    assert.equal(f.starts(), 1);
    assert.equal(f.service.snapshot().rooms.length, 0);
  } finally {
    await f.close();
  }
});

test("explicit existing binding and legacy cached-runtime binding create no Thread", async () => {
  const f = await fixture();
  try {
    const room = await f.service.createAssistantRoom({
      name: "Existing PAW",
      memberName: "Paw",
      operationId: "bind-1",
      target: { kind: "existing", threadId: "Existing" },
    });
    assert.equal(room.assistant?.threadId, "existing-thread");
    const legacy = await f.service.createAssistantRoom({
      name: "Legacy",
      members: [{ name: "Chief", threadId: "existing-thread" }],
    });
    assert.equal(legacy.assistant?.threadId, "existing-thread");
    assert.equal(f.starts(), 0);
  } finally {
    await f.close();
  }
});

test("Rooms new PAW discovery/creation contract is trusted UI only", async () => {
  const calls: string[] = [];
  const expected = {
    workspace: "/work",
    resolvedWorkspace: "/work",
    model: "default",
    providerProfileId: "provider",
    modelId: "model",
    reasoningEffort: null,
    sandbox: "workspace-write",
    approvalPolicy: "on-request",
    processEpoch: "epoch",
    revision: 1,
  } satisfies AutomationTargetPreview;
  const input = {
    name: "Paw",
    memberName: "Paw",
    operationId: "create",
    target: { kind: "new", workspace: "/work", expected },
  };
  const service = {
    workspaces: async () => {
      calls.push("workspaces");
      return ["/work"];
    },
    previewTarget: async (workspace: string) => {
      calls.push(workspace);
      return expected;
    },
    createAssistantRoom: async (captured: unknown) => {
      calls.push("create");
      assert.deepEqual(captured, input);
      return { id: "room" };
    },
  } as unknown as ZenXRoomsTrustedService;
  const runtime = createZenXTrustedPlugin(service);
  const invocation = (args: Record<string, unknown>, trusted = false) => ({
    callId: "call",
    cwd: "/work",
    signal: new AbortController().signal,
    arguments: { input: args, trustedPluginUi: true },
    ...(trusted ? { trustedPluginUi: true as const } : {}),
  });
  for (const tool of [
    "zenx_rooms_workspaces",
    "zenx_rooms_preview_target",
    "zenx_rooms_create_assistant",
  ])
    await assert.rejects(
      runtime.invoke(tool, invocation(input)),
      /Trusted Room UI/,
    );
  assert.deepEqual(calls, []);
  assert.deepEqual(
    await runtime.invoke("zenx_rooms_workspaces", invocation({}, true)),
    ["/work"],
  );
  assert.deepEqual(
    await runtime.invoke(
      "zenx_rooms_preview_target",
      invocation({ workspace: "/work" }, true),
    ),
    expected,
  );
  await runtime.invoke("zenx_rooms_create_assistant", invocation(input, true));
  assert.deepEqual(calls, ["workspaces", "/work", "create"]);
});

test("PAW creation receipts are bounded without evicting duplicate prevention", async () => {
  const f = await fixture();
  try {
    const input = {
      name: "Paw",
      memberName: "Paw",
      operationId: "bind-0",
      target: { kind: "existing" as const, threadId: "existing-thread" },
    };
    let original:
      Awaited<ReturnType<typeof f.service.createAssistantRoom>> | undefined;
    for (let i = 0; i < 256; i++) {
      const room = await f.service.createAssistantRoom({
        ...input,
        operationId: `bind-${i}`,
      });
      if (i === 0) original = room;
      await f.service.deleteRoom(room.id);
    }
    await assert.rejects(
      f.service.createAssistantRoom({
        ...input,
        operationId: "bind-over-limit",
      }),
      /operation limit/,
    );
    assert.deepEqual(await f.service.createAssistantRoom(input), original);
    assert.equal(f.service.snapshot().rooms.length, 0);
    assert.equal(f.starts(), 0);
  } finally {
    await f.close();
  }
});

test("Rooms PAW input contract rejects mixed or malformed targets before calling Host setup", async () => {
  let setups = 0;
  const runtime = createZenXTrustedPlugin({
    createAssistantRoom: async () => {
      setups++;
      return {} as never;
    },
  } as unknown as ZenXRoomsTrustedService);
  const invoke = (input: Record<string, unknown>) =>
    runtime.invoke("zenx_rooms_create_assistant", {
      callId: "call",
      trustedPluginUi: true,
      arguments: { input },
      cwd: "/work",
      signal: new AbortController().signal,
    });
  const input = {
    name: "Paw",
    memberName: "Paw",
    operationId: "create",
    target: { kind: "existing", threadId: "thread" },
  };
  await assert.rejects(
    invoke({ ...input, members: [{ name: "Paw", threadId: "thread" }] }),
    /Unknown/,
  );
  await assert.rejects(
    invoke({ ...input, target: { kind: "unknown", threadId: "thread" } }),
    /Choose/,
  );
  await assert.rejects(
    invoke({
      ...input,
      target: { kind: "new", workspace: "/work", expected: {} },
    }),
    /workspace/,
  );
  await assert.rejects(
    invoke({
      ...input,
      target: { kind: "existing", threadId: "thread", workspace: "/work" },
    }),
    /Unknown/,
  );
  assert.equal(setups, 0);
});
