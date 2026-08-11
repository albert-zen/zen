import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import type { ToolInvocation } from "../../../src/tool.js";
import {
  ZENX_AUTOMATION_READ_PERMISSION,
  ZENX_AUTOMATION_WRITE_PERMISSION,
  ZENX_AUTOMATION_CONTROL_CAPABILITY_ID,
  ZenXAutomationControlCapabilityPackage,
  type ZenXAutomationControlPort,
} from "../src/main/capabilities/automation-control-package.js";
import { MemoryZenXCapabilityGrantStore } from "../src/main/capabilities/grant-store.js";
import { ZenXCapabilityRegistry } from "../src/main/capabilities/registry.js";
import { AppServerManager } from "../src/main/app-server-manager.js";
import type {
  CreateRoomInput,
  CreateTriggerInput,
  RoomMember,
  TriggerSnapshot,
  UpdateTriggerInput,
  ZenXRoom,
  ZenXTrigger,
} from "../src/main/trigger-types.js";

test("automation capability exposes separately granted read and mutation tools", () => {
  const capability = new ZenXAutomationControlCapabilityPackage(new FakePort());
  const list = capability.manifest.tools.find(
    (tool) => tool.name === "zenx_triggers_list",
  );
  const create = capability.manifest.tools.find(
    (tool) => tool.name === "zenx_triggers_create",
  );
  assert.deepEqual(list?.permissions, [ZENX_AUTOMATION_READ_PERMISSION]);
  assert.deepEqual(create?.permissions, [ZENX_AUTOMATION_WRITE_PERMISSION]);
  assert.equal(
    capability.manifest.provider.interactionModes[0],
    "background_safe",
  );
});

test("automation capability routes Trigger CRUD and Room management", async () => {
  const port = new FakePort();
  const capability = new ZenXAutomationControlCapabilityPackage(port);
  const trigger = await invoke(capability, "zenx_triggers_create", {
    threadId: "target",
    kind: "signal",
    label: "Deploy",
    prompt: "Check deploy",
    signalName: "deploy",
  });
  assert.equal((trigger as { signalName: string }).signalName, "deploy");
  await invoke(capability, "zenx_triggers_update", {
    id: "trigger-1",
    threadId: "target",
    kind: "thread",
    label: "Review",
    prompt: "Review it",
    watchedThreadId: "source",
  });
  await invoke(capability, "zenx_triggers_cancel", { triggerId: "trigger-1" });
  await invoke(capability, "zenx_triggers_delete", { triggerId: "trigger-1" });
  await invoke(capability, "zenx_rooms_create", {
    name: "release",
    members: [{ name: "Reviewer", threadId: "target" }],
  });
  await invoke(capability, "zenx_rooms_post_message", {
    roomId: "room-1",
    text: "Ready",
  });
  assert.deepEqual(
    port.calls.map((call) => call[0]),
    [
      "create",
      "update",
      "cancel",
      "delete",
      "createRoom",
      "postAgentRoomMessage",
    ],
  );
});

test("automation history listing returns the newest bounded entries", async () => {
  const history = Array.from({ length: 75 }, (_, index) => ({
    id: `history-${index}`,
    triggerId: "trigger-1",
    threadId: "thread-1",
    kind: "signal" as const,
    reason: `reason-${index}`,
    prompt: "Inspect it",
    clientUserMessageId: `wakeup-${index}`,
    startedAt: index,
    completedAt: index + 1,
    status: "completed" as const,
    turnId: `turn-${index}`,
    error: null,
    sourceThreadId: null,
    sourceTurnId: null,
    sourceRoomId: null,
    sourceRoomMessageId: null,
    replyRoomId: null,
    replyAuthor: null,
  }));
  const capability = new ZenXAutomationControlCapabilityPackage(
    new FakePort({ triggers: [], history, rooms: [] }),
  );

  const result = (await invoke(capability, "zenx_triggers_list", {})) as {
    history: Array<{ id: string }>;
  };
  assert.equal(result.history.length, 50);
  assert.equal(result.history[0]?.id, "history-0");
  assert.equal(result.history.at(-1)?.id, "history-49");
});

test("granted automation tools are exposed to and executable through the hosted App Server", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-automation-host-"),
  );
  const port = new FakePort();
  const capability = new ZenXAutomationControlCapabilityPackage(port);
  const registry = new ZenXCapabilityRegistry(
    new MemoryZenXCapabilityGrantStore(),
  );
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
    },
    execArgv: ["--import", "tsx"],
    startupTimeoutMs: 10_000,
    capabilityHost: registry,
  });
  try {
    await registry.initialize();
    registry.register(capability);
    assert.deepEqual(registry.hostSnapshot().definitions, []);
    await registry.grant(ZENX_AUTOMATION_CONTROL_CAPABILITY_ID, [
      ZENX_AUTOMATION_READ_PERMISSION,
      ZENX_AUTOMATION_WRITE_PERMISSION,
    ]);
    const exposed = registry
      .hostSnapshot()
      .definitions.map((definition) => definition.name);
    assert.deepEqual(exposed, [
      "zenx_triggers_list",
      "zenx_triggers_create",
      "zenx_triggers_update",
      "zenx_triggers_cancel",
      "zenx_triggers_delete",
      "zenx_rooms_list",
      "zenx_rooms_create",
      "zenx_rooms_rename",
      "zenx_rooms_delete",
      "zenx_rooms_add_member",
      "zenx_rooms_remove_member",
      "zenx_rooms_post_message",
    ]);

    for (const [name, args] of [
      ["zenx_rooms_list", {}],
      [
        "zenx_rooms_create",
        { name: "release", members: [{ name: "Bot", threadId: "thread-1" }] },
      ],
      ["zenx_rooms_rename", { roomId: "room-1", name: "ship" }],
      ["zenx_rooms_delete", { roomId: "room-1" }],
      [
        "zenx_rooms_add_member",
        { roomId: "room-1", name: "Reviewer", threadId: "thread-2" },
      ],
      ["zenx_rooms_remove_member", { roomId: "room-1", threadId: "thread-2" }],
      ["zenx_rooms_post_message", { roomId: "room-1", text: "Ready" }],
    ] as const) {
      const result = await registry.execute({
        name,
        arguments: args,
        cwd: directory,
        signal: new AbortController().signal,
        callId: `call-${name}`,
      });
      assert.equal(result.exitCode, 0);
    }

    port.calls.length = 0;
    const completed = deferred<void>();
    manager.onNotification((method) => {
      if (method === "turn/completed") completed.resolve();
    });
    await manager.start();
    const started = await manager.request("thread/start", {});
    await manager.request("turn/start", {
      threadId: started.thread.id,
      input: [{ type: "text", text: "!tool zenx_rooms_list {}" }],
    });
    await within(completed.promise);
    assert(
      port.calls.some(([name]) => name === "snapshot"),
      "the hosted App Server must execute the exposed Room list tool",
    );
  } finally {
    await manager.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

async function invoke(
  capability: ZenXAutomationControlCapabilityPackage,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const invocation: ToolInvocation = {
    name,
    arguments: args,
    cwd: "/workspace",
    signal: new AbortController().signal,
    callId: `call-${name}`,
  };
  return await capability.invoke(name, invocation);
}

class FakePort implements ZenXAutomationControlPort {
  readonly calls: Array<[string, unknown]> = [];
  readonly #state: TriggerSnapshot;

  constructor(
    state: TriggerSnapshot = { triggers: [], history: [], rooms: [] },
  ) {
    this.#state = structuredClone(state);
  }

  snapshot(): TriggerSnapshot {
    this.calls.push(["snapshot", null]);
    return structuredClone(this.#state);
  }
  async create(input: CreateTriggerInput): Promise<ZenXTrigger> {
    this.calls.push(["create", input]);
    return { id: "trigger-1", createdAt: 1, active: true, ...input };
  }
  async update(input: UpdateTriggerInput): Promise<ZenXTrigger> {
    this.calls.push(["update", input]);
    return { createdAt: 1, active: true, ...input };
  }
  async cancel(id: string): Promise<void> {
    this.calls.push(["cancel", id]);
  }
  async delete(id: string): Promise<void> {
    this.calls.push(["delete", id]);
  }
  async createRoom(input: CreateRoomInput): Promise<ZenXRoom> {
    this.calls.push(["createRoom", input]);
    return { id: "room-1", createdAt: 1, messages: [], ...input };
  }
  async renameRoom(id: string, name: string): Promise<void> {
    this.calls.push(["renameRoom", { id, name }]);
  }
  async deleteRoom(id: string): Promise<void> {
    this.calls.push(["deleteRoom", id]);
  }
  async addRoomMember(id: string, member: RoomMember): Promise<void> {
    this.calls.push(["addRoomMember", { id, member }]);
  }
  async removeRoomMember(id: string, threadId: string): Promise<void> {
    this.calls.push(["removeRoomMember", { id, threadId }]);
  }
  async postAgentRoomMessage(id: string, text: string): Promise<void> {
    this.calls.push(["postAgentRoomMessage", { id, text }]);
  }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function within<T>(
  promise: Promise<T>,
  milliseconds = 10_000,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(new Error("Timed out waiting for hosted automation tool")),
          milliseconds,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
