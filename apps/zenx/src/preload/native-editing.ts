import { nativeEditingLocalSelectionSelector } from "../native-editing.js";
import { ipcChannels } from "./ipc.js";

export interface NativeEditingApi {
  onPrepareSelectAll(listener: () => boolean): () => void;
  onSelectAllCancelled(listener: () => void): () => void;
}
interface EditingIpc {
  on(channel: string, listener: (...args: unknown[]) => void): unknown;
  removeListener(
    channel: string,
    listener: (...args: unknown[]) => void,
  ): unknown;
  send(channel: string, ...args: unknown[]): void;
}

/** Only the current registered document can complete an explicit native edit. */
export function createNativeEditingApi(
  ipc: EditingIpc,
  createToken: () => string = () => crypto.randomUUID(),
  document?: Document,
  platform: string = process.platform,
): NativeEditingApi {
  const preparers = new Set<() => boolean>();
  const cancellations = new Set<() => void>();
  let token: string | undefined;
  let registered = false;
  let localRequest = 0;
  let pending:
    | { id: number; prepared: boolean; timer?: ReturnType<typeof setTimeout> }
    | undefined;
  const notifyCancelled = () => {
    for (const listener of [...cancellations]) {
      try {
        listener();
      } catch {
        /* One retired view cannot block other cleanup. */
      }
    }
  };
  const cancel = () => {
    const previous = pending;
    pending = undefined;
    if (previous?.timer) clearTimeout(previous.timer);
    if (previous?.prepared) notifyCancelled();
  };
  const updateRegistration = () => {
    if (!token) return;
    const enabled =
      preparers.size > 0 && !nativeEditingUsesLocalSelection(document);
    if (registered === enabled) return;
    if (!enabled) cancel();
    registered = enabled;
    ipc.send(ipcChannels.nativeEditingRegister, token, enabled);
  };
  const focusOut = () => queueMicrotask(updateRegistration);
  const rotateRegistration = () => {
    cancel();
    if (registered) ipc.send(ipcChannels.nativeEditingRegister, token, false);
    registered = false;
    token = createToken();
    updateRegistration();
  };
  const runPreparers = (id: number) => {
    cancel();
    const request = { id, prepared: false };
    pending = request;
    for (const listener of [...preparers]) {
      if (pending !== request) return false;
      try {
        const prepared = listener() === true;
        if (pending !== request) {
          if (prepared) notifyCancelled();
          return false;
        }
        request.prepared = prepared || request.prepared;
      } catch {
        request.prepared = true;
        cancel();
        return false;
      }
    }
    return pending === request;
  };
  const watchSelection = () => {
    const request = pending;
    if (!request || !document) {
      pending = undefined;
      return;
    }
    if (request.timer) clearTimeout(request.timer);
    request.timer = setTimeout(() => {
      if (pending !== request) return;
      if (document.getSelection()?.isCollapsed === false) pending = undefined;
      else cancel();
    }, 1500);
  };
  const keydown = (event: KeyboardEvent) => {
    if (
      preparers.size === 0 ||
      event.defaultPrevented ||
      event.isComposing ||
      event.key.toLowerCase() !== "a" ||
      event.shiftKey ||
      event.altKey ||
      (platform === "darwin"
        ? !event.metaKey || event.ctrlKey
        : !event.ctrlKey || event.metaKey) ||
      nativeEditingUsesLocalSelection(document)
    )
      return;
    // The original key keeps its default action and editor keymap. Preparing
    // synchronously here avoids a stale main-process focus-registration race.
    if (runPreparers(--localRequest)) watchSelection();
  };
  const prepare = (_event: unknown, receivedToken: unknown, id: unknown) => {
    if (
      receivedToken !== token ||
      token === undefined ||
      !registered ||
      typeof id !== "number" ||
      !Number.isSafeInteger(id) ||
      id <= 0
    )
      return;
    const ready = runPreparers(id);
    // Also bound cleanup if a native completion message is lost.
    if (ready && document) watchSelection();
    ipc.send(ipcChannels.nativeEditingPrepared, token, id, ready);
  };
  const completed = (
    _event: unknown,
    receivedToken: unknown,
    id: unknown,
    executed: unknown,
  ) => {
    if (receivedToken !== token || pending?.id !== id) return;
    if (executed === true) watchSelection();
    else if (executed === false) cancel();
  };
  return {
    onPrepareSelectAll(listener) {
      const first = preparers.size === 0;
      const subscriber = () => listener();
      preparers.add(subscriber);
      if (first) {
        ipc.on(ipcChannels.nativeEditingPrepare, prepare);
        ipc.on(ipcChannels.nativeEditingCompleted, completed);
        document?.addEventListener("keydown", keydown, true);
        document?.addEventListener("focusin", updateRegistration, true);
        document?.addEventListener("focusout", focusOut, true);
      }
      rotateRegistration();
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        preparers.delete(subscriber);
        if (preparers.size !== 0) {
          rotateRegistration();
          return;
        }
        cancel();
        if (registered)
          ipc.send(ipcChannels.nativeEditingRegister, token, false);
        registered = false;
        token = undefined;
        document?.removeEventListener("keydown", keydown, true);
        document?.removeEventListener("focusin", updateRegistration, true);
        document?.removeEventListener("focusout", focusOut, true);
        ipc.removeListener(ipcChannels.nativeEditingPrepare, prepare);
        ipc.removeListener(ipcChannels.nativeEditingCompleted, completed);
      };
    },
    onSelectAllCancelled(listener) {
      cancellations.add(listener);
      return () => cancellations.delete(listener);
    },
  };
}

/** Native editors and embedded documents keep their own accelerator/keymap. */
export function nativeEditingUsesLocalSelection(
  document?: Pick<Document, "activeElement">,
): boolean {
  return !!document?.activeElement?.closest(
    nativeEditingLocalSelectionSelector,
  );
}
