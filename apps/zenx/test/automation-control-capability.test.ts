import assert from "node:assert/strict";
import test from "node:test";

import type { ToolInvocation } from "../../../src/tool.js";
import {
  ZENX_AUTOMATION_READ_PERMISSION,
  ZENX_AUTOMATION_WRITE_PERMISSION,
  ZenXAutomationControlCapabilityPackage,
  type ZenXAutomationControlPort,
} from "../src/main/capabilities/automation-control-package.js";
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
  snapshot(): TriggerSnapshot {
    return { triggers: [], history: [], rooms: [] };
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
