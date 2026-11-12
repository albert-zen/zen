import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createZenXTrustedPlugin } from "../../../packages/zenx-rooms-plugin/src/runtime.js";
import { createBundledAutomationPluginService } from "../src/main/automation-plugin-service.js";
import { ZenXRoomsCapabilityPackage } from "../src/main/capabilities/automation-control-package.js";
import { createZenXRoomsProfileLoader } from "../src/main/rooms-profile-loader.js";

test("Host Room service gate denies a cached arguments.input runtime without rejecting ordinary Agent and UI calls", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "zen-room-host-source-"));
  const service = await createBundledAutomationPluginService({
    userDataDirectory: dir,
    appServer: {
      request: async () => {
        throw Error("No member wakeup in this test");
      },
      onNotification: () => () => {},
    } as never,
  });
  const loader = createZenXRoomsProfileLoader(() => service);
  let outsidePrepare:
    ((id: string, key: string, text: string) => Promise<unknown>) | undefined;
  const cached = loader({
    createZenXTrustedPlugin: (port: {
      snapshot(): { rooms: Array<{ operationEpoch?: string }> };
      prepareRoomMessage(
        id: string,
        key: string,
        text: string,
      ): Promise<unknown>;
      postPreparedRoomMessage(
        id: string,
        key: string,
        text: string,
      ): Promise<unknown>;
      postAgentRoomMessage(id: string, text: string): Promise<unknown>;
      acknowledgeRoomOperation(id: string, key: string): Promise<unknown>;
    }) => {
      outsidePrepare = port.prepareRoomMessage.bind(port);
      return {
        invoke: async (
          name: string,
          invocation: {
            arguments: Record<string, unknown>;
          },
        ) => {
          const args = (invocation.arguments["input"] ??
            invocation.arguments) as Record<string, string>;
          if (name === "zenx_rooms_list")
            return { rooms: port.snapshot().rooms };
          if (name === "zenx_rooms_prepare_message")
            return await port.prepareRoomMessage(
              args["roomId"]!,
              args["operationId"]!,
              args["text"]!,
            );
          if (name === "zenx_rooms_post_message") {
            if (args["operationId"] !== undefined)
              return await port.postPreparedRoomMessage(
                args["roomId"]!,
                args["operationId"]!,
                args["text"]!,
              );
            return await port.postAgentRoomMessage(
              args["roomId"]!,
              args["text"]!,
            );
          }
          return await port.acknowledgeRoomOperation(
            args["roomId"]!,
            args["operationId"]!,
          );
        },
      };
    },
  });
  const fixed = loader({ createZenXTrustedPlugin });
  const invoke = (
    runtime: typeof cached,
    name: string,
    args: Record<string, unknown>,
    trustedPluginUi = false,
  ) =>
    runtime.invoke(name, {
      callId: randomUUID(),
      ...(trustedPluginUi ? { trustedPluginUi: true as const } : {}),
      arguments: args,
      cwd: dir,
      signal: new AbortController().signal,
    });
  try {
    await service.startPlugin("zenx-rooms", {} as never);
    const room = await service.createRoom({
      name: "source",
      members: [{ name: "Bot", threadId: "no-trigger" }],
    });
    const id = `${room.operationEpoch}:${randomUUID()}`;
    const input = { roomId: room.id, operationId: id, text: "not sent" };
    for (const name of [
      "zenx_rooms_list",
      "zenx_rooms_prepare_message",
      "zenx_rooms_post_message",
      "zenx_rooms_ack_operation",
    ]) {
      await assert.rejects(
        invoke(cached, name, { input, source: "ui", trustedPluginUi: true }),
        /Trusted Room UI required/u,
      );
    }
    assert.equal(service.snapshot().rooms[0]?.messages.length, 0);
    assert.equal(service.snapshot().rooms[0]?.operations?.length ?? 0, 0);
    await invoke(cached, "zenx_rooms_post_message", {
      roomId: room.id,
      text: "ordinary Agent",
    });
    assert.equal(service.snapshot().rooms[0]?.messages[0]?.kind, "agent");
    await assert.rejects(
      invoke(
        cached,
        "zenx_rooms_post_message",
        {
          input: { roomId: room.id, text: "legacy UI fallback" },
        },
        true,
      ),
      /Trusted Room UI cannot use the Agent post path/u,
    );
    const safe = (await invoke(fixed, "zenx_rooms_list", { cursor: 0 })) as {
      rooms: Array<{ operationEpoch?: string }>;
    };
    assert.equal(safe.rooms[0]?.operationEpoch, undefined);
    const ui = (await invoke(
      fixed,
      "zenx_rooms_list",
      { input: { cursor: 0 } },
      true,
    )) as { rooms: Array<{ operationEpoch?: string }> };
    assert.equal(ui.rooms[0]?.operationEpoch, room.operationEpoch);
    await invoke(fixed, "zenx_rooms_prepare_message", { input }, true);
    await invoke(fixed, "zenx_rooms_post_message", { input }, true);
    assert.equal(service.snapshot().rooms[0]?.messages[1]?.kind, "human");
    await invoke(
      fixed,
      "zenx_rooms_ack_operation",
      { input: { roomId: room.id, operationId: id } },
      true,
    );
    assert.equal(
      service.snapshot().rooms[0]?.operations?.[0]?.acknowledged,
      true,
    );
    assert.throws(
      () =>
        outsidePrepare!(
          room.id,
          `${room.operationEpoch}:${randomUUID()}`,
          "after invocation",
        ),
      /Room invocation is not active/u,
    );
    assert.equal(service.snapshot().rooms[0]?.operations?.length, 1);
  } finally {
    await service.stopPlugin("zenx-rooms").catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

test("PAW model rename uses Host binding and current Room while ordinary Room management remains available", async () => {
  const rooms = [
    {
      id: "paw-a",
      name: "PAW",
      assistant: { threadId: "thread-a", triggerId: "trigger-a" },
    },
    {
      id: "paw-b",
      name: "Other",
      assistant: { threadId: "thread-b", triggerId: "trigger-b" },
    },
    { id: "shared", name: "Team" },
  ];
  const history: Array<{
    threadId: string;
    status: string;
    sourceRoomId: string | null;
  }> = [];
  const renamed: string[] = [];
  const domain = {
    prepareRoomMessage() {},
    postPreparedRoomMessage() {},
    cancelPreparedRoomOperation() {},
    snapshot: () => ({ rooms, history }),
    renameRoom: async (id: string, name: string) => {
      renamed.push(`${id}:${name}`);
    },
  };
  const runtime = createZenXRoomsProfileLoader(() => domain as never)({
    createZenXTrustedPlugin,
  });
  const rename = (
    roomId: string,
    threadId?: string,
    extra: Record<string, unknown> = {},
    ui = false,
    cwd = "/workspace-a",
  ) =>
    runtime.invoke("zenx_rooms_rename", {
      callId: randomUUID(),
      cwd,
      signal: new AbortController().signal,
      ...(threadId ? { threadId } : {}),
      ...(ui ? { trustedPluginUi: true as const } : {}),
      arguments: ui
        ? { input: { roomId, name: "Nova" } }
        : { roomId, name: "Nova", ...extra },
    });
  await rename("paw-a", "thread-a");
  for (const caller of [
    undefined,
    "thread-b",
    "thread-a-fork",
    "thread-a-sidechat",
  ]) {
    await assert.rejects(
      rename("paw-a", caller, { threadId: "thread-a", trustedPluginUi: true }),
      /Only the bound PAW/,
    );
  }
  await assert.rejects(
    rename("paw-b", "thread-a", { cwd: "/workspace-b" }),
    /Only the bound PAW/,
  );
  await assert.rejects(
    rename("paw-a", "thread-b", {}, false, "/workspace-b"),
    /Only the bound PAW/,
  );
  rooms.push({
    id: "paw-a-second",
    name: "Second",
    assistant: { threadId: "thread-a", triggerId: "trigger-second" },
  });
  await assert.rejects(rename("paw-a", "thread-a"), /unambiguous current Room/);
  history.push({
    threadId: "thread-a",
    status: "running",
    sourceRoomId: "paw-a",
  });
  await rename("paw-a", "thread-a");
  await assert.rejects(
    rename("paw-a-second", "thread-a"),
    /unambiguous current Room/,
  );
  history.push({
    threadId: "thread-a",
    status: "starting",
    sourceRoomId: "paw-a-second",
  });
  await assert.rejects(rename("paw-a", "thread-a"), /unambiguous current Room/);
  await rename("shared", "ordinary-management-agent");
  await rename("paw-b", undefined, {}, true);
  const legacy = new ZenXRoomsCapabilityPackage(domain as never);
  await assert.rejects(
    legacy.invoke("zenx_rooms_rename", {
      name: "zenx_rooms_rename",
      callId: randomUUID(),
      threadId: "thread-a-fork",
      cwd: "/workspace-a",
      arguments: { roomId: "paw-a", name: "Forged" },
      signal: new AbortController().signal,
    }),
    /Only the bound PAW/,
  );
  assert.deepEqual(renamed, [
    "paw-a:Nova",
    "paw-a:Nova",
    "shared:Nova",
    "paw-b:Nova",
  ]);
});
