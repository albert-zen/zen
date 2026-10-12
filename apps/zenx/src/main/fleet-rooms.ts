import { realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import type { AppServerManager } from "./app-server-manager.js";
import type { ZenXBundledAutomationPluginService } from "./automation-plugin-service.js";
import type { HostEvent } from "./host-messages.js";
export function createFleetRoomsHandler(
  manager: AppServerManager,
  getAutomation: () => ZenXBundledAutomationPluginService | undefined,
) {
  return async (
    operation: "list" | "read" | "post",
    params: Extract<HostEvent, { type: "fleet/room-request" }>["params"],
  ): Promise<unknown> => {
    const automationService = getAutomation();
    if (!automationService?.roomsAvailable())
      throw new Error("Rooms unavailable");
    const roomList = automationService
      .snapshot()
      .rooms.filter((room) => room.assistant);
    const allowed = [];
    for (const room of roomList) {
      try {
        const { thread } = await manager.request("thread/read", {
          threadId: room.assistant!.threadId,
        });
        if ((await realpath(thread.cwd)) === params.workspaceCwd)
          allowed.push(room);
      } catch {
        /* unavailable thread is not advertised */
      }
    }
    if (operation === "list")
      return {
        rooms: allowed.map((room) => ({
          id: room.id,
          name: room.name,
          threadId: room.assistant!.threadId,
        })),
      };
    const room = allowed.find((room) => room.id === params.roomId);
    if (!room) throw new Error("Room unavailable in authorized workspace");
    const view = {
      id: room.id,
      name: room.name,
      threadId: room.assistant!.threadId,
    };
    if (operation === "read")
      return {
        room: { ...view, operationEpoch: room.operationEpoch },
        messages: room.messages.slice(-50),
      };
    if (
      typeof params.text !== "string" ||
      !params.text.trim() ||
      typeof params.clientId !== "string" ||
      !params.clientId ||
      params.clientId.length > 512
    )
      throw new Error("Invalid Room message");
    const hash = createHash("sha256")
      .update(JSON.stringify([params.deviceId, params.clientId]))
      .digest("hex");
    const epoch = params.clientId.split(":")[0];
    if (
      !epoch ||
      !/^[0-9a-f-]{36}$/i.test(epoch) ||
      params.clientId.split(":").length !== 2
    )
      throw new Error("Read the Room again before preparing a message");
    const id = `${epoch}:${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
    await automationService.prepareRoomMessage(room.id, id, params.text);
    const result = await automationService.postPreparedRoomMessage(
      room.id,
      id,
      params.text,
    );
    if (!result.messageId) throw new Error("Room admission unknown");
    await automationService.acknowledgeRoomOperation(room.id, id);
    return { messageId: result.messageId, threadId: view.threadId };
  };
}
