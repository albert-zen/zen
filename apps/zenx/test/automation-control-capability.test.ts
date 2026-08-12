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

test("read-only Trigger listing removes program environment and diagnostics", async () => {
  const capability = new ZenXAutomationControlCapabilityPackage(
    new SensitivePort(),
  );
  const listed = (await invoke(capability, "zenx_triggers_list", {})) as {
    triggers: Array<{
      program?: { action?: { env?: Record<string, string> } };
    }>;
    history: Array<{
      programOutcome: { output: string | null; error: string | null } | null;
      programOutcomes: Array<{ output: string | null; error: string | null }>;
    }>;
  };
  assert.equal(listed.triggers[0]?.program?.action?.env, undefined);
  assert.equal(listed.history[0]?.programOutcome?.output, null);
  assert.equal(listed.history[0]?.programOutcome?.error, null);
  assert.equal(listed.history[0]?.programOutcomes[0]?.output, null);
  assert.doesNotMatch(JSON.stringify(listed), /do-not-leak/u);
});

test("Agent automation inputs enforce bounded strings, members, and program env", async () => {
  const capability = new ZenXAutomationControlCapabilityPackage(new FakePort());
  await assert.rejects(
    invoke(capability, "zenx_triggers_create", {
      threadId: "target",
      kind: "signal",
      label: "bounded",
      prompt: "x".repeat(5_000),
      signalName: "signal",
    }),
    /non-empty string/u,
  );
  await assert.rejects(
    invoke(capability, "zenx_rooms_create", {
      name: "too-many",
      members: Array.from({ length: 65 }, (_, index) => ({
        name: `member-${String(index)}`,
        threadId: `thread-${String(index)}`,
      })),
    }),
    /1-64/u,
  );
  await assert.rejects(
    invoke(capability, "zenx_triggers_create", {
      threadId: "target",
      kind: "signal",
      label: "bounded",
      prompt: "prompt",
      signalName: "signal",
      program: {
        action: {
          command: "fixture",
          env: Object.fromEntries(
            Array.from({ length: 65 }, (_, index) => [
              `KEY_${String(index)}`,
              "value",
            ]),
          ),
        },
      },
    }),
    /too many entries/u,
  );
  await assert.rejects(
    invoke(capability, "zenx_triggers_create", {
      threadId: "target",
      kind: "signal",
      label: "bounded",
      prompt: "prompt",
      signalName: "signal",
      program: {
        action: { command: "fixture", timeoutMs: 120_001 },
      },
    }),
    /timeoutMs must be between/u,
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

class SensitivePort extends FakePort {
  override snapshot(): TriggerSnapshot {
    return {
      triggers: [
        {
          id: "trigger-sensitive",
          threadId: "target",
          kind: "signal",
          label: "Sensitive",
          prompt: "Inspect",
          signal: { name: "sensitive" },
          createdAt: 1,
          active: true,
          program: {
            action: {
              command: "fixture",
              env: { OPENAI_API_KEY: "do-not-leak" },
            },
          },
        },
      ],
      history: [
        {
          id: "history-sensitive",
          triggerId: "trigger-sensitive",
          threadId: "target",
          kind: "signal",
          reason: "reason",
          prompt: "Inspect",
          clientUserMessageId: "wakeup",
          startedAt: 1,
          completedAt: 2,
          status: "failed",
          turnId: null,
          error: "error",
          sourceThreadId: null,
          sourceTurnId: null,
          sourceRoomId: null,
          sourceRoomMessageId: null,
          replyRoomId: null,
          replyAuthor: null,
          programInvocationId: null,
          programOutcome: {
            stage: "action",
            invocationId: "invocation",
            status: "failed",
            output: "do-not-leak",
            exitCode: 1,
            error: "do-not-leak",
          },
          programOutcomes: [
            {
              stage: "action",
              invocationId: "invocation",
              status: "failed",
              output: "do-not-leak",
              exitCode: 1,
              error: "do-not-leak",
            },
          ],
        },
      ],
      rooms: [],
    };
  }
}
