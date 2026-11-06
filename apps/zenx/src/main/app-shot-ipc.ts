import {
  APP_SHOT_DEFAULT_CHORD,
  appShotKeyChordAccelerator,
  validateAppShotKeyChord,
  appShotPortalTrigger,
} from "../app-shot-key-chord.js";
import { join } from "node:path";
import { InMemoryAttachmentStore } from "../../../../src/attachment.js";
import type { ZenXDraftAttachments } from "./draft-attachments.js";
import type { ZenXImageDraft } from "./image-attachments.js";
import type { AppShotCapture, AppShotService } from "./app-shot.js";
import { isWaylandAppShotSession } from "./app-shot.js";
import {
  isGnomeAppShotSession,
  type GnomeAppShotSupport,
} from "./app-shot-gnome.js";
import { isKdeSession, type KdeAppShotSupport } from "./app-shot-kde.js";
import {
  isHyprlandSession,
  type HyprlandAppShotState,
} from "./app-shot-hyprland.js";
import type {
  PortalAppShotShortcutHandle,
  PortalAppShotShortcutOptions,
} from "./app-shot-portal-shortcut.js";
import {
  APP_SHOT_MODIFIER_SHORTCUTS,
  isAppShotShortcutKind,
  type AppShotModifier,
  type AppShotShortcutState,
} from "../app-shot.js";
import { imageDraft } from "./image-attachments.js";
import { isTrustedImZenXSetupSender } from "./imzenx-setup-ipc.js";
import type {
  AppShotConfiguration,
  AppShotEvent,
  AppShotShortcutKind,
} from "../app-shot.js";
import { startAppShotModifierPair } from "./app-shot-shortcut.js";

import { niriSocketPath, checkNiriCaptureSupport } from "./app-shot-niri.js";
import {
  niriAppShotBinding,
  startNiriAppShotShortcut,
} from "./app-shot-niri-shortcut.js";

const CHANNELS = {
  beginRecording: "zenx:app-shot:begin-recording",
  endRecording: "zenx:app-shot:end-recording",
  configureShortcut: "zenx:app-shot:configure-shortcut",
  configuration: "zenx:app-shot:configuration",
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
  portalSupport?(signal: AbortSignal): Promise<boolean>;
  gnomeSupport?(signal: AbortSignal): Promise<GnomeAppShotSupport>;
  kdeSupport?(signal: AbortSignal): Promise<KdeAppShotSupport>;
  hyprlandSupport?(signal: AbortSignal): Promise<HyprlandAppShotState>;
  hyprlandBinding?: AppShotConfiguration["hyprlandBinding"];
  startPortalShortcut?(
    options: PortalAppShotShortcutOptions,
  ): Promise<PortalAppShotShortcutHandle>;
  niriBinding?: string;
  startNiriShortcut?(options: {
    signal: AbortSignal;
    isCurrentOwner(): boolean;
    onCapture(): void;
    onFailure(error: Error): void;
  }): Promise<{ stop(): void }>;
  rendererUrl: string;
  trusted(caller: AppShotCaller<Renderer, Frame>): {
    ownedWindow: boolean;
    mainFrame: boolean;
    url: string;
  };
  createService(renderer: Renderer): AppShotService;
  preparePreview(capture: AppShotCapture): Promise<ZenXImageDraft>;
  importCapture(
    capture: AppShotCapture,
    renderer: Renderer,
  ): Promise<ZenXImageDraft>;
  abandonCapture(renderer: Renderer, draft: ZenXImageDraft): Promise<void>;
  registerShortcut(accelerator: string, callback: () => void): boolean;
  unregisterShortcut(accelerator: string): void;
  startModifierPair?(options: {
    modifier: AppShotModifier;
    onTrigger(): void;
    onFailure(error: unknown): void;
    signal: AbortSignal;
  }): Promise<{ stop(): Promise<void> }>;
  sendCaptured(renderer: Renderer, payload: AppShotEvent): void;
  focus(renderer: Renderer): void;
  isFocused?(renderer: Renderer): boolean;
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
  abort: AbortController;
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
  registeredAccelerator?: string;
  abort: AbortController;
  modifierPair?: Promise<{ stop(): Promise<void> }>;
  portal?: PortalAppShotShortcutHandle;
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
  #recording?: { caller: Caller<Renderer, Frame>; token: string };
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
        abort: new AbortController(),
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

  async configuration(
    caller: Caller<Renderer, Frame>,
  ): Promise<AppShotConfiguration> {
    const session = this.#require(caller);
    // The host injects only the applicable Wayland backend. These probes never
    // install a helper, request a screenshot, or register a shortcut.
    const kdeSupport = this.#deps.kdeSupport
      ? await this.#deps.kdeSupport(session.abort.signal)
      : undefined;
    const hyprlandSupport = this.#deps.hyprlandSupport
      ? await this.#deps.hyprlandSupport(session.abort.signal)
      : undefined;
    const gnomeSupport = this.#deps.gnomeSupport
      ? await this.#deps.gnomeSupport(session.abort.signal)
      : undefined;
    if (!this.#still(caller, session))
      throw new Error("App Shot renderer changed during capability check");
    // Match capture routing: native failure is not absence. Hyprland version
    // probe failures are update-required, and may be denial/transport errors.
    const nativeCaptureError =
      kdeSupport?.status === "error"
        ? kdeSupport.message
        : hyprlandSupport?.status === "error" ||
            hyprlandSupport?.status === "update-required"
          ? hyprlandSupport.message
          : undefined;
    const nativeBlocked =
      kdeSupport?.status === "error" ||
      hyprlandSupport?.status === "error" ||
      hyprlandSupport?.status === "update-required";
    const nativeForeground =
      !nativeBlocked &&
      (kdeSupport?.status === "ready" ||
        hyprlandSupport?.status === "ready" ||
        gnomeSupport?.status === "ready" ||
        (this.#deps.portalSupport
          ? await this.#deps.portalSupport(session.abort.signal)
          : session.service.hasNativeActiveCapture === true));
    if (!this.#still(caller, session))
      throw new Error("App Shot renderer changed during capability check");
    return {
      nativeForeground,
      ...(gnomeSupport ? { gnomeSupport: gnomeSupport.status } : {}),
      ...(kdeSupport ? { kdeSupport: kdeSupport.status } : {}),
      ...(hyprlandSupport ? { hyprlandSupport: hyprlandSupport.status } : {}),
      ...(nativeCaptureError ? { nativeCaptureError } : {}),
      ...(this.#deps.hyprlandBinding
        ? { hyprlandBinding: this.#deps.hyprlandBinding }
        : {}),
      ...(this.#deps.startPortalShortcut
        ? { portalShortcut: true as const }
        : {}),
      ...(this.#deps.niriBinding
        ? { niriBinding: this.#deps.niriBinding }
        : {}),
    };
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
    let draft: ZenXImageDraft | undefined;
    try {
      draft = await this.#deps.importCapture(preview.capture, caller.renderer);
      if (!this.#still(caller, session))
        throw new Error("App Shot renderer changed during attach");
      if (session.previews.get(preview.draft.id) !== preview)
        throw new Error("App Shot preview was discarded");
      this.#removePreview(session, preview.draft.id);
      return draft;
    } catch (error) {
      preview.attaching = false;
      if (draft) await this.#deps.abandonCapture(caller.renderer, draft);
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

  /** UI admission only: no OS key registration, observation or capture suppression. */
  beginRecording(caller: Caller<Renderer, Frame>, token: unknown): void {
    if (typeof token !== "string" || !/^[\x21-\x7e]{1,80}$/u.test(token))
      throw new Error("Invalid App Shot recording token");
    this.#require(caller);
    if (this.#owner)
      throw new Error(
        "Disable the active App Shot shortcut in its Composer before recording.",
      );
    if (
      this.#recording &&
      (this.#recording.caller.renderer !== caller.renderer ||
        this.#recording.caller.frame !== caller.frame ||
        this.#recording.token !== token)
    )
      throw new Error(
        "Another Composer is recording an App Shot shortcut. Finish or cancel it first.",
      );
    this.#recording = { caller, token };
  }

  endRecording(caller: Caller<Renderer, Frame>, token: unknown): void {
    if (typeof token !== "string" || !/^[\x21-\x7e]{1,80}$/u.test(token))
      throw new Error("Invalid App Shot recording token");
    this.#require(caller);
    if (
      this.#recording?.caller.renderer === caller.renderer &&
      this.#recording.caller.frame === caller.frame &&
      this.#recording.token === token
    )
      this.#recording = undefined;
  }

  async arm(
    caller: Caller<Renderer, Frame>,
    token: unknown,
    includeAccessibility: unknown,
    kind: unknown = "chord",
    chord: unknown = undefined,
  ): Promise<string | AppShotShortcutState> {
    if (
      typeof token !== "string" ||
      !/^[\x21-\x7e]{1,80}$/u.test(token) ||
      typeof includeAccessibility !== "boolean" ||
      !isAppShotShortcutKind(kind)
    )
      throw new Error("Invalid App Shot shortcut request");
    if (
      kind !== "chord" &&
      this.#deps.platform !== "darwin" &&
      this.#deps.platform !== "win32"
    )
      throw new Error(
        "Physical modifier pairs are available only on macOS and Windows",
      );
    if (
      chord !== undefined &&
      (kind !== "chord" || this.#deps.niriBinding || this.#deps.hyprlandBinding)
    )
      throw new Error(
        "Custom chords are not available for this shortcut action",
      );
    const normalized = validateAppShotKeyChord(
      chord === undefined ? APP_SHOT_DEFAULT_CHORD : chord,
      this.#deps.platform,
    );
    // Validate portal key support before changing the current owner or requesting consent.
    if (this.#deps.startPortalShortcut && !this.#deps.hyprlandBinding)
      appShotPortalTrigger(normalized);
    const accelerator = appShotKeyChordAccelerator(normalized);
    const session = this.#require(caller);
    if (this.#recording)
      throw new Error(
        "Finish or cancel App Shot shortcut recording before enabling capture.",
      );
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
      if (kind !== "chord") {
        if (!this.#deps.startModifierPair)
          throw new Error("App Shot modifier shortcut is unavailable");
        owner.modifierPair = this.#deps.startModifierPair({
          modifier: APP_SHOT_MODIFIER_SHORTCUTS[kind],
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
      } else if (this.#deps.platform === "linux" && this.#deps.niriBinding) {
        if (!this.#deps.startNiriShortcut)
          throw new Error("Niri App Shot shortcut is unavailable");
        owner.modifierPair = this.#deps
          .startNiriShortcut({
            signal: owner.abort.signal,
            isCurrentOwner: () =>
              this.#owner === owner && this.#still(caller, session),
            onCapture: () => {
              if (this.#owner === owner) void this.onShortcut();
            },
            onFailure: (error) => this.#modifierFailed(owner, error),
          })
          .then((handle) => ({ stop: async () => handle.stop() }));
        await owner.modifierPair;
        if (this.#owner !== owner || !this.#still(caller, session)) {
          await this.#stopModifierPair(owner);
          throw new Error("App Shot shortcut was cancelled");
        }
      } else if (
        this.#deps.platform === "linux" &&
        this.#deps.startPortalShortcut
      ) {
        owner.modifierPair = this.#deps
          .startPortalShortcut({
            ...(!this.#deps.hyprlandBinding ? { chord: normalized } : {}),
            signal: owner.abort.signal,
            isCurrentOwner: () =>
              this.#owner === owner && this.#still(caller, session),
            onCapture: () => {
              if (this.#owner === owner) void this.onShortcut();
            },
            onFailure: (error) => this.#modifierFailed(owner, error),
            onStateChanged: (shortcutState) => {
              if (this.#owner === owner && this.#still(caller, session))
                this.#deps.sendCaptured(caller.renderer, {
                  token,
                  shortcutState,
                });
            },
          })
          .then((handle) => {
            owner.portal = handle;
            return { stop: async () => handle.stop() };
          });
        await owner.modifierPair;
        if (this.#owner !== owner || !this.#still(caller, session)) {
          await this.#stopModifierPair(owner);
          throw new Error("App Shot shortcut was cancelled");
        }
        return portalShortcutState(owner.portal!);
      } else {
        if (
          !this.#deps.registerShortcut(accelerator, () => {
            if (this.#owner === owner) void this.onShortcut();
          })
        )
          throw new Error("App Shot shortcut is unavailable");
        owner.registeredAccelerator = accelerator;
      }
      const mac = this.#deps.platform === "darwin";
      const pairLabels = {
        "both-shift": "Shift",
        "both-control": "Control",
        "both-alt": mac ? "Option" : "Alt",
        "both-meta": mac ? "Command" : "Windows",
      };
      return kind !== "chord"
        ? `Left ${pairLabels[kind]} + Right ${pairLabels[kind]}`
        : accelerator === appShotKeyChordAccelerator(APP_SHOT_DEFAULT_CHORD)
          ? mac
            ? "⌘⇧2"
            : "Ctrl+Shift+2"
          : accelerator;
    } catch (error) {
      if (this.#owner === owner) await this.#clearOwner();
      throw error;
    }
  }

  async configureShortcut(
    caller: Caller<Renderer, Frame>,
    token: unknown,
  ): Promise<AppShotShortcutState> {
    this.#require(caller);
    const owner = this.#owner;
    if (
      !owner?.portal ||
      owner.caller.renderer !== caller.renderer ||
      owner.caller.frame !== caller.frame ||
      owner.token !== token
    )
      throw new Error("No current App Shot shortcut session to configure");
    await owner.portal.configure();
    if (this.#owner !== owner || !this.#still(caller, owner.session))
      throw new Error("App Shot shortcut was cancelled");
    return portalShortcutState(owner.portal);
  }

  #modifierFailed(owner: Owner<Renderer, Frame>, error: unknown): void {
    if (this.#owner !== owner) return;
    const valid = this.#still(owner.caller, owner.session);
    void this.#clearOwner().catch(() => {});
    if (!valid) return;
    const message =
      error instanceof Error ? error.message : "App Shot shortcut stopped";
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
    if (owner?.registeredAccelerator) {
      this.#deps.unregisterShortcut(owner.registeredAccelerator);
      owner.registeredAccelerator = undefined;
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
    if (this.#recording?.caller.renderer === renderer)
      this.#recording = undefined;
    const session = this.#sessions.get(renderer);
    session?.abort.abort();
    if (session)
      for (const id of session.previews.keys())
        this.#removePreview(session, id);
    this.#sessions.delete(renderer);
    if (this.#owner?.caller.renderer === renderer)
      void this.#clearOwner().catch(() => {});
  }

  dispose(): void {
    this.#recording = undefined;
    void this.#clearOwner().catch(() => {});
    for (const renderer of this.#sessions.keys()) this.forget(renderer);
    this.#sessions.clear();
  }

  async onShortcut(): Promise<void> {
    const owner = this.#owner;
    if (
      !owner ||
      owner.pending ||
      (owner.portal &&
        !owner.portal.registered &&
        !owner.portal.actionRegistered)
    )
      return;
    if (!this.#still(owner.caller, owner.session)) {
      this.forget(owner.caller.renderer);
      return;
    }
    if (
      (owner.portal && this.#deps.isFocused?.(owner.caller.renderer)) ||
      (this.#deps.platform === "linux" &&
        !owner.session.service.hasNativeActiveCapture)
    ) {
      // A foreground ZenX portal trigger preserves the local picker shortcut.
      // Never parse a localized trigger_description to guess key identity.
      this.#deps.sendCaptured(owner.caller.renderer, {
        token: owner.token,
        openPicker: true,
      });
      this.#deps.focus(owner.caller.renderer);
      return;
    }
    owner.pending = true;
    try {
      // Observe before raising ZenX. Identity-aware backends exclude owned windows;
      // generic portal pixels contain no identity we can use for that exclusion.
      const capture = await owner.session.service.captureActive({
        includeAccessibility: owner.includeAccessibility,
        signal: owner.abort.signal,
      });
      if (this.#owner !== owner || !this.#still(owner.caller, owner.session))
        return;
      if (!capture) {
        // Only absent capability returns undefined. Denial/cancellation throws.
        this.#deps.sendCaptured(owner.caller.renderer, {
          token: owner.token,
          openPicker: true,
        });
        this.#deps.focus(owner.caller.renderer);
        return;
      }
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
  attachments: Pick<ZenXDraftAttachments, "importImages" | "abandon">;
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
  const portal =
    process.platform === "linux" &&
    isWaylandAppShotSession() &&
    !niriSocketPath();
  const kde = portal && isKdeSession();
  const hyprland = portal && !kde && isHyprlandSession();
  const appId = app.isPackaged
    ? "io.github.albert_zen.ZenX"
    : "io.github.albert_zen.ZenX.Development";
  const controller = new AppShotIpcController<Renderer, Frame>({
    ...(kde
      ? {
          kdeSupport: async (signal: AbortSignal) => {
            const { getKdeAppShotSupport } = await import("./app-shot-kde.js");
            return getKdeAppShotSupport({ signal });
          },
        }
      : {}),
    ...(hyprland
      ? {
          hyprlandSupport: async (signal: AbortSignal) => {
            const { getHyprlandAppShotState } =
              await import("./app-shot-hyprland.js");
            return getHyprlandAppShotState({ signal });
          },
          hyprlandBinding: {
            legacy: `bind = CTRL SHIFT, 2, global, ${appId}:capture-window`,
            lua: `hl.bind("CTRL + SHIFT + 2", hl.dsp.global("${appId}:capture-window"))`,
          },
        }
      : {}),
    ...(portal && !kde && !hyprland && isGnomeAppShotSession()
      ? {
          gnomeSupport: async (signal: AbortSignal) => {
            const { checkGnomeAppShotSupport } =
              await import("./app-shot-gnome.js");
            return checkGnomeAppShotSupport({ signal });
          },
        }
      : {}),
    ...(portal
      ? {
          portalSupport: async (signal: AbortSignal) => {
            const { getPortalAppShotSupport } =
              await import("./app-shot-portal.js");
            return getPortalAppShotSupport({
              appId,
              signal,
            });
          },
          startPortalShortcut: async (
            shortcutOptions: PortalAppShotShortcutOptions,
          ) => {
            const { startPortalAppShotShortcut } =
              await import("./app-shot-portal-shortcut.js");
            return startPortalAppShotShortcut({
              ...shortcutOptions,
              development: !app.isPackaged,
              managedByHyprland: hyprland,
            });
          },
        }
      : {}),
    platform: process.platform,
    niriBinding:
      process.platform === "linux" && niriSocketPath()
        ? niriAppShotBinding(!app.isPackaged)
        : undefined,
    startNiriShortcut: async (shortcutOptions) => {
      const socket = niriSocketPath();
      if (process.platform !== "linux" || !socket)
        throw new Error("Niri App Shot is unavailable in this session");
      await checkNiriCaptureSupport(socket, shortcutOptions.signal);
      return startNiriAppShotShortcut({
        ...shortcutOptions,
        development: !app.isPackaged,
      });
    },
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
    async importCapture(capture, renderer) {
      const [draft] = await options.attachments.importImages(renderer.id, [
        {
          name: capture.name,
          mediaType: capture.mediaType,
          bytes: capture.bytes,
        },
      ]);
      if (!draft) throw new Error("App Shot draft import returned no image");
      return { ...draft, appShotContext: capture.context };
    },
    async abandonCapture(renderer, draft) {
      await options.attachments.abandon(renderer.id, [draft.id]);
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
    isFocused(renderer) {
      return BrowserWindow.fromWebContents(renderer)?.isFocused() === true;
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
  ipcMain.handle(CHANNELS.configuration, (event) =>
    controller.configuration(caller(event)),
  );
  ipcMain.handle(CHANNELS.beginRecording, (event, token: unknown) =>
    controller.beginRecording(caller(event), token),
  );
  ipcMain.handle(CHANNELS.endRecording, (event, token: unknown) =>
    controller.endRecording(caller(event), token),
  );
  ipcMain.handle(CHANNELS.configureShortcut, (event, token: unknown) =>
    controller.configureShortcut(caller(event), token),
  );
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
    (
      event,
      token: unknown,
      includeAccessibility: unknown,
      kind: unknown,
      chord: unknown,
    ) =>
      controller.arm(caller(event), token, includeAccessibility, kind, chord),
  );
  ipcMain.handle(CHANNELS.disarm, (event, token: unknown) =>
    controller.disarm(caller(event), token),
  );
  return () => {
    for (const channel of [
      CHANNELS.configuration,
      CHANNELS.beginRecording,
      CHANNELS.endRecording,
      CHANNELS.configureShortcut,
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

function portalShortcutState(
  handle: PortalAppShotShortcutHandle,
): AppShotShortcutState {
  return {
    registered: handle.registered,
    ...(handle.actionRegistered !== undefined
      ? { actionRegistered: handle.actionRegistered }
      : {}),
    shortcutDescription: handle.shortcutDescription,
    canConfigure: handle.canConfigure,
  };
}
