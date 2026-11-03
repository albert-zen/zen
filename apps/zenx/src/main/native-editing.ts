import {
  BrowserWindow,
  ipcMain,
  Menu,
  webContents,
  type WebContents,
  type WebFrameMain,
} from "electron";
import { ipcChannels } from "../preload/ipc.js";
import { isTrustedImZenXSetupSender } from "./imzenx-setup-ipc.js";

/** Window-local native edit handshake; no text, script or resource crosses IPC. */
export function installNativeEditing(options: {
  rendererUrl: string;
  ownsWindow(id: number): boolean;
  menuChanged(): void;
  platform?: NodeJS.Platform;
}) {
  interface Registration {
    sender: WebContents;
    frame: WebFrameMain;
    token: string;
    pending?: { id: number; timer: ReturnType<typeof setTimeout> };
    detach(): void;
  }
  const registrations = new Map<number, Registration>();
  const platform = options.platform ?? process.platform;
  let nextRequest = 0;
  const trusted = (sender: WebContents, frame: WebFrameMain | null) => {
    if (sender.isDestroyed() || !frame || frame.isDestroyed() || frame.detached)
      return false;
    const window = BrowserWindow.fromWebContents(sender);
    return isTrustedImZenXSetupSender(
      {
        ownedWindow:
          window !== null &&
          window.webContents === sender &&
          options.ownsWindow(window.id),
        mainFrame: frame === sender.mainFrame,
        url: frame.url,
      },
      options.rendererUrl,
    );
  };
  const current = (state: Registration) =>
    registrations.get(state.sender.id) === state &&
    trusted(state.sender, state.frame) &&
    webContents.getFocusedWebContents() === state.sender;
  const finish = (state: Registration, executed: boolean) => {
    const pending = state.pending;
    if (!pending) return;
    state.pending = undefined;
    clearTimeout(pending.timer);
    if (!state.sender.isDestroyed() && !state.frame.isDestroyed())
      state.frame.send(
        ipcChannels.nativeEditingCompleted,
        state.token,
        pending.id,
        executed,
      );
  };
  const retire = (state: Registration) => {
    if (registrations.get(state.sender.id) !== state) return;
    finish(state, false);
    registrations.delete(state.sender.id);
    state.detach();
    options.menuChanged();
  };
  const request = (state: Registration) => {
    if (!current(state)) return;
    finish(state, false);
    const id = ++nextRequest;
    const timer = setTimeout(() => {
      if (state.pending?.id === id) finish(state, false);
    }, 1500);
    state.pending = { id, timer };
    state.frame.send(ipcChannels.nativeEditingPrepare, state.token, id);
  };
  const register = (
    event: Electron.IpcMainEvent,
    token: unknown,
    enabled: unknown,
  ) => {
    if (
      typeof token !== "string" ||
      !/^[a-zA-Z0-9-]{1,80}$/u.test(token) ||
      typeof enabled !== "boolean" ||
      !trusted(event.sender, event.senderFrame)
    )
      return;
    const old = registrations.get(event.sender.id);
    if (!enabled) {
      if (old?.token === token && old.frame === event.senderFrame) retire(old);
      return;
    }
    if (old?.token === token && old.frame === event.senderFrame) return;
    if (old) retire(old);
    const sender = event.sender;
    const frame = event.senderFrame!;
    const state: Registration = { sender, frame, token, detach: () => {} };
    const blur = () => {
      finish(state, false);
      options.menuChanged();
    };
    const focus = () => options.menuChanged();
    const navigation = (
      details: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>,
    ) => {
      if (details.isMainFrame && !details.isSameDocument) retire(state);
    };
    const gone = () => retire(state);
    sender.on("blur", blur);
    sender.on("focus", focus);
    sender.on("did-start-navigation", navigation);
    sender.on("destroyed", gone);
    sender.on("render-process-gone", gone);
    state.detach = () => {
      sender.removeListener("blur", blur);
      sender.removeListener("focus", focus);
      sender.removeListener("did-start-navigation", navigation);
      sender.removeListener("destroyed", gone);
      sender.removeListener("render-process-gone", gone);
    };
    registrations.set(sender.id, state);
    options.menuChanged();
  };
  const prepared = (
    event: Electron.IpcMainEvent,
    token: unknown,
    id: unknown,
    ready: unknown,
  ) => {
    const state = registrations.get(event.sender.id);
    if (
      !state ||
      state.token !== token ||
      state.frame !== event.senderFrame ||
      state.pending?.id !== id
    )
      return;
    if (ready !== true || !current(state)) {
      finish(state, false);
      return;
    }
    // The renderer's synchronous callback has committed its DOM before this ACK.
    // Editors return false there; the same native command keeps local selection.
    try {
      if (platform === "darwin") Menu.sendActionToFirstResponder("selectAll:");
      else state.sender.selectAll();
      finish(state, true);
    } catch {
      finish(state, false);
    }
  };
  ipcMain.on(ipcChannels.nativeEditingRegister, register);
  ipcMain.on(ipcChannels.nativeEditingPrepared, prepared);
  return {
    available() {
      const focused = webContents.getFocusedWebContents();
      const state = focused && registrations.get(focused.id);
      return !!state && current(state);
    },
    selectAll() {
      const focused = webContents.getFocusedWebContents();
      const state = focused && registrations.get(focused.id);
      if (state && current(state)) request(state);
      else if (platform === "darwin")
        Menu.sendActionToFirstResponder("selectAll:");
      else focused?.selectAll();
    },
    close() {
      ipcMain.removeListener(ipcChannels.nativeEditingRegister, register);
      ipcMain.removeListener(ipcChannels.nativeEditingPrepared, prepared);
      for (const state of registrations.values()) retire(state);
    },
  };
}
