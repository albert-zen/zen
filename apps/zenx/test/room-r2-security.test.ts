import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ToolEnvironment } from "../../../src/tool.js";
import {
  PluginRuntimeSupervisor,
  bundledPackageRegistration,
} from "../src/main/plugin-runtime.js";
import { createBundledAutomationPluginService } from "../src/main/automation-plugin-service.js";
import { createZenXTrustedPlugin } from "../../../packages/zenx-rooms-plugin/src/runtime.js";
import type { ZenXPluginManifestV2 } from "../src/main/capabilities/types.js";

const manifest = JSON.parse(
  await readFile(
    new URL(
      "../../../packages/zenx-rooms-plugin/zenx.plugin.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as ZenXPluginManifestV2;

async function fixture(
  run: (
    service: Awaited<ReturnType<typeof createBundledAutomationPluginService>>,
    dir: string,
  ) => Promise<void>,
) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "zen-room-r2-security-"));
  const service = await createBundledAutomationPluginService({
    userDataDirectory: dir,
    appServer: {
      request: async () => {
        throw Error("No wake expected");
      },
      onNotification: () => () => {},
    } as any,
  });
  try {
    await service.startPlugin("zenx-rooms", {} as any);
    await run(service, dir);
  } finally {
    await service.stopPlugin("zenx-rooms");
    await rm(dir, { recursive: true, force: true });
  }
}

test("real ToolEnvironment → Supervisor → bundled Room runtime refuses forged nested UI input while real UI and ordinary Agent still work", async () =>
  fixture(async (service, dir) => {
    const room = await service.createRoom({
      name: "security",
      members: [{ name: "Bot", threadId: "target" }],
    });
    const environment = new ToolEnvironment();
    const supervisor = new PluginRuntimeSupervisor(environment);
    const runtime = createZenXTrustedPlugin(service);
    await supervisor.start(
      bundledPackageRegistration({
        source: "bundled",
        package: {
          manifest,
          invoke: (
            name: string,
            invocation: Parameters<typeof runtime.invoke>[1],
          ) => runtime.invoke(name, invocation),
          close: async () => {},
        },
      } as any),
    );
    const tool = async (name: string, args: Record<string, unknown>) => {
      // Even a forged ToolInvocation property cannot cross the Host Agent path.
      const prepared = environment.prepare({
        name,
        arguments: args,
        callId: randomUUID(),
        trustedPluginUi: true,
        cwd: dir,
        signal: new AbortController().signal,
      });
      const result = await environment.execute(prepared);
      if (result.exitCode !== 0) throw Error(result.output);
      return JSON.parse(result.output) as any;
    };
    try {
      const agentList = await tool("zenx_rooms_list", {
        input: { cursor: 0 },
        trustedUi: true,
        source: "ui",
      });
      assert.equal(
        agentList.rooms[0].operationEpoch,
        undefined,
        "Agent cannot request UI projection even via extra arguments",
      );
      const id = `${room.operationEpoch}:${randomUUID()}`;
      for (const [name, args] of [
        [
          "zenx_rooms_prepare_message",
          { input: { roomId: room.id, operationId: id, text: "forged" } },
        ],
        [
          "zenx_rooms_ack_operation",
          { input: { roomId: room.id, operationId: id } },
        ],
        [
          "zenx_rooms_cancel_prepared",
          { input: { roomId: room.id, operationId: id } },
        ],
        [
          "zenx_rooms_post_message",
          { input: { roomId: room.id, operationId: id, text: "forged" } },
        ],
      ] as const) {
        await assert.rejects(
          tool(name, args),
          /Trusted Room UI required|unavailable|roomId must/i,
          `Agent ${name} cannot claim human origin`,
        );
      }
      assert.equal(service.snapshot().rooms[0]?.operations?.length ?? 0, 0);
      const agentPost = await tool("zenx_rooms_post_message", {
        roomId: room.id,
        text: "Agent normal message",
        input: { roomId: room.id, operationId: id, text: "forged" },
      });
      assert.equal(agentPost.posted, true);
      assert.equal(service.snapshot().rooms[0]?.messages[0]?.kind, "agent");
      const uiList = await supervisor.invoke("zenx-rooms", {
        tool: "zenx_rooms_list",
        arguments: { input: { cursor: 0 } },
        context: { callId: "ui-list", cwd: dir },
        signal: new AbortController().signal,
      });
      assert.equal(
        JSON.parse(uiList.output).rooms[0].operationEpoch,
        room.operationEpoch,
      );
      const ui = async (name: string, input: Record<string, unknown>) =>
        JSON.parse(
          (
            await supervisor.invoke("zenx-rooms", {
              tool: name,
              arguments: { input },
              context: { callId: randomUUID(), cwd: dir },
              signal: new AbortController().signal,
            })
          ).output,
        ) as any;
      await ui("zenx_rooms_prepare_message", {
        roomId: room.id,
        operationId: id,
        text: "real UI",
      });
      const posted = await ui("zenx_rooms_post_message", {
        roomId: room.id,
        operationId: id,
        text: "real UI",
      });
      assert.equal(
        posted.messageId,
        service.snapshot().rooms[0]?.messages[1]?.id,
      );
      assert.equal(service.snapshot().rooms[0]?.messages[1]?.author, "You");
      await ui("zenx_rooms_ack_operation", {
        roomId: room.id,
        operationId: id,
      });
      assert.equal(
        service.snapshot().rooms[0]?.operations?.[0]?.acknowledged,
        true,
      );
    } finally {
      await supervisor.close();
    }
  }));

test("128 prepared slots release by exact durable cancel, old key fenced after trim", async () =>
  fixture(async (service, dir) => {
    const room = await service.createRoom({
      name: "capacity",
      members: [{ name: "Bot", threadId: "target" }],
    });
    const epoch = room.operationEpoch!;
    const ids = Array.from({ length: 128 }, () => `${epoch}:${randomUUID()}`);
    for (const id of ids)
      await service.prepareRoomMessage(room.id, id, "not sent");
    await assert.rejects(
      service.prepareRoomMessage(
        room.id,
        `${epoch}:${randomUUID()}`,
        "overflow",
      ),
      /limit/,
    );
    const cancel = (service as any).cancelPreparedRoomOperation.bind(service);
    const fact = await cancel(room.id, ids[0]!);
    assert.equal(fact.state, "cancelled");
    assert.equal(service.roomOperation(room.id, ids[0]!).state, "cancelled");
    await assert.rejects(
      service.postPreparedRoomMessage(room.id, ids[0]!, "not sent"),
      /cancel/,
    );
    const admitted = `${epoch}:${randomUUID()}`;
    await service.prepareRoomMessage(room.id, admitted, "new");
    assert.equal(service.roomOperation(room.id, admitted).state, "prepared");
    await assert.rejects(
      service.prepareRoomMessage(room.id, ids[0]!, "not sent"),
      /stale|cancel/,
    );
    await service.stopPlugin("zenx-rooms");
    const reopened = await createBundledAutomationPluginService({
      userDataDirectory: dir,
      appServer: {
        request: async () => {
          throw Error("No wake");
        },
        onNotification: () => () => {},
      } as any,
    });
    try {
      await reopened.startPlugin("zenx-rooms", {} as any);
      assert.equal(reopened.roomOperation(room.id, admitted).state, "prepared");
      await assert.rejects(
        reopened.postPreparedRoomMessage(room.id, ids[0]!, "not sent"),
        /missing|stale|cancel/i,
      );
    } finally {
      await reopened.stopPlugin("zenx-rooms");
    }
  }));

test("persisted cancel is idempotent, never withdraws saved messages, and survives restart before any eviction", async () =>
  fixture(async (service, dir) => {
    const a = await service.createRoom({
      name: "A",
      members: [{ name: "Bot", threadId: "target" }],
    });
    const b = await service.createRoom({
      name: "B",
      members: [{ name: "Bot", threadId: "target" }],
    });
    const canceled = `${a.operationEpoch}:${randomUUID()}`;
    await service.prepareRoomMessage(a.id, canceled, "abandoned");
    const first = await service.cancelPreparedRoomOperation(a.id, canceled);
    const second = await service.cancelPreparedRoomOperation(a.id, canceled);
    assert.deepEqual(second, first);
    assert.equal(first.state, "cancelled");
    assert.equal(first.messageId, null);
    assert.equal(service.snapshot().rooms[0]?.messages.length, 0);
    await assert.rejects(
      service.prepareRoomMessage(a.id, canceled, "abandoned"),
      /cancelled/,
    );
    await assert.rejects(
      service.postPreparedRoomMessage(a.id, canceled, "abandoned"),
      /cancelled/,
    );
    await assert.rejects(
      service.cancelPreparedRoomOperation(b.id, canceled),
      /unknown/,
    );
    assert.equal(service.snapshot().rooms[1]?.operations?.length ?? 0, 0);
    const saved = `${a.operationEpoch}:${randomUUID()}`;
    await service.prepareRoomMessage(a.id, saved, "sent");
    const posted = await service.postPreparedRoomMessage(a.id, saved, "sent");
    await assert.rejects(
      service.cancelPreparedRoomOperation(a.id, saved),
      new RegExp(posted.messageId!, "u"),
    );
    assert.equal(service.roomOperation(a.id, saved).state, "saved");
    await service.stopPlugin("zenx-rooms");
    const reopened = await createBundledAutomationPluginService({
      userDataDirectory: dir,
      appServer: {
        request: async () => {
          throw Error("no wake");
        },
        onNotification: () => () => {},
      } as any,
    });
    try {
      await reopened.startPlugin("zenx-rooms", {} as any);
      assert.equal(reopened.roomOperation(a.id, canceled).state, "cancelled");
      await assert.rejects(
        reopened.postPreparedRoomMessage(a.id, canceled, "abandoned"),
        /cancelled/,
      );
      assert.equal(
        reopened.roomOperation(a.id, saved).messageId,
        posted.messageId,
      );
      assert.equal(
        reopened.snapshot().rooms.find((room) => room.id === a.id)?.messages
          .length,
        1,
      );
    } finally {
      await reopened.stopPlugin("zenx-rooms");
    }
  }));

test("Room mutation ordering fences both commit-first and cancel-first races", async () =>
  fixture(async (service) => {
    const room = await service.createRoom({
      name: "race",
      members: [{ name: "Bot", threadId: "target" }],
    });
    const first = `${room.operationEpoch}:${randomUUID()}`;
    await service.prepareRoomMessage(room.id, first, "commit wins");
    const postPromise = service.postPreparedRoomMessage(
      room.id,
      first,
      "commit wins",
    );
    const lateCancel = service.cancelPreparedRoomOperation(room.id, first);
    const saved = await postPromise;
    await assert.rejects(lateCancel, new RegExp(saved.messageId!, "u"));
    assert.equal(service.roomOperation(room.id, first).state, "saved");
    const second = `${room.operationEpoch}:${randomUUID()}`;
    await service.prepareRoomMessage(room.id, second, "cancel wins");
    const cancelPromise = service.cancelPreparedRoomOperation(room.id, second);
    const latePost = service.postPreparedRoomMessage(
      room.id,
      second,
      "cancel wins",
    );
    assert.equal((await cancelPromise).state, "cancelled");
    await assert.rejects(latePost, /cancelled/);
    assert.equal(service.snapshot().rooms[0]?.messages.length, 1);
  }));

test("upgrading an enabled 1.0.1 Room generation cannot acknowledge a cancellation without persisting it", async () => {
  const dir = await mkdtemp(
    path.join(os.tmpdir(), "zen-room-generation-race-"),
  );
  const appServer = {
    request: async () => {
      throw Error("no wake");
    },
    onNotification: () => () => {},
  } as any;
  const service = await createBundledAutomationPluginService({
    userDataDirectory: dir,
    appServer,
  });
  const oldSdk = { version: "old" } as any;
  const fixedSdk = { version: "new" } as any;
  try {
    // Real desktop keeps Trigger service running while the old bundled Rooms
    // runtime is retiring and the new package generation is already active.
    await service.startPlugin("zenx-triggers", {} as any);
    await service.startPlugin("zenx-rooms", oldSdk);
    const room = await service.createRoom({
      name: "upgrade",
      members: [{ name: "Bot", threadId: "target" }],
    });
    const id = `${room.operationEpoch}:${randomUUID()}`;
    await service.prepareRoomMessage(room.id, id, "not sent");
    await service.startPlugin("zenx-rooms", fixedSdk);
    // The pre-fix 1.0.1 runtime has no SDK identity on close.
    await service.stopPlugin("zenx-rooms");
    assert.equal(
      (await service.cancelPreparedRoomOperation(room.id, id)).state,
      "cancelled",
    );
    const reopened = await createBundledAutomationPluginService({
      userDataDirectory: dir,
      appServer,
    });
    try {
      await reopened.startPlugin("zenx-rooms", {} as any);
      assert.equal(
        reopened.roomOperation(room.id, id).state,
        "cancelled",
        "durable Room fact cannot be omitted by old-generation close",
      );
    } finally {
      await reopened.stopPlugin("zenx-rooms");
    }
    await service.stopPlugin("zenx-rooms", fixedSdk);
    await service.stopPlugin("zenx-triggers");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
