import { BrowserWindow, ipcMain } from "electron";
import { ipcChannels } from "../../preload/ipc.js";
import type { AgentProviderService } from "./service.js";

export function registerAgentProviderIpc(service: AgentProviderService): void {
  ipcMain.handle(
    ipcChannels.agentProvidersRequest,
    async (_event, method: unknown, value: unknown) => {
      const args =
        typeof value === "object" && value !== null && !Array.isArray(value)
          ? (value as Record<string, unknown>)
          : {};
      const id = (name: string) => {
        if (
          typeof args[name] !== "string" ||
          (args[name] as string).length === 0
        )
          throw new Error(`Missing ${name}`);
        return args[name] as string;
      };
      switch (method) {
        case "list":
          return service.list();
        case "save":
          return service.save(value);
        case "capabilities":
          return service.capabilities(id("instanceId"));
        case "models":
          return service.models(id("instanceId"));
        case "sessions":
          return service.sessions();
        case "approvals":
          return service.approvals(id("sessionId"));
        case "create":
          return service.create({
            providerInstanceId: id("providerInstanceId"),
            cwd: id("cwd"),
            model: args.model as string | undefined,
            permissionMode:
              args.permissionMode as import("../../protocol-client/types.js").FilePermissionMode,
          });
        case "read":
          return service.read(id("sessionId"));
        case "send":
          return service.send(id("sessionId"), {
            text: id("text"),
            model: args.model as string | undefined,
          });
        case "interrupt":
          return service.interrupt(id("sessionId"));
        case "respondApproval":
          return service.respondApproval(
            id("sessionId"),
            id("requestId"),
            args.decision as "accept" | "decline",
          );
        default:
          throw new Error("Unsupported Agent Provider operation");
      }
    },
  );
  service.onEvent((event) => {
    for (const window of BrowserWindow.getAllWindows())
      window.webContents.send(ipcChannels.agentProvidersEvent, event);
  });
}
