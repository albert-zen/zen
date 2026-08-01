import { contextBridge, ipcRenderer } from "electron";

import type { AppServerHostStatus } from "../main/app-server-manager.js";
import type {
  ApprovalDecision,
  ApprovalRequestEvent,
  ApprovalResolvedEvent,
} from "../main/app-server-manager.js";
import type {
  ClientRequestMethod,
  ClientRequestParams,
  ClientRequestResults,
  ServerNotificationMethod,
  ServerNotificationParams,
} from "../protocol-client/index.js";
import { ipcChannels } from "./ipc.js";

contextBridge.exposeInMainWorld("zenx", {
  platform: process.platform,
  protocol: {
    getStatus: async (): Promise<AppServerHostStatus> =>
      await ipcRenderer.invoke(ipcChannels.getStatus),
    getPendingApprovals: async (): Promise<ApprovalRequestEvent[]> =>
      await ipcRenderer.invoke(ipcChannels.getPendingApprovals),
    request: async <M extends ClientRequestMethod>(
      method: M,
      params: ClientRequestParams[M],
    ): Promise<ClientRequestResults[M]> =>
      await ipcRenderer.invoke(ipcChannels.request, method, params),
    respondToApproval: async (
      requestId: string,
      decision: ApprovalDecision,
    ): Promise<void> =>
      await ipcRenderer.invoke(
        ipcChannels.respondApproval,
        requestId,
        decision,
      ),
    onApprovalRequest: (
      listener: (event: ApprovalRequestEvent) => void,
    ): (() => void) => {
      const wrapped = (
        _event: Electron.IpcRendererEvent,
        approval: ApprovalRequestEvent,
      ) => listener(approval);
      ipcRenderer.on(ipcChannels.approvalRequest, wrapped);
      return () => ipcRenderer.off(ipcChannels.approvalRequest, wrapped);
    },
    onApprovalResolved: (
      listener: (event: ApprovalResolvedEvent) => void,
    ): (() => void) => {
      const wrapped = (
        _event: Electron.IpcRendererEvent,
        approval: ApprovalResolvedEvent,
      ) => listener(approval);
      ipcRenderer.on(ipcChannels.approvalResolved, wrapped);
      return () => ipcRenderer.off(ipcChannels.approvalResolved, wrapped);
    },
    onStatus: (
      listener: (status: AppServerHostStatus) => void,
    ): (() => void) => {
      const wrapped = (_event: Electron.IpcRendererEvent, status: unknown) => {
        listener(status as AppServerHostStatus);
      };
      ipcRenderer.on(ipcChannels.status, wrapped);
      return () => ipcRenderer.off(ipcChannels.status, wrapped);
    },
    onNotification: (
      listener: <M extends ServerNotificationMethod>(
        method: M,
        params: ServerNotificationParams[M],
      ) => void,
    ): (() => void) => {
      const wrapped = (
        _event: Electron.IpcRendererEvent,
        method: ServerNotificationMethod,
        params: ServerNotificationParams[ServerNotificationMethod],
      ) => listener(method, params);
      ipcRenderer.on(ipcChannels.notification, wrapped);
      return () => ipcRenderer.off(ipcChannels.notification, wrapped);
    },
  },
});
