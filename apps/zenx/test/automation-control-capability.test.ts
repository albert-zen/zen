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

test("automation tools have independent read and write grants", () => {
  const capability = new ZenXAutomationControlCapabilityPackage(new FakePort());
  assert.deepEqual(
    capability.manifest.tools.find((tool) => tool.name === "zenx_triggers_list")
      ?.permissions,
    [ZENX_AUTOMATION_READ_PERMISSION],
  );
  assert.deepEqual(
    capability.manifest.tools.find(
      (tool) => tool.name === "zenx_triggers_create",
    )?.permissions,
    [ZENX_AUTOMATION_WRITE_PERMISSION],
  );
  assert.deepEqual(
    capability.manifest.tools
      .filter((tool) => tool.name.startsWith("zenx_rooms"))
      .map((tool) => tool.name),
    [
      "zenx_rooms_list",
      "zenx_rooms_create",
      "zenx_rooms_rename",
      "zenx_rooms_delete",
      "zenx_rooms_add_member",
      "zenx_rooms_remove_member",
      "zenx_rooms_post_message",
    ],
  );
});

test("automation tools route Trigger CRUD and every Room operation", async () => {
  const port = new FakePort();
  const capability = new ZenXAutomationControlCapabilityPackage(port);
  await invoke(capability, "zenx_triggers_list", {});
  await invoke(capability, "zenx_triggers_create", {
    threadId: "target",
    kind: "signal",
    label: "Deploy",
    prompt: "Inspect deploy",
    signalName: "deploy",
    program: {
      match: { field: "completedItemText", regex: "deploy" },
    },
  });
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
  await invoke(capability, "zenx_rooms_list", {});
  await invoke(capability, "zenx_rooms_create", {
    name: "release",
    members: [{ name: "Reviewer", threadId: "target" }],
  });
  await invoke(capability, "zenx_rooms_rename", {
    roomId: "room-1",
    name: "ship",
  });
  await invoke(capability, "zenx_rooms_add_member", {
    roomId: "room-1",
    name: "Monitor",
    threadId: "monitor",
  });
  await invoke(capability, "zenx_rooms_remove_member", {
    roomId: "room-1",
    threadId: "monitor",
  });
  await invoke(capability, "zenx_rooms_post_message", {
    roomId: "room-1",
    text: "Ready",
  });
  await invoke(capability, "zenx_rooms_delete", { roomId: "room-1" });
  assert.deepEqual(
    port.calls.map((call) => call[0]),
    [
      "create",
      "update",
      "cancel",
      "delete",
      "createRoom",
      "renameRoom",
      "addRoomMember",
      "removeRoomMember",
      "postAgentRoomMessage",
      "deleteRoom",
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
    cwd: process.cwd(),
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
