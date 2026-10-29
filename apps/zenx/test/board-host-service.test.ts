import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import {
  BoardHostService,
  type BoardHostServiceOptions,
} from "../src/main/board-host-service.js";
import { BoardToolService } from "../src/main/board-tool-service.js";
import {
  validateBoardOwner,
  validateBoardToolRequest,
} from "../src/board-host.js";
import {
  ToolEnvironment,
  InMemoryToolPolicyStore,
  type ToolInvocation,
  type ToolRuntime,
} from "../../../src/tool.js";
import { InMemoryTraceStore } from "../../../src/trace.js";
import type {
  AppServerEvent,
  ThreadSnapshot,
} from "../../../src/app-server.js";
import {
  ZenXTriggerService,
  type ZenXTriggerAppServerPort,
} from "../src/main/trigger-service.js";
import { canonicalTriggerSnapshot } from "../src/main/trigger-store.js";
import type { TriggerSnapshot, ZenXRoom } from "../src/main/trigger-types.js";
import { isHostCommand, isHostEvent } from "../src/main/host-messages.js";

const signal = () => new AbortController().signal;
const owner = { kind: "thread" as const, threadId: "board-thread" };

function hostFixture() {
  let active = false;
  let archived = false;
  let sendError: Error | undefined;
  let onRead = () => {};
  const requests: Array<{ method: string; params: any }> = [];
  const executions: unknown[] = [];
  const rooms: ZenXRoom[] = [
    {
      id: "room",
      name: "Room",
      members: [{ name: "One", threadId: owner.threadId }],
      messages: [],
      createdAt: 1,
    },
  ];
  const host = new BoardHostService({
    readThreadSummary: async (threadId) => {
      requests.push({ method: "thread-summary/list", params: { threadId } });
      onRead();
      return { threadId, archived };
    },
    appServer: {
      async request(method: string, params: any): Promise<any> {
        requests.push({ method, params });
        if (method === "thread/read")
          return {
            thread: {
              id: params.threadId,
              turns: active ? [{ id: "active", status: "inProgress" }] : [],
            },
          };
        if (method === "zen/turn/send-unarchived") {
          if (sendError) throw sendError;
          return { turnId: active ? "active" : "new-turn" };
        }
        assert.fail(`Unexpected model operation ${method}`);
      },
    } as BoardHostServiceOptions["appServer"],
    rooms: {
      roomsAvailable: () => true,
      snapshot: () => ({ rooms }),
      onChange: () => () => {},
      postAddressedRoomMessage: async () => assert.fail("Unexpected Room send"),
    },
    executeTool: async (request) => {
      executions.push(request);
      return { output: "ok", exitCode: 0 };
    },
  });
  return {
    host,
    requests,
    executions,
    rooms,
    setActive: () => {
      active = true;
    },
    setArchived: () => {
      archived = true;
    },
    failSend: () => {
      sendError = new Error("transport disconnected");
    },
    onRead: (callback: () => void) => {
      onRead = callback;
    },
  };
}

test("Board Thread send reports native start/steer admission without awaiting completion", async () => {
  const f = hostFixture();
  assert.deepEqual(
    await f.host.deliver(owner, "assembled text", "client-1", signal()),
    {
      kind: "thread",
      threadId: owner.threadId,
      turnId: "new-turn",
      mode: "start",
      admission: "accepted",
    },
  );
  f.setActive();
  const result = await f.host.deliver(owner, "guidance", "client-2", signal());
  assert.equal(result.kind === "thread" && result.mode, "steer");
  const sends = f.requests.filter(
    (request) => request.method === "zen/turn/send-unarchived",
  );
  assert.equal(sends.length, 2);
  assert.deepEqual(sends[1]!.params, {
    threadId: owner.threadId,
    clientUserMessageId: "client-2",
    input: [{ type: "text", text: "guidance" }],
    mode: "steer",
    expectedTurnId: "active",
  });
  assert.deepEqual(f.executions, []);
});

test("unknown Board send is never retried or interpreted as completion", async () => {
  const f = hostFixture();
  f.failSend();
  await assert.rejects(
    f.host.deliver(owner, "message", "client", signal()),
    /disconnected/,
  );
  assert.equal(
    f.requests.filter((entry) => entry.method === "zen/turn/send-unarchived")
      .length,
    1,
  );
});

test("Board owner admission is exact and rechecks removed Room membership after reads", async () => {
  const f = hostFixture();
  const roomOwner = {
    kind: "room" as const,
    roomId: "room",
    threadId: owner.threadId,
  };
  assert.match(f.host.makeClientId(roomOwner), /^legacy:[0-9a-f-]{36}$/);
  await assert.rejects(
    f.host.readOwner({ ...roomOwner, threadId: "other" }),
    /exact Room member/,
  );
  f.onRead(() => {
    f.rooms[0]!.members = [];
  });
  await assert.rejects(
    f.host.execute(
      roomOwner,
      { tool: "shell", arguments: { command: "true" } },
      signal(),
    ),
    /exact Room member/,
  );
  assert.equal(f.executions.length, 0);
  f.setArchived();
  await assert.rejects(f.host.deliver(owner, "x", "id", signal()), /archived/);
});

test("no-model action has no native send or owner override and unsupported mechanisms fail", async () => {
  const f = hostFixture();
  await f.host.execute(
    owner,
    {
      tool: "shell",
      arguments: { command: "echo synthetic" },
      threadId: "other",
    } as any,
    signal(),
  );
  assert.deepEqual(f.executions, [
    {
      threadId: owner.threadId,
      owner,
      tool: "shell",
      arguments: { command: "echo synthetic" },
    },
  ]);
  assert.deepEqual(
    f.requests.map((entry) => entry.method),
    ["thread-summary/list"],
  );
  await assert.rejects(
    f.host.execute(
      owner,
      { tool: "zenx_threads_send", arguments: {} },
      signal(),
    ),
    /local shell/,
  );
  assert.throws(() => validateBoardOwner({ ...owner, cwd: "/" }));
  assert.throws(() =>
    validateBoardToolRequest({
      threadId: owner.threadId,
      tool: "shell",
      arguments: { device: "remote" },
    }),
  );
  assert.throws(() =>
    validateBoardToolRequest({
      threadId: owner.threadId,
      tool: "shell",
      arguments: { x: undefined },
    }),
  );
  assert.throws(
    () =>
      validateBoardToolRequest({
        ...shellRequest,
        owner: { kind: "room", roomId: "room", threadId: "other" },
      }),
    /exact Thread/,
  );
});

function toolFixture(
  policy: "never" | "always" = "never",
  remembered?: "approved" | "denied",
  execution?: ToolRuntime["execute"],
  cancellation: "confirmed-on-settle" | "unconfirmed" = "confirmed-on-settle",
) {
  const trace = new InMemoryTraceStore();
  const store = new InMemoryToolPolicyStore(
    remembered ? { shell: remembered } : {},
  );
  const calls: ToolInvocation[] = [];
  let fail = false;
  let rejectDispatch = false;
  let held = 0;
  const snapshot: ThreadSnapshot = {
    id: owner.threadId,
    cwd: "/tmp",
    sandbox: "danger-full-access",
    approvalPolicy: policy,
    archived: false,
    items: [],
    turns: [],
    provider: "fake",
    model: "fake",
    providerProfileId: "fake",
    modelId: "fake",
    reasoningEffort: null,
  };
  const tools = new ToolEnvironment({
    trace,
    policyStore: store,
    taskOptions: { yieldTimeMs: 1, shutdownWaitMs: 10 },
    runtimes: [
      {
        name: "shell",
        taskPolicy: {
          cancellation,
          timingArguments: { timeoutMs: "timeout_ms" },
        },
        specification: {
          name: "shell",
          description: "Synthetic local script",
          inputSchema: {
            type: "object",
            properties: { command: { type: "string" } },
          },
        },
        async execute(invocation) {
          calls.push(invocation);
          if (fail) throw new Error("Lost actual result");
          if (execution) return await execution(invocation);
          return { output: "synthetic output", exitCode: 0 };
        },
      },
    ],
  });
  const listeners = new Set<(event: AppServerEvent) => void>();
  const app: ConstructorParameters<typeof BoardToolService>[0] = {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    readThread: async (id) => {
      assert.equal(id, snapshot.id);
      return structuredClone(snapshot);
    },
    beginHostOperation: () => {
      held++;
      return {
        release: () => {
          held--;
        },
      };
    },
    dispatchHostTool: async (_expected, launch) => {
      if (rejectDispatch)
        throw new Error("Target execution permissions changed before dispatch");
      return { result: launch() };
    },
  };
  const service = new BoardToolService(app, tools);
  return {
    app,
    service,
    tools,
    trace,
    calls,
    snapshot,
    listeners,
    emit: (event: AppServerEvent) => {
      for (const listener of listeners) listener(event);
    },
    held: () => held,
    fail: () => {
      fail = true;
    },
    rejectDispatch: () => {
      rejectDispatch = true;
    },
  };
}
const shellRequest = {
  threadId: owner.threadId,
  tool: "shell" as const,
  arguments: { command: "synthetic script" },
};

for (const stage of ["readThread", "admit"] as const)
  test(`Room ownership is rechecked after a paused child ${stage}, before Shell dispatch`, async () => {
    const main = hostFixture();
    const child = toolFixture();
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let resume!: () => void;
    const paused = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const gate = async () => {
      entered();
      await paused;
    };
    let checks = 0;
    let requestOwner: unknown;
    if (stage === "admit") {
      const admit = child.tools.admit.bind(child.tools);
      child.tools.admit = async (...args) => {
        await gate();
        return await admit(...args);
      };
    }
    const bridge = new BoardHostService({
      ...main.host.options,
      executeTool: async (request, signal, assertOwner) => {
        requestOwner = request.owner;
        return await new BoardToolService(
          {
            ...child.app,
            readThread: async (id) => {
              if (stage === "readThread") await gate();
              return await child.app.readThread(id);
            },
          },
          child.tools,
          async () => {
            checks++;
            assertOwner();
          },
        ).execute(request, signal);
      },
    });
    const roomOwner = {
      kind: "room" as const,
      roomId: "room",
      threadId: owner.threadId,
    };
    try {
      const action = bridge.execute(
        roomOwner,
        { tool: "shell", arguments: shellRequest.arguments },
        signal(),
      );
      await waiting;
      main.rooms[0]!.members = [];
      resume();
      await assert.rejects(action, /exact Room member/);
      assert.deepEqual(
        requestOwner,
        roomOwner,
        "transport retains exact Room identity",
      );
      assert.equal(
        checks,
        1,
        "late check is independent of publication/cancellation delivery",
      );
      assert.equal(child.calls.length, 0);
      assert.equal(child.held(), 0);
    } finally {
      resume();
      await child.tools.close();
    }
  });

test("Room publication revokes the same pending request before the native dispatch callback", async () => {
  const main = hostFixture();
  const child = toolFixture();
  const listeners = new Set<() => void>();
  let entered!: () => void;
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let resume!: () => void;
  const paused = new Promise<void>((resolve) => {
    resume = resolve;
  });
  let liveSignal: AbortSignal | undefined;
  const bridge = new BoardHostService({
    ...main.host.options,
    rooms: {
      ...main.host.options.rooms,
      onChange: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
    executeTool: async (request, signal, assertOwner) => {
      liveSignal = signal;
      return await new BoardToolService(
        {
          ...child.app,
          dispatchHostTool: async (thread, launch) => {
            entered();
            await paused;
            return await child.app.dispatchHostTool(thread, launch);
          },
        },
        child.tools,
        async () => {
          assertOwner();
        },
      ).execute(request, signal);
    },
  });
  try {
    const action = bridge.execute(
      { kind: "room", roomId: "room", threadId: owner.threadId },
      { tool: "shell", arguments: shellRequest.arguments },
      signal(),
    );
    await waiting;
    assert.equal(listeners.size, 1);
    main.rooms[0]!.members = [];
    for (const listener of listeners) listener();
    assert.equal(liveSignal?.aborted, true);
    resume();
    await assert.rejects(action, /exact Room member/);
    assert.equal(child.calls.length, 0);
    assert.equal(
      listeners.size,
      0,
      "ephemeral publication subscription released",
    );
  } finally {
    resume();
    await child.tools.close();
  }
});

test("Board Shell uses normal ToolEnvironment capture, owner policy and no semantic Items", async () => {
  const f = toolFixture();
  try {
    const result = await f.service.execute(shellRequest, signal());
    assert.equal(result.exitCode, 0);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0]!.threadId, owner.threadId);
    assert.equal(f.calls[0]!.sandbox, "danger-full-access");
    assert.equal(f.calls[0]!.outputAudience, "program");
    assert.deepEqual(f.snapshot.items, []);
    assert.deepEqual(f.snapshot.turns, []);
    const observation = await f.trace.read(owner.threadId);
    assert.ok(
      observation.records.some(
        (record) => record.type === "tool_invocation_observed",
      ),
    );
    assert.ok(
      observation.records.some(
        (record) => record.type === "tool_result_observed",
      ),
    );
    assert.equal(f.held(), 0);
  } finally {
    await f.tools.close();
  }
});

for (const [label, configure] of [
  ["remembered denial", () => toolFixture("never", "denied")],
  ["approval required", () => toolFixture("always")],
  [
    "sandbox escalation required",
    () => {
      const f = toolFixture();
      f.snapshot.sandbox = "read-only";
      return f;
    },
  ],
  [
    "archived owner",
    () => {
      const f = toolFixture();
      f.snapshot.archived = true;
      return f;
    },
  ],
  [
    "native permission fence",
    () => {
      const f = toolFixture();
      f.rejectDispatch();
      return f;
    },
  ],
] as const)
  test(`Board Shell fails closed for ${label}`, async () => {
    const f = configure();
    try {
      await assert.rejects(f.service.execute(shellRequest, signal()));
      assert.equal(f.calls.length, 0);
      assert.equal(f.held(), 0);
    } finally {
      await f.tools.close();
    }
  });

test("Board abort before admission cannot execute; malformed IPC cannot dispatch", async () => {
  const f = toolFixture();
  try {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(f.service.execute(shellRequest, controller.signal));
    assert.equal(f.calls.length, 0);
    for (const event of [
      { type: "board-tool/result", requestId: "a" },
      {
        type: "board-tool/result",
        requestId: "a",
        result: { output: "ok", exitCode: 0 },
        error: "contradictory failure",
      },
      {
        type: "board-tool/result",
        requestId: "a",
        result: { output: "ok", exitCode: NaN },
      },
    ])
      assert.equal(isHostEvent(event), false);
    assert.equal(
      isHostCommand({
        type: "board-tool/request",
        requestId: "a",
        input: shellRequest,
      }),
      true,
    );
    assert.equal(
      isHostCommand({
        type: "board-tool/request",
        requestId: "a",
        input: { ...shellRequest, tool: "zenx_threads_send" },
      }),
      false,
    );
    assert.equal(
      isHostEvent({
        type: "board-tool/result",
        requestId: "a",
        result: { output: "ok", exitCode: 0 },
      }),
      true,
    );
    assert.equal(
      isHostEvent({
        type: "board-tool/result",
        requestId: "a",
        result: { output: "ok", exitCode: "yes" },
      }),
      false,
    );
  } finally {
    await f.tools.close();
  }
});

async function roomFixture(observe?: () => Promise<void>) {
  let saved: TriggerSnapshot = { triggers: [], rooms: [], history: [] };
  const requests: any[] = [];
  let error: Error | undefined;
  const manager: ZenXTriggerAppServerPort = {
    async request(method: any, params: any): Promise<any> {
      if (method === "zen/thread/resume")
        throw new Error("No recovery fixture");
      requests.push(params);
      if (error) throw error;
      return { mode: "start", turnId: `turn-${requests.length}` };
    },
    onNotification: () => () => {},
  };
  const service = new ZenXTriggerService(
    manager,
    {
      read: async () => saved,
      write: async (snapshot) => {
        saved = canonicalTriggerSnapshot(snapshot);
      },
    },
    observe ? { titles: { observe } } : {},
  );
  await service.start();
  const room = await service.createRoom({
    name: "Synthetic Room",
    members: [
      { name: "One", threadId: "one" },
      { name: "Two", threadId: "two" },
    ],
  });
  for (const [threadId, name] of [
    ["one", "One"],
    ["two", "Two"],
  ])
    await service.create({
      kind: "roomMention",
      threadId: threadId!,
      mention: name!,
      roomId: room.id,
      label: name!,
      prompt: "Synthetic",
      deliveryMode: "queue",
    });
  return {
    service,
    room,
    requests,
    saved: () => saved,
    fail: () => {
      error = new Error("Disconnected after native admission");
    },
  };
}

test("addressed Board Room message keeps literal mentions but admits only exact selected member", async () => {
  const f = await roomFixture();
  try {
    const id = `${f.room.operationEpoch}:${randomUUID()}`;
    const receipt = await f.service.postAddressedRoomMessage(
      f.room.id,
      "one",
      id,
      "literal @Two should not select another recipient",
    );
    assert.equal(receipt.state, "saved");
    assert.equal(receipt.mentions.length, 1);
    assert.equal(receipt.mentions[0]!.threadId, "one");
    assert.equal(receipt.mentions[0]!.deliveries[0]!.status, "running");
    assert.equal(f.requests.length, 1);
    assert.equal(f.requests[0]!.threadId, "one");
    assert.equal(
      f.requests[0]!.mode,
      undefined,
      "native default start/steer, never Room queue preference",
    );
    assert.equal(f.saved().rooms[0]!.operations![0]!.recipientThreadId, "one");
    assert.equal(
      f.saved().rooms[0]!.messages[0]!.text,
      "literal @Two should not select another recipient",
    );
    await f.service.postAddressedRoomMessage(
      f.room.id,
      "one",
      id,
      "literal @Two should not select another recipient",
    );
    assert.equal(
      f.requests.length,
      1,
      "existing Room receipt is observed, not replayed",
    );
    await assert.rejects(
      f.service.postAddressedRoomMessage(
        f.room.id,
        "two",
        id,
        "literal @Two should not select another recipient",
      ),
      /different message/,
    );
  } finally {
    await f.service.stop();
  }
});

test("Room saved receipt does not claim accepted/completed on unknown native outcome", async () => {
  const f = await roomFixture();
  try {
    f.fail();
    const id = `${f.room.operationEpoch}:${randomUUID()}`;
    const receipt = await f.service.postAddressedRoomMessage(
      f.room.id,
      "one",
      id,
      "test",
    );
    assert.equal(receipt.state, "saved");
    assert.ok(
      ["unknown", "failed"].includes(
        receipt.mentions[0]!.deliveries[0]!.status,
      ),
    );
    assert.equal(f.requests.length, 1);
    await f.service.postAddressedRoomMessage(f.room.id, "one", id, "test");
    assert.equal(f.requests.length, 1);
  } finally {
    await f.service.stop();
  }
});

test("Room removed or unconfigured members cannot receive Board messages", async () => {
  const f = await roomFixture();
  try {
    await f.service.removeRoomMember(f.room.id, "one");
    await assert.rejects(
      f.service.postAddressedRoomMessage(
        f.room.id,
        "one",
        `${f.room.operationEpoch}:${randomUUID()}`,
        "test",
      ),
      /exact live member/,
    );
    f.service.suspendWakeups();
    await assert.rejects(
      f.service.postAddressedRoomMessage(
        f.room.id,
        "two",
        `${f.room.operationEpoch}:${randomUUID()}`,
        "test",
      ),
      /exact live member/,
    );
    assert.equal(f.requests.length, 0);
    assert.equal(f.saved().rooms[0]!.messages.length, 0);
  } finally {
    await f.service.stop();
  }
});

test(
  "real child Host keeps script execution separate and awaits a slow conditional submit",
  { timeout: 20_000 },
  async () => {
    const { mkdtemp, readFile, rm } = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const { AppServerManager } =
      await import("../src/main/app-server-manager.js");
    const { FileTraceStore } = await import("../../../src/trace.js");
    const directory = await mkdtemp(path.join(os.tmpdir(), "zenx-board-host-"));
    const marker = path.join(directory, "synthetic.txt");
    const manager = new AppServerManager({
      entryPath: fileURLToPath(
        new URL("../src/main/app-server-host.ts", import.meta.url),
      ),
      tokenFile: path.join(directory, "runtime", "token"),
      hostConfig: {
        cwd: directory,
        dataDirectory: path.join(directory, "data"),
        model: "fake",
        models: ["fake"],
        approvalPolicy: "never",
        provider: { type: "fake" },
        toolPresentation: "direct",
      },
      execArgv: ["--import", "tsx"],
      startupTimeoutMs: 10_000,
      configurationControlTimeoutMs: 1_000,
    });
    try {
      await manager.start();
      const { thread } = await manager.request("thread/start", {});
      const before = await manager.request("zen/thread/read", {
        threadId: thread.id,
      });
      const script = `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'SYNTHETIC_BOARD_OK')`;
      const result = await manager.boardToolRequest(
        {
          threadId: thread.id,
          tool: "shell",
          arguments: {
            command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`,
          },
        },
        signal(),
      );
      assert.equal(result.exitCode, 0);
      assert.equal(await readFile(marker, "utf8"), "SYNTHETIC_BOARD_OK");
      const after = await manager.request("zen/thread/read", {
        threadId: thread.id,
      });
      assert.deepEqual(after.thread.items, before.thread.items);
      assert.deepEqual(after.thread.turns, []);
      const observed = await new FileTraceStore(
        path.join(directory, "data", "trace"),
      ).read(thread.id);
      assert.ok(
        observed.records.some(
          (record) => record.type === "tool_invocation_observed",
        ),
      );
      assert.ok(
        observed.records.some(
          (record) => record.type === "tool_result_observed",
        ),
      );

      const roomRequest = {
        threadId: thread.id,
        owner: {
          kind: "room" as const,
          roomId: "synthetic-room",
          threadId: thread.id,
        },
        tool: "shell" as const,
        arguments: {
          command: `${JSON.stringify(process.execPath)} -e "console.log('ROOM_CHECKED')"`,
        },
      };
      await assert.rejects(
        manager.boardToolRequest(roomRequest, signal()),
        /cannot be revalidated/,
      );
      let ownerChecks = 0;
      await assert.rejects(
        manager.boardToolRequest(roomRequest, signal(), () => {
          ownerChecks++;
          throw new Error(
            "Synthetic Room member removed during child preparation",
          );
        }),
        /member removed/,
      );
      assert.equal(
        ownerChecks,
        1,
        "real child invokes the exact bound late validator once",
      );
      const checked = await manager.boardToolRequest(
        roomRequest,
        signal(),
        () => {
          ownerChecks++;
        },
      );
      assert.equal(ownerChecks, 2);
      assert.match(checked.output, /ROOM_CHECKED/);

      for (const change of ["permission", "archive"] as const) {
        const startedPath = path.join(directory, `synthetic-${change}-started`);
        const runningScript = `require('node:fs').writeFileSync(${JSON.stringify(startedPath)}, 'started'); setInterval(() => {}, 1000)`;
        const running = manager.boardToolRequest(
          {
            threadId: thread.id,
            tool: "shell",
            arguments: {
              command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(runningScript)}`,
              timeout_ms: 5000,
            },
          },
          signal(),
        );
        // Observe this synthetic process actually starting before revoking it.
        const deadline = Date.now() + 4000;
        while (true) {
          try {
            if ((await readFile(startedPath, "utf8")) === "started") break;
          } catch (error) {
            if (!(
              error instanceof Error &&
              "code" in error &&
              error.code === "ENOENT"
            ))
              throw error;
          }
          if (Date.now() >= deadline)
            throw new Error("Synthetic Board script did not start");
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        if (change === "permission")
          await manager.request("thread/permissions/update", {
            threadId: thread.id,
            sandbox: "read-only",
          });
        else await manager.request("thread/archive", { threadId: thread.id });
        const cancelled = await running;
        assert.equal(
          (cancelled.structuredContent as any).status,
          "cancelled",
          `native ${change} cancellation settles`,
        );
        assert.equal(cancelled.exitCode, 130);
        if (change === "permission") {
          const { localErrorDetail } =
            await import("../src/local-error-detail.js");
          await assert.rejects(
            manager.boardToolRequest(
              {
                threadId: thread.id,
                tool: "shell",
                arguments: { command: 42 },
              },
              signal(),
            ),
            (error: unknown) => {
              assert.match(localErrorDetail(error), /BoardToolService/);
              return true;
            },
          );
          await manager.request("thread/permissions/update", {
            threadId: thread.id,
            sandbox: "danger-full-access",
          });
        } else
          await manager.request("thread/unarchive", { threadId: thread.id });
      }

      const { ZenXBoardCapabilityPackage } =
        await import("../src/main/capabilities/board-package.js");
      const { createFixturePluginHost } = await import("@zenx/plugin-sdk");
      const boardOwner = { kind: "thread" as const, threadId: thread.id };
      const board = new ZenXBoardCapabilityPackage(
        new BoardHostService({
          appServer: manager,
          readThreadSummary: async (threadId) =>
            (await manager.listThreadSummaries()).find(
              (entry) => entry.threadId === threadId,
            ),
          rooms: {
            roomsAvailable: () => false,
            snapshot: () => ({ rooms: [] }),
            postAddressedRoomMessage: async () => assert.fail("No Room send"),
          },
          executeTool: (input, signal) =>
            manager.boardToolRequest(input, signal),
        }),
      );
      board.start(createFixturePluginHost({ pluginId: "zenx-board" }).sdk);
      const slow = "setTimeout(() => console.log('SLOW_CONFIRMED'), 2200)";
      const invoke = (
        name: string,
        args: Record<string, unknown>,
        ui = false,
      ) =>
        board.invoke(name, {
          name,
          callId: randomUUID(),
          cwd: directory,
          threadId: thread.id,
          arguments: ui ? { input: args } : args,
          signal: signal(),
          ...(ui ? { trustedPluginUi: true as const } : {}),
        });
      await invoke("zenx_board_put", {
        document: {
          id: "slow-check",
          owner: boardOwner,
          title: "Synthetic slow script",
          summary: "Submit only after confirmed script completion",
          blocks: [],
          events: [
            {
              id: "check",
              label: "Check and share",
              actions: [
                {
                  kind: "script",
                  command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(slow)}`,
                  timeoutMs: 6000,
                },
                {
                  kind: "if",
                  field: "result.exitCode",
                  equals: 0,
                  then: [
                    { kind: "submit", text: "Checked: {{result.output}}" },
                  ],
                },
              ],
            },
          ],
        },
      });
      const started = Date.now();
      const combined = (await invoke(
        "zenx_board_ui",
        {
          operation: "event",
          owner: boardOwner,
          eventId: "check",
          revision: 1,
          draftRevision: 0,
        },
        true,
      )) as import("../../../packages/zenx-board-plugin/src/board.js").BoardEventResult;
      assert.ok(
        Date.now() - started >= 2000,
        "waits through the actual script, not 1s yield",
      );
      assert.equal(combined.error, undefined);
      assert.deepEqual(
        combined.outcomes.map((outcome) => outcome.kind),
        ["script", "submit"],
      );
      assert.match(
        (combined.outcomes[0]!.result as { output: string }).output,
        /SLOW_CONFIRMED/,
      );
      assert.equal(
        (combined.outcomes[1]!.result as { admission: string }).admission,
        "accepted",
      );
      const delivered = await manager.request("zen/thread/read", {
        threadId: thread.id,
      });
      assert.equal(
        delivered.thread.turns.length,
        1,
        "only explicit submit admits a model Turn",
      );
    } finally {
      await manager.stop();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test("addressed Room delivery revalidates live membership after asynchronous preparation", async () => {
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = await roomFixture(async () => {
    entered();
    await waiting;
  });
  try {
    const sending = f.service.postAddressedRoomMessage(
      f.room.id,
      "one",
      `${f.room.operationEpoch}:${randomUUID()}`,
      "assembled text",
    );
    await started;
    await f.service.removeRoomMember(f.room.id, "one");
    release();
    const result = await sending;
    assert.equal(
      f.requests.length,
      0,
      "removed member never reaches native admission",
    );
    assert.equal(
      result.state,
      "saved",
      "saved product message does not disappear",
    );
    assert.notEqual(result.mentions[0]!.deliveries[0]!.status, "running");
  } finally {
    release();
    await f.service.stop();
  }
});

test("ambiguous Room configuration cannot silently substitute a Board recipient", async () => {
  const f = await roomFixture();
  try {
    await f.service.create({
      kind: "roomMention",
      threadId: "one",
      mention: "One",
      roomId: f.room.id,
      label: "Duplicate",
      prompt: "Different trigger",
    });
    await assert.rejects(
      f.service.postAddressedRoomMessage(
        f.room.id,
        "one",
        `${f.room.operationEpoch}:${randomUUID()}`,
        "test",
      ),
      /one enabled direct message recipient/,
    );
    assert.equal(f.requests.length, 0);
    assert.equal(f.saved().rooms[0]!.messages.length, 0);
  } finally {
    await f.service.stop();
  }
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("Board waits through ordinary task yields and dispatches a script exactly once", async () => {
  const started = deferred<void>();
  const finish = deferred<void>();
  const f = toolFixture("never", undefined, async (invocation) => {
    invocation.taskContext?.onOutput("before\n");
    invocation.taskContext?.requestYield?.();
    started.resolve();
    await finish.promise;
    return { output: "actual terminal output", exitCode: 7 };
  });
  let resolved = false;
  try {
    const work = f.service.execute(shellRequest, signal()).then((result) => {
      resolved = true;
      return result;
    });
    await started.promise;
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(resolved, false, "a task yield is not script completion");
    assert.equal(f.calls.length, 1);
    assert.equal(f.held(), 1);
    finish.resolve();
    const result = await work;
    assert.equal(result.exitCode, 7);
    assert.equal(result.contentType, undefined);
    assert.match(result.output, /actual terminal output/);
    assert.equal(f.calls.length, 1);
    assert.equal(f.tools.taskManager.activeTaskCount, 0);
    assert.equal(f.listeners.size, 0);
  } finally {
    finish.resolve();
    await f.tools.close();
  }
});

for (const change of ["permission", "archive", "delete"] as const)
  test(`committed Thread ${change} cancels the same running Board task`, async () => {
    const started = deferred<ToolInvocation>();
    const f = toolFixture("never", undefined, async (invocation) => {
      started.resolve(invocation);
      await new Promise<void>((resolve) => {
        invocation.signal.addEventListener("abort", () => resolve(), {
          once: true,
        });
      });
      return { output: "native cancellation settled", exitCode: 130 };
    });
    try {
      const work = f.service.execute(shellRequest, signal());
      const invocation = await started.promise;
      f.emit({
        type: "thread_archived_updated",
        threadId: "other",
        archived: true,
      });
      f.emit({
        type: "thread_settings_updated",
        threadId: owner.threadId,
        settings: { ...f.snapshot, model: "a different model" } as any,
      });
      assert.equal(
        invocation.signal.aborted,
        false,
        "unrelated changes do not cancel",
      );
      if (change === "permission")
        f.emit({
          type: "thread_settings_updated",
          threadId: owner.threadId,
          settings: {
            ...f.snapshot,
            sandbox: "read-only",
            approvalPolicy: "always",
          } as any,
        });
      else if (change === "archive")
        f.emit({
          type: "thread_archived_updated",
          threadId: owner.threadId,
          archived: true,
        });
      else
        f.emit({
          type: "thread_deleted_updated",
          threadId: owner.threadId,
          deleted: true,
        });
      assert.equal(invocation.signal.aborted, true);
      const result = await work;
      assert.equal((result.structuredContent as any).status, "cancelled");
      assert.equal(result.exitCode, 130);
      assert.equal(f.calls.length, 1);
      assert.equal(f.listeners.size, 0);
      assert.equal(f.held(), 0);
      assert.deepEqual(f.snapshot.items, []);
    } finally {
      await f.tools.close();
    }
  });

test("a committed archive during Board admission cancels before native dispatch", async () => {
  const f = toolFixture();
  const entered = deferred<void>();
  const release = deferred<void>();
  const admit = f.tools.admit.bind(f.tools);
  f.tools.admit = async (...args) => {
    entered.resolve();
    await release.promise;
    return await admit(...args);
  };
  try {
    const work = f.service.execute(shellRequest, signal());
    await entered.promise;
    f.emit({
      type: "thread_archived_updated",
      threadId: owner.threadId,
      archived: true,
    });
    release.resolve();
    await assert.rejects(work, /ownership or execution permissions changed/);
    assert.equal(f.calls.length, 0);
    assert.equal(f.listeners.size, 0);
    assert.equal(f.held(), 0);
  } finally {
    release.resolve();
    await f.tools.close();
  }
});

test("Board deadline reports confirmed timeout without replaying the script", async () => {
  const f = toolFixture("never", undefined, async (invocation) => {
    await new Promise<void>((resolve) => {
      invocation.signal.addEventListener("abort", () => resolve(), {
        once: true,
      });
    });
    return { output: "native timeout settled", exitCode: 124 };
  });
  try {
    // The task timeout timer is intentionally unref'ed in production.
    const keeper = setTimeout(() => {}, 500);
    try {
      const result = await f.service.execute(
        {
          ...shellRequest,
          arguments: { command: "synthetic timeout", timeout_ms: 10 },
        },
        signal(),
      );
      assert.equal((result.structuredContent as any).status, "timed_out");
      assert.equal(result.exitCode, 124);
      assert.equal(f.calls.length, 1);
      assert.equal(f.tools.taskManager.activeTaskCount, 0);
      assert.equal(f.listeners.size, 0);
    } finally {
      clearTimeout(keeper);
    }
  } finally {
    await f.tools.close();
  }
});

test("unconfirmed Board cancellation retains the existing task and never claims success", async () => {
  const started = deferred<void>();
  const finish = deferred<void>();
  const controller = new AbortController();
  const f = toolFixture(
    "never",
    undefined,
    async () => {
      started.resolve();
      await finish.promise;
      return { output: "late native completion", exitCode: 0 };
    },
    "unconfirmed",
  );
  try {
    const work = f.service.execute(shellRequest, controller.signal);
    await started.promise;
    controller.abort();
    const result = await work;
    assert.equal(
      (result.structuredContent as any).status,
      "cancellation_unconfirmed",
    );
    assert.equal((result.structuredContent as any).exit_code, null);
    assert.equal(f.tools.taskManager.activeTaskCount, 1);
    assert.equal(f.calls.length, 1);
    assert.equal(f.listeners.size, 0);
    finish.resolve();
    const terminal = await f.tools.taskManager.wait({
      callId: "synthetic-wait",
      name: "wait",
      threadId: owner.threadId,
      cwd: "/tmp",
      signal: signal(),
      arguments: {
        task_id: (result.structuredContent as any).task_id,
        yield_time_ms: 100,
      },
    });
    assert.equal((terminal.structuredContent as any).status, "completed");
    assert.equal(
      f.calls.length,
      1,
      "observing the retained task never dispatches again",
    );
  } finally {
    finish.resolve();
    await f.tools.close();
  }
});

test("Board Host error details are optional local failure data, not result authority", () => {
  const failure = {
    type: "board-tool/result",
    requestId: "synthetic",
    error: "failed",
  };
  assert.equal(isHostEvent(failure), true);
  assert.equal(
    isHostEvent({ ...failure, errorDetail: "synthetic stack and cause" }),
    true,
  );
  assert.equal(
    isHostEvent({ ...failure, errorDetail: { invalid: true } }),
    false,
  );
  assert.equal(
    isHostEvent({
      type: "board-tool/result",
      requestId: "synthetic",
      result: { output: "ok", exitCode: 0 },
      errorDetail: "contradictory failure detail",
    }),
    false,
  );
});

test("capability result carries only validated existing Browser sidebar metadata", () => {
  const result = {
    type: "capability/result",
    invocationId: "synthetic-invocation",
    generationToken: "synthetic-generation",
    output: "authored document",
    exitCode: 0,
  };
  const route = {
    ownerThreadId: "synthetic-owner",
    sessionId: "synthetic-session",
    sessionEpoch: "synthetic-epoch",
    tabId: "synthetic-tab",
    targetId: "synthetic-target",
  };
  assert.equal(
    isHostCommand({ ...result, browserSidebarTargets: [route] }),
    true,
  );
  assert.equal(
    isHostCommand({
      ...result,
      browserSidebarTargets: [{ ...route, targetId: undefined }],
    }),
    false,
  );
  assert.equal(
    isHostCommand({
      ...result,
      browserSidebarTargets: Array.from({ length: 65 }, () => route),
    }),
    false,
  );
});
