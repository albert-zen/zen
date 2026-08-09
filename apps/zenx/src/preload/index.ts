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
import type {
  PublicHostSettings,
  ZenXHostProfile,
} from "../main/host-profile.js";
import type {
  CreateRoomInput,
  CreateTriggerInput,
  RoomMember,
  TriggerSnapshot,
} from "../main/trigger-types.js";

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
  settings: {
    get: async (): Promise<PublicHostSettings> =>
      await ipcRenderer.invoke(ipcChannels.settingsGet),
    save: async (
      profile: ZenXHostProfile,
      apiKey?: string,
    ): Promise<PublicHostSettings> =>
      await ipcRenderer.invoke(ipcChannels.settingsSave, profile, apiKey),
    loginSubscription: async (): Promise<PublicHostSettings> =>
      await ipcRenderer.invoke(ipcChannels.subscriptionLogin),
    submitManualCode: async (code: string): Promise<void> =>
      await ipcRenderer.invoke(ipcChannels.subscriptionManualCode, code),
    logoutSubscription: async (): Promise<PublicHostSettings> =>
      await ipcRenderer.invoke(ipcChannels.subscriptionLogout),
    onManualCodeRequested: (listener: () => void): (() => void) => {
      const wrapped = () => listener();
      ipcRenderer.on(ipcChannels.subscriptionManualRequested, wrapped);
      return () =>
        ipcRenderer.off(ipcChannels.subscriptionManualRequested, wrapped);
    },
  },
  triggers: {
    get: async (): Promise<TriggerSnapshot> =>
      await ipcRenderer.invoke(ipcChannels.triggersGet),
    create: async (input: CreateTriggerInput): Promise<TriggerSnapshot> =>
      await ipcRenderer.invoke(ipcChannels.triggersCreate, input),
    cancel: async (triggerId: string): Promise<TriggerSnapshot> =>
      await ipcRenderer.invoke(ipcChannels.triggersCancel, triggerId),
    signal: async (name: string, detail: string): Promise<TriggerSnapshot> =>
      await ipcRenderer.invoke(ipcChannels.triggersSignal, name, detail),
    createRoom: async (input: CreateRoomInput): Promise<TriggerSnapshot> =>
      await ipcRenderer.invoke(ipcChannels.roomsCreate, input),
    addRoomMember: async (
      roomId: string,
      member: RoomMember,
    ): Promise<TriggerSnapshot> =>
      await ipcRenderer.invoke(ipcChannels.roomsAddMember, roomId, member),
    removeRoomMember: async (
      roomId: string,
      threadId: string,
    ): Promise<TriggerSnapshot> =>
      await ipcRenderer.invoke(ipcChannels.roomsRemoveMember, roomId, threadId),
    postRoomMessage: async (
      roomId: string,
      author: string,
      text: string,
    ): Promise<TriggerSnapshot> =>
      await ipcRenderer.invoke(ipcChannels.roomsPost, roomId, author, text),
    onChange: (listener: (snapshot: TriggerSnapshot) => void): (() => void) => {
      const wrapped = (
        _event: Electron.IpcRendererEvent,
        snapshot: TriggerSnapshot,
      ) => listener(snapshot);
      ipcRenderer.on(ipcChannels.triggersChanged, wrapped);
      return () => ipcRenderer.off(ipcChannels.triggersChanged, wrapped);
    },
  },
});
