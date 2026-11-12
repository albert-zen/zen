import { realpath } from "node:fs/promises";
import type { PawOperation } from "../../../../packages/zenx-imzenx-plugin/src/paw-pipe.js";
import { createFleetRoomsHandler } from "./fleet-rooms.js";
import type { AppServerManager } from "./app-server-manager.js";
import type { ZenXBundledAutomationPluginService } from "./automation-plugin-service.js";

/** IMZenX selects existing assistant Rooms within its explicitly configured workspace. */
export function createImZenXPawHandler(
  manager: AppServerManager,
  getAutomation: () => ZenXBundledAutomationPluginService | undefined,
) {
  const rooms = createFleetRoomsHandler(manager, getAutomation);
  return async (
    cwd: string,
    operation: PawOperation,
    input: Readonly<Record<string, unknown>>,
  ) => {
    const permitted =
      operation === "list"
        ? []
        : operation === "read"
          ? ["roomId"]
          : ["roomId", "text", "clientId"];
    if (
      Object.keys(input).some((key) => !permitted.includes(key)) ||
      Object.values(input).some((value) => typeof value !== "string")
    )
      throw new Error("Invalid PAW request fields");
    const workspaceCwd = await realpath(cwd);
    return rooms(operation, {
      workspaceId: "imzenx",
      workspaceCwd,
      deviceId: "imzenx",
      ...(input.roomId === undefined ? {} : { roomId: input.roomId as string }),
      ...(input.text === undefined ? {} : { text: input.text as string }),
      ...(input.clientId === undefined
        ? {}
        : { clientId: input.clientId as string }),
    });
  };
}
