import { join } from "node:path";
import {
  InMemoryAttachmentStore,
  type FileAttachmentStore,
} from "../../../../src/attachment.js";
import type { ZenXImageDraft } from "./image-attachments.js";
import type { AppShotCapture, AppShotService } from "./app-shot.js";
import { imageDraft } from "./image-attachments.js";
import { isTrustedImZenXSetupSender } from "./imzenx-setup-ipc.js";
import type { AppShotEvent, AppShotShortcutKind } from "../app-shot.js";
import { startAppShotModifierPair } from "./app-shot-shortcut.js";

const SHORTCUT = "CommandOrControl+Shift+2";
const CHANNELS = {
  list: "zenx:app-shot:list",
  capture: "zenx:app-shot:capture",
  read: "zenx:app-shot:read",
  attach: "zenx:app-shot:attach",
  discard: "zenx:app-shot:discard",
  arm: "zenx:app-shot:arm",
  disarm: "zenx:app-shot:disarm",
  captured: "zenx:app-shot:captured",
} as const;

export interface AppShotCaller<Renderer extends object, Frame extends object> {
  renderer: Renderer;
  frame: Frame;
}

export interface AppShotIpcDependencies<
  Renderer extends object,
  Frame extends object,
> {
  platform: string;
  rendererUrl: string;
  trusted(caller: AppShotCaller<Renderer, Frame>): {
    ownedWindow: boolean;
    mainFrame: boolean;
    url: string;
  };
  createService(renderer: Renderer): AppShotService;
  preparePreview(capture: AppShotCapture): Promise<ZenXImageDraft>;
  importCapture(capture: AppShotCapture): Promise<ZenXImageDraft>;
  registerShortcut(accelerator: string, callback: () => void): boolean;
  unregisterShortcut(accelerator: string): void;
  startModifierPair?(options: {
    onTrigger(): void;
    onFailure(error: unknown): void;
    signal: AbortSignal;
  }): Promise<{ stop(): Promise<void> }>;
  sendCaptured(renderer: Renderer, payload: AppShotEvent): void;
  focus(renderer: Renderer): void;
}

type Caller<R extends object, F extends object> = AppShotCaller<R, F>;
type Preview = {
  capture: AppShotCapture;
  draft: ZenXImageDraft;
  attaching: boolean;
  expiresAt: number;
  timer: ReturnType<typeof setTimeout>;
};
type Session<F extends object> = {
  frame: F;
  service: AppShotService;
  previews: Map<string, Preview>;
};
type Owner<R extends object, F extends object> = {
  caller: Caller<R, F>;
  session: Session<F>;
  token: string;
  includeAccessibility: boolean;
  kind: AppShotShortcutKind;
  abort: AbortController;
  modifierPair?: Promise<{ stop(): Promise<void> }>;
  stopping?: Promise<void>;
  pending: boolean;
};

/** Host-only, injected state machine. No global key hook exists until a trusted renderer opts in. */
export class AppShotIpcController<
  Renderer extends object,
  Frame extends object,
> {
  readonly #deps: AppShotIpcDependencies<Renderer, Frame>;
  readonly #sessions = new Map<Renderer, Session<Frame>>();
  #owner?: Owner<Renderer, Frame>;
  #registered = false;
  #stagedBytes = 0;

  constructor(deps: AppShotIpcDependencies<Renderer, Frame>) {
    this.#deps = deps;
  }

  #require(caller: Caller<Renderer, Frame>): Session<Frame> {
    this.#prune();
    if (!this.#trusted(caller))
      throw new Error("App Shot requires the trusted ZenX main frame");
    let session = this.#sessions.get(caller.renderer);
    if (session?.frame !== caller.frame) {
      this.forget(caller.renderer);
      session = {
        frame: caller.frame,
        service: this.#deps.createService(caller.renderer),
        previews: new Map(),
      };
      this.#sessions.set(caller.renderer, session);
    }
    return session;
  }

  #still(caller: Caller<Renderer, Frame>, session: Session<Frame>): boolean {
    return (
      this.#sessions.get(caller.renderer) === session && this.#trusted(caller)
    );
  }

  #trusted(caller: Caller<Renderer, Frame>): boolean {
    try {
      return isTrustedImZenXSetupSender(
        this.#deps.trusted(caller),
        this.#deps.rendererUrl,
      );
    } catch {
      return false;
    }
  }

  async list(caller: Caller<Renderer, Frame>) {
    const session = this.#require(caller);
    const sources = await session.service.listSources();
    if (!this.#still(caller, session))
      throw new Error("App Shot renderer changed during listing");
    return sources;
  }

  async capture(
    caller: Caller<Renderer, Frame>,
    sourceId: unknown,
    includeAccessibility: unknown,
  ): Promise<ZenXImageDraft> {
    const session = this.#require(caller);
    if (
      typeof sourceId !== "string" ||
      !sourceId ||
      sourceId.length > 100 ||
      typeof includeAccessibility !== "boolean"
    )
      throw new Error("Invalid App Shot capture request");
    const captured = await session.service.capture(sourceId, {
      includeAccessibility,
    });
    if (!this.#still(caller, session))
      throw new Error("App Shot renderer changed during capture");
    const image = await this.#stage(session, captured, () =>
      this.#still(caller, session),
    );
    if (!this.#still(caller, session))
      throw new Error("App Shot renderer changed during capture");
    return image;
  }

  async #stage(
    session: Session<Frame>,
    capture: AppShotCapture,
    valid: () => boolean,
  ): Promise<ZenXImageDraft> {
    this.#prune();
    this.#checkCapacity(session, capture.bytes.byteLength);
    const staged = { ...capture, bytes: Uint8Array.from(capture.bytes) };
    const draft = await this.#deps.preparePreview(staged);
    if (!valid()) throw new Error("App Shot renderer changed during capture");
    if (session.previews.has(draft.id))
      throw new Error("Duplicate App Shot preview");
    this.#checkCapacity(session, staged.bytes.byteLength);
    const expiresAt = Date.now() + 5 * 60_000;
    const timer = setTimeout(
      () => this.#removePreview(session, draft.id),
      5 * 60_000,
    );
    timer.unref();
    session.previews.set(draft.id, {
      capture: staged,
      draft,
      attaching: false,
      expiresAt,
      timer,
    });
    this.#stagedBytes += staged.bytes.byteLength;
    return draft;
  }

  #checkCapacity(session: Session<Frame>, size: number): void {
    if (!Number.isSafeInteger(size) || size < 1 || size > 20 * 1024 * 1024)
      throw new Error("App Shot preview exceeds the image size limit");
    if (
      session.previews.size >= 4 ||
      this.#stagedBytes + size > 40 * 1024 * 1024
    )
      throw new Error(
        "Too many pending App Shot previews; attach or discard one first",
      );
  }

  #preview(session: Session<Frame>, previewId: unknown): Preview {
    if (
      typeof previewId !== "string" ||
      !/^[\x21-\x7e]{1,80}$/u.test(previewId)
    )
      throw new Error("Invalid App Shot preview ID");
    const preview = session.previews.get(previewId);
    if (!preview) throw new Error("App Shot preview is missing or stale");
    return preview;
  }

  read(caller: Caller<Renderer, Frame>, previewId: unknown): Uint8Array {
    const session = this.#require(caller);
    return Uint8Array.from(this.#preview(session, previewId).capture.bytes);
  }

  async attach(
    caller: Caller<Renderer, Frame>,
    previewId: unknown,
  ): Promise<ZenXImageDraft> {
    const session = this.#require(caller);
    const preview = this.#preview(session, previewId);
    if (preview.attaching)
      throw new Error("App Shot preview is already attaching");
    if (!this.#still(caller, session))
      throw new Error("App Shot renderer changed before attach");
    preview.attaching = true;
    try {
      const draft = await this.#deps.importCapture(preview.capture);
      if (!this.#still(caller, session))
        throw new Error("App Shot renderer changed during attach");
      if (session.previews.get(preview.draft.id) !== preview)
        throw new Error("App Shot preview was discarded");
      this.#removePreview(session, preview.draft.id);
      return draft;
    } catch (error) {
      preview.attaching = false;
      throw error;
    }
  }

  discard(caller: Caller<Renderer, Frame>, previewId: unknown): void {
    const session = this.#require(caller);
    if (
      typeof previewId !== "string" ||
      !/^[\x21-\x7e]{1,80}$/u.test(previewId)
    )
      throw new Error("Invalid App Shot preview ID");
    this.#removePreview(session, previewId);
  }

  #removePreview(session: Session<Frame>, previewId: string): void {
    const preview = session.previews.get(previewId);
    if (!preview) return;
    session.previews.delete(previewId);
    clearTimeout(preview.timer);
    this.#stagedBytes -= preview.capture.bytes.byteLength;
  }

  #prune(): void {
    const now = Date.now();
    for (const session of this.#sessions.values())
      for (const [id, preview] of session.previews)
        if (preview.expiresAt <= now) this.#removePreview(session, id);
  }

  async arm(
    caller: Caller<Renderer, Frame>,
    token: unknown,
    includeAccessibility: unknown,
    kind: unknown = "chord",
  ): Promise<string> {
    const session = this.#require(caller);
    if (
      typeof token !== "string" ||
      !/^[\x21-\x7e]{1,80}$/u.test(token) ||
      typeof includeAccessibility !== "boolean" ||
      (kind !== "both-shift" && kind !== "chord")
    )
      throw new Error("Invalid App Shot shortcut request");
    if (
      kind === "both-shift" &&
      this.#deps.platform !== "darwin" &&
      this.#deps.platform !== "win32"
    )
      throw new Error("Both Shift is available only on macOS and Windows");
    const previous = this.#owner;
    const cleanup = this.#clearOwner();
    const owner: Owner<Renderer, Frame> = {
      caller,
      session,
      token,
      includeAccessibility,
      kind,
      abort: new AbortController(),
      pending: false,
    };
    // Establish ownership before awaiting startup: held modifiers may fire at once.
    this.#owner = owner;
    if (
      previous &&
      (previous.caller.renderer !== caller.renderer ||
        previous.caller.frame !== caller.frame ||
        previous.token !== token) &&
      this.#still(previous.caller, previous.session)
    )
      this.#deps.sendCaptured(previous.caller.renderer, {
        token: previous.token,
        disarmed: true,
      });
    try {
      await cleanup;
      if (this.#owner !== owner || !this.#still(caller, session))
        throw new Error("App Shot shortcut was cancelled");
      if (kind === "both-shift") {
        if (!this.#deps.startModifierPair)
          throw new Error("Both Shift is unavailable");
        owner.modifierPair = this.#deps.startModifierPair({
          signal: owner.abort.signal,
          onTrigger: () => {
            if (this.#owner === owner) void this.onShortcut();
          },
          onFailure: (error) => this.#modifierFailed(owner, error),
        });
        await owner.modifierPair;
        if (this.#owner !== owner || !this.#still(caller, session)) {
          await this.#stopModifierPair(owner);
          throw new Error("App Shot shortcut was cancelled");
        }
      } else {
        if (
          !this.#deps.registerShortcut(SHORTCUT, () => {
            if (this.#owner === owner) void this.onShortcut();
          })
        )
          throw new Error("App Shot shortcut is unavailable");
        this.#registered = true;
      }
      return kind === "both-shift"
        ? "Left Shift + Right Shift"
        : this.#deps.platform === "darwin"
          ? "⌘⇧2"
          : "Ctrl+Shift+2";
    } catch (error) {
      if (this.#owner === owner) await this.#clearOwner();
      throw error;
    }
  }

  #modifierFailed(owner: Owner<Renderer, Frame>, error: unknown): void {
    if (this.#owner !== owner) return;
    const valid = this.#still(owner.caller, owner.session);
    void this.#clearOwner().catch(() => {});
    if (!valid) return;
    const message =
      error instanceof Error ? error.message : "Both Shift stopped";
    this.#deps.sendCaptured(owner.caller.renderer, {
      token: owner.token,
      disarmed: true,
      error: message.slice(0, 300),
    });
    this.#deps.focus(owner.caller.renderer);
  }

  async disarm(caller: Caller<Renderer, Frame>, token: unknown): Promise<void> {
    this.#require(caller);
    if (typeof token !== "string" || !/^[\x21-\x7e]{1,80}$/u.test(token))
      throw new Error("Invalid App Shot shortcut token");
    if (
      this.#owner?.caller.renderer === caller.renderer &&
      this.#owner.caller.frame === caller.frame &&
      this.#owner.token === token
    )
      await this.#clearOwner();
  }

  async #clearOwner(): Promise<void> {
    const owner = this.#owner;
    this.#owner = undefined;
    owner?.abort.abort();
    if (this.#registered) {
      this.#deps.unregisterShortcut(SHORTCUT);
      this.#registered = false;
    }
    if (owner) await this.#stopModifierPair(owner);
  }

  #stopModifierPair(owner: Owner<Renderer, Frame>): Promise<void> {
    if (!owner.modifierPair) return Promise.resolve();
    owner.stopping ??= owner.modifierPair.then(
      (modifierPair) => modifierPair.stop(),
      () => {},
    );
    return owner.stopping;
  }

  forget(renderer: Renderer): void {
    const session = this.#sessions.get(renderer);
    if (session)
      for (const id of session.previews.keys())
        this.#removePreview(session, id);
    this.#sessions.delete(renderer);
    if (this.#owner?.caller.renderer === renderer)
      void this.#clearOwner().catch(() => {});
  }

  dispose(): void {
    void this.#clearOwner().catch(() => {});
    for (const renderer of this.#sessions.keys()) this.forget(renderer);
    this.#sessions.clear();
  }

  async onShortcut(): Promise<void> {
    const owner = this.#owner;
    if (!owner || owner.pending) return;
    if (!this.#still(owner.caller, owner.session)) {
      this.forget(owner.caller.renderer);
      return;
    }
    if (this.#deps.platform === "linux") {
      // Linux has no verified foreground identity: request an explicit chooser.
      this.#deps.sendCaptured(owner.caller.renderer, {
        token: owner.token,
        openPicker: true,
      });
      this.#deps.focus(owner.caller.renderer);
      return;
    }
    owner.pending = true;
    try {
      // The target must be observed before ZenX is raised; never capture ZenX itself.
      const capture = await owner.session.service.captureActive({
        includeAccessibility: owner.includeAccessibility,
        signal: owner.abort.signal,
      });
      if (this.#owner !== owner || !this.#still(owner.caller, owner.session))
        return;
      const image = await this.#stage(
        owner.session,
        capture,
        () => this.#owner === owner && this.#still(owner.caller, owner.session),
      );
      if (this.#owner !== owner || !this.#still(owner.caller, owner.session)) {
        this.#removePreview(owner.session, image.id);
        return;
      }
      this.#deps.sendCaptured(owner.caller.renderer, {
        token: owner.token,
        image,
      });
      this.#deps.focus(owner.caller.renderer);
    } catch (error) {
      if (this.#owner === owner && this.#still(owner.caller, owner.session)) {
        const message =
          error instanceof Error ? error.message : "App Shot capture failed";
        this.#deps.sendCaptured(owner.caller.renderer, {
          token: owner.token,
          error: message.slice(0, 300),
        });
        this.#deps.focus(owner.caller.renderer);
      }
    } finally {
      owner.pending = false;
    }
  }
}

export async function installAppShotIpc(options: {
  attachments: FileAttachmentStore;
  ownedWindowIds: Set<number>;
  rendererUrl: string;
}): Promise<() => void> {
  const { app, BrowserWindow, globalShortcut, ipcMain } =
    await import("electron");
  type Renderer = Electron.WebContents;
  type Frame = Electron.WebFrameMain;
  const listeners = new Map<
    Renderer,
    {
      navigate: (
        details: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>,
      ) => void;
      destroyed: () => void;
    }
  >();
  const controller = new AppShotIpcController<Renderer, Frame>({
    platform: process.platform,
    rendererUrl: options.rendererUrl,
    trusted({ renderer, frame }) {
      const window = BrowserWindow.fromWebContents(renderer);
      return {
        ownedWindow: window !== null && options.ownedWindowIds.has(window.id),
        mainFrame: frame === renderer.mainFrame,
        url: frame.url,
      };
    },
    createService() {
      // Each renderer gets independent, short-lived source selection tokens.
      return createElectronAppShotService({
        excludedSourceIds: () => {
          return BrowserWindow.getAllWindows()
            .filter((window) => options.ownedWindowIds.has(window.id))
            .map((window) => window.getMediaSourceId());
        },
      });
    },
    async preparePreview(capture) {
      const temporary = new InMemoryAttachmentStore();
      const attachment = await temporary.importBytes(
        capture.bytes,
        capture.mediaType,
      );
      return {
        ...imageDraft(capture.name, attachment),
        appShotContext: capture.context,
      };
    },
    async importCapture(capture) {
      const attachment = await options.attachments.importBytes(
        capture.bytes,
        capture.mediaType,
      );
      return {
        ...imageDraft(capture.name, attachment),
        appShotContext: capture.context,
      };
    },
    startModifierPair: (modifierOptions) =>
      startAppShotModifierPair({
        ...modifierOptions,
        workerPath: join(
          app.getAppPath(),
          "out/main/app-shot-shortcut-worker.js",
        ),
      }),
    registerShortcut: (accelerator, callback) =>
      globalShortcut.register(accelerator, callback),
    unregisterShortcut: (accelerator) => globalShortcut.unregister(accelerator),
    sendCaptured(renderer, payload) {
      renderer.send(CHANNELS.captured, payload);
    },
    focus(renderer) {
      const window = BrowserWindow.fromWebContents(renderer);
      if (
        window &&
        !window.isDestroyed() &&
        options.ownedWindowIds.has(window.id)
      ) {
        window.show();
        window.focus();
      }
    },
  });
  function caller(event: Electron.IpcMainInvokeEvent): Caller<Renderer, Frame> {
    const frame = event.senderFrame;
    if (!frame) throw new Error("App Shot requires a main frame");
    if (!listeners.has(event.sender)) {
      const renderer = event.sender;
      const navigate = (
        details: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>,
      ) => {
        if (details.isMainFrame) controller.forget(renderer);
      };
      const destroyed = () => {
        controller.forget(renderer);
        listeners.delete(renderer);
      };
      renderer.on("did-start-navigation", navigate);
      renderer.on("destroyed", destroyed);
      listeners.set(renderer, { navigate, destroyed });
    }
    return { renderer: event.sender, frame };
  }
  ipcMain.handle(CHANNELS.list, (event) => controller.list(caller(event)));
  ipcMain.handle(
    CHANNELS.capture,
    (event, sourceId: unknown, includeAccessibility: unknown) =>
      controller.capture(caller(event), sourceId, includeAccessibility),
  );
  ipcMain.handle(CHANNELS.read, (event, previewId: unknown) =>
    controller.read(caller(event), previewId),
  );
  ipcMain.handle(CHANNELS.attach, (event, previewId: unknown) =>
    controller.attach(caller(event), previewId),
  );
  ipcMain.handle(CHANNELS.discard, (event, previewId: unknown) =>
    controller.discard(caller(event), previewId),
  );
  ipcMain.handle(
    CHANNELS.arm,
    (event, token: unknown, includeAccessibility: unknown, kind: unknown) =>
      controller.arm(caller(event), token, includeAccessibility, kind),
  );
  ipcMain.handle(CHANNELS.disarm, (event, token: unknown) =>
    controller.disarm(caller(event), token),
  );
  return () => {
    for (const channel of [
      CHANNELS.list,
      CHANNELS.capture,
      CHANNELS.read,
      CHANNELS.attach,
      CHANNELS.discard,
      CHANNELS.arm,
      CHANNELS.disarm,
    ])
      ipcMain.removeHandler(channel);
    for (const [renderer, listener] of listeners) {
      renderer.removeListener("did-start-navigation", listener.navigate);
      renderer.removeListener("destroyed", listener.destroyed);
    }
    listeners.clear();
    controller.dispose();
  };
}

import { createElectronAppShotService } from "./app-shot.js";
