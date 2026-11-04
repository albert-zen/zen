import { randomUUID } from "node:crypto";
import type { ComputerTarget } from "./computer-provider.js";

export interface BoundComputerTarget {
  bindingId: string;
  /** Native runtime capability, absent on older/missing-SPI helpers. */
  windowLocalInputAvailable?: true;
  /** Explicit helper handshake; old helpers silently ignore unknown button fields. */
  supportedBackgroundButtons?: Array<"left" | "right" | "middle">;
  exactWindowCaptureAvailable?: true;
  appKeyboardInputAvailable?: true;
  appShortcutInputAvailable?: true;
  /** Selection-time AX readiness, not a permission or an input-effect guarantee. */
  foregroundWindowInputAvailable?: boolean;
  /** Native routes are independently revalidated at dispatch; no implicit fallback. */
  inputCapabilities?: {
    availabilityIsSnapshot: true;
    foregroundWindow: {
      available: boolean;
      scope: "exact_window";
      requires: "matched_ax_window";
    };
    backgroundWindow: {
      available: boolean;
      scope: "exact_window";
      requires: "fresh_native_capture";
    };
    applicationKeyboard: {
      available: boolean;
      scope: "application_current_focus";
    };
  };
  target: {
    pid: number;
    applicationName: string;
    bundleId?: string;
    windowTitle: string;
  };
  windowId: number;
  bounds: { x: number; y: number; width: number; height: number };
}
export interface ComputerCaptureImage {
  width: number;
  height: number;
  artifactPath?: string;
  bytes?: number;
  imageSha256?: string;
  capturedAt?: string;
  captureSource?:
    | "native_sck_exact_window"
    | "native_window_server_exact_window"
    | "legacy_desktop_capturer";
  backgroundInputEligible?: boolean;
  expiresAt?: string;
}

export interface TargetTransport {
  request(
    request: Record<string, unknown>,
    signal: AbortSignal,
    onStopping?: () => void,
  ): Promise<unknown>;
  close(): Promise<void>;
}
export type BoundComputerInput =
  | {
      operation: "click";
      x: number;
      y: number;
      button: "left" | "right";
      captureId: string;
    }
  | {
      operation: "drag";
      x: number;
      y: number;
      toX: number;
      toY: number;
      captureId: string;
    }
  | { operation: "key"; key: string }
  | { operation: "type"; text: string }
  | { operation: "shortcut"; key: string; modifiers: string[] }
  | { operation: "scroll"; deltaY: number };

/** Layout-independent macOS virtual keys; printable text uses Unicode input instead. */
export const COMPUTER_NATIVE_KEY_CODES = {
  enter: 36,
  escape: 53,
  tab: 48,
  backspace: 51,
  space: 49,
  arrowUp: 126,
  arrowDown: 125,
  arrowLeft: 123,
  arrowRight: 124,
  delete: 117,
  home: 115,
  end: 119,
  pageUp: 116,
  pageDown: 121,
  f1: 122,
  f2: 120,
  f3: 99,
  f4: 118,
  f5: 96,
  f6: 97,
  f7: 98,
  f8: 100,
  f9: 101,
  f10: 109,
  f11: 103,
  f12: 111,
  f13: 105,
  f14: 107,
  f15: 113,
  f16: 106,
  f17: 64,
  f18: 79,
  f19: 80,
  f20: 90,
} as const;
export const COMPUTER_BASIC_KEYS = Object.keys(COMPUTER_NATIVE_KEY_CODES);
export function validateComputerAppText(text: string): void {
  if (!text || Array.from(text).length > 1024 || /[\uD800-\uDFFF]/u.test(text))
    throw new Error("text must contain 1 to 1024 well-formed Unicode scalars");
}

/** Ephemeral per-provider, per-thread native target selection. Never persisted or inferred from the foreground app. */
export class ComputerTargetSession {
  readonly #selected = new Map<string, BoundComputerTarget>();
  #closed = false;
  #captureGeneration = 0;
  readonly #captures = new Map<
    string,
    {
      bindingId: string;
      captureId: string;
      width: number;
      height: number;
      image: ComputerCaptureImage;
      targetKey: string;
    }
  >();
  constructor(readonly transport: TargetTransport) {}

  async select(
    owner: string,
    target: ComputerTarget,
    signal: AbortSignal,
  ): Promise<BoundComputerTarget> {
    signal.throwIfAborted();
    if (this.#closed) throw new Error("Computer target session is closed");
    const generation = this.#captureGeneration;
    this.#selected.delete(owner);
    this.#captures.delete(owner);
    const result = (await this.transport.request(
      { operation: "select", owner, target },
      signal,
    )) as BoundComputerTarget;
    signal.throwIfAborted();
    if (this.#closed) throw new Error("Computer target session is closed");
    if (generation !== this.#captureGeneration)
      throw new Error(
        "Computer selection retired while the desktop session changed; select again",
      );
    this.#selected.set(owner, result);
    return result;
  }

  async capture<T extends ComputerCaptureImage>(
    owner: string,
    target: ComputerTarget,
    signal: AbortSignal,
    capture: (binding: BoundComputerTarget) => Promise<T>,
  ): Promise<T & { bindingId: string; captureId: string }> {
    const binding = await this.select(owner, target, signal);
    const generation = this.#captureGeneration;
    const assertCurrent = () => {
      signal.throwIfAborted();
      if (
        this.#closed ||
        this.#selected.get(owner) !== binding ||
        generation !== this.#captureGeneration
      )
        throw new Error(
          "Computer target changed while capturing; capture again",
        );
    };
    const image = await capture(binding);
    assertCurrent();
    await this.transport.request(
      { operation: "verify", owner, bindingId: binding.bindingId },
      signal,
    );
    assertCurrent();
    if (![image.width, image.height].every((v) => Number.isFinite(v) && v > 0))
      throw new Error("Invalid capture dimensions");
    // Electron must supply an uncropped full-window image; reject incoherent aspect ratios.
    const expectedHeight =
      (image.width * binding.bounds.height) / binding.bounds.width;
    if (Math.abs(expectedHeight - image.height) > 2)
      throw new Error(
        "Capture geometry is not coherent with the selected full window; cannot bind coordinates",
      );
    const captureId = randomUUID();
    this.#captures.set(owner, {
      bindingId: binding.bindingId,
      captureId,
      width: image.width,
      height: image.height,
      image,
      targetKey: captureTargetKey(target),
    });
    return { ...image, bindingId: binding.bindingId, captureId };
  }

  /** Read the existing exact capture; neither recaptures nor renews its age. */
  async readCapture<T>(
    owner: string,
    target: ComputerTarget,
    captureId: string,
    signal: AbortSignal,
    read: (
      image: ComputerCaptureImage,
      binding: BoundComputerTarget,
    ) => Promise<T>,
  ): Promise<T> {
    const capture = this.#captures.get(owner);
    const binding = this.#selected.get(owner);
    const assertCurrent = () => {
      signal.throwIfAborted();
      if (
        !capture ||
        !binding ||
        this.#captures.get(owner) !== capture ||
        this.#selected.get(owner) !== binding ||
        capture.captureId !== captureId ||
        capture.bindingId !== binding.bindingId ||
        (capture.targetKey !== captureTargetKey(target) &&
          captureTargetKey(binding.target) !== captureTargetKey(target)) ||
        !capture.image.expiresAt ||
        !Number.isFinite(Date.parse(capture.image.expiresAt)) ||
        Date.parse(capture.image.expiresAt) <= Date.now()
      )
        throw new Error(
          "OCR requires this thread's current, unexpired screenshot of the same target; capture again",
        );
    };
    assertCurrent();
    await this.transport.request(
      { operation: "verify", owner, bindingId: binding!.bindingId },
      signal,
    );
    assertCurrent();
    const result = await read(capture!.image, binding!);
    assertCurrent();
    await this.transport.request(
      { operation: "verify", owner, bindingId: binding!.bindingId },
      signal,
    );
    assertCurrent();
    return result;
  }

  /** One button pair from the existing exact capture, never a new target lookup. */
  async backgroundClick(
    owner: string,
    target: ComputerTarget,
    bindingId: string,
    captureId: string,
    x: number,
    y: number,
    signal: AbortSignal,
    button: "left" | "right" | "middle" = "left",
  ): Promise<unknown> {
    signal.throwIfAborted();
    if (!["left", "right", "middle"].includes(button))
      throw new Error(
        "Unsupported background mouse button; no input dispatched",
      );
    const binding = this.#selected.get(owner),
      capture = this.#captures.get(owner);
    if (binding?.windowLocalInputAvailable !== true)
      throw new Error(
        "Selected native helper has no window-local input primitive; no input dispatched",
      );
    if (
      button !== "left" &&
      (!Array.isArray(binding.supportedBackgroundButtons) ||
        !binding.supportedBackgroundButtons.includes(button))
    )
      throw new Error(
        "Selected native helper does not advertise this background mouse button; no input dispatched",
      );
    if (
      this.#closed ||
      !binding ||
      !capture ||
      binding.bindingId !== bindingId ||
      capture.bindingId !== bindingId ||
      capture.captureId !== captureId ||
      (capture.targetKey !== captureTargetKey(target) &&
        captureTargetKey(binding.target) !== captureTargetKey(target)) ||
      !capture.image.expiresAt ||
      !Number.isFinite(Date.parse(capture.image.expiresAt)) ||
      Date.parse(capture.image.expiresAt) <= Date.now()
    )
      throw new Error(
        "Background click requires this owner's current unexpired exact-window capture; no input dispatched",
      );
    if (
      capture.image.backgroundInputEligible !== true ||
      ![
        "native_sck_exact_window",
        "native_window_server_exact_window",
      ].includes(capture.image.captureSource ?? "")
    )
      throw new Error(
        "This legacy/read-only capture is not eligible for background input; no input dispatched",
      );
    if (
      !Number.isFinite(x) ||
      !Number.isFinite(y) ||
      x < 0 ||
      y < 0 ||
      x >= capture.width ||
      y >= capture.height
    )
      throw new Error("Click is outside captured image; no input dispatched");
    // Consume before awaiting native work; no uncertain action can reuse this image.
    this.#captures.delete(owner);
    try {
      const receipt = await this.transport.request(
        {
          operation: "backgroundClick",
          owner,
          bindingId,
          button,
          x: binding.bounds.x + (x * binding.bounds.width) / capture.width,
          y: binding.bounds.y + (y * binding.bounds.height) / capture.height,
        },
        signal,
      );
      if (
        !isPostedComputerInputReceipt(receipt) ||
        (receipt as { release?: unknown }).release !== "posted"
      )
        throw new Error(
          "Invalid native input receipt; input outcome unknown; do not retry automatically",
        );
      return receipt;
    } catch (error) {
      if (this.#selected.get(owner) === binding) this.#selected.delete(owner);
      throw error;
    }
  }

  async backgroundType(
    owner: string,
    bindingId: string,
    text: string,
    signal: AbortSignal,
    onStopping?: () => void,
  ): Promise<unknown> {
    validateComputerAppText(text);
    return this.#appKeyboard(
      owner,
      bindingId,
      { operation: "backgroundType", text },
      signal,
      onStopping,
    );
  }

  async backgroundKeyPress(
    owner: string,
    bindingId: string,
    key: string,
    signal: AbortSignal,
    onStopping?: () => void,
  ): Promise<unknown> {
    if (!(COMPUTER_BASIC_KEYS as readonly string[]).includes(key))
      throw new Error("Unsupported background app key");
    return this.#appKeyboard(
      owner,
      bindingId,
      { operation: "backgroundKeyPress", key },
      signal,
      onStopping,
    );
  }

  async backgroundShortcut(
    owner: string,
    bindingId: string,
    shortcut: { key: string; modifiers: string[] },
    signal: AbortSignal,
    onStopping?: () => void,
  ): Promise<unknown> {
    const action = requiredComputerShortcut(shortcut);
    return this.#appKeyboard(
      owner,
      bindingId,
      { operation: "backgroundShortcut", ...action },
      signal,
      onStopping,
    );
  }

  async #appKeyboard(
    owner: string,
    bindingId: string,
    action: Record<string, unknown>,
    signal: AbortSignal,
    onStopping?: () => void,
  ): Promise<unknown> {
    signal.throwIfAborted();
    const binding = this.#selected.get(owner);
    if (this.#closed || !binding || binding.bindingId !== bindingId)
      throw new Error(
        "Selected application binding changed or expired; select again; no input dispatched",
      );
    if (
      binding.appKeyboardInputAvailable !== true ||
      (action.operation === "backgroundShortcut" &&
        binding.appShortcutInputAvailable !== true)
    )
      throw new Error(
        "Selected helper has no app keyboard capability; no input dispatched",
      );
    this.invalidateCaptures();
    try {
      const receipt = await this.transport.request(
        { ...action, owner, bindingId },
        signal,
        onStopping,
      );
      if (
        !isPostedComputerInputReceipt(receipt) ||
        (receipt as { release?: unknown }).release !== "posted" ||
        (receipt as { targetScope?: unknown }).targetScope !==
          "application_current_focus"
      )
        throw new Error(
          "Invalid app keyboard receipt; input outcome unknown; do not retry automatically",
        );
      return receipt;
    } catch (error) {
      if (this.#selected.get(owner) === binding) this.#selected.delete(owner);
      throw error;
    }
  }

  /** Identity label only; this intentionally discards the original window. */
  selectedApplication(
    owner: string,
    bindingId: string,
  ): ComputerTarget | undefined {
    const target = this.selectedTarget(owner, bindingId);
    if (!target) return;
    const { windowTitle: _window, ...application } = target;
    return application;
  }

  invalidateSelections(): void {
    this.#selected.clear();
    this.invalidateCaptures();
  }

  invalidateCaptures(): void {
    this.#captureGeneration++;
    this.#captures.clear();
  }

  selectedBindingId(owner: string): string {
    const binding = this.#selected.get(owner);
    if (!binding)
      throw new Error(
        "Select a Computer target before input; no input dispatched",
      );
    return binding.bindingId;
  }

  /** Read-only activity label; does not select, renew or authorize a target. */
  selectedTarget(
    owner: string,
    expectedBindingId?: string,
  ): ComputerTarget | undefined {
    const binding = this.#selected.get(owner);
    if (
      this.#closed ||
      !binding ||
      (expectedBindingId !== undefined &&
        binding.bindingId !== expectedBindingId)
    )
      return;
    return structuredClone(binding.target);
  }

  async input(
    owner: string,
    action: BoundComputerInput,
    signal: AbortSignal,
    onStopping?: () => void,
    expectedBindingId?: string,
    pointerPassthroughWindowIds: readonly number[] = [],
  ): Promise<void> {
    const binding = this.#selected.get(owner);
    if (!binding)
      throw new Error(
        "Select a Computer target or screenshot its window before input; no input dispatched",
      );
    if (
      expectedBindingId !== undefined &&
      binding.bindingId !== expectedBindingId
    ) {
      throw new Error(
        "Computer target changed while input awaited approval/takeover; no input dispatched",
      );
    }
    let operation: Record<string, unknown> = { ...action };
    if (action.operation === "click" || action.operation === "drag") {
      const capture = this.#captures.get(owner);
      if (
        !capture ||
        capture.bindingId !== binding.bindingId ||
        capture.captureId !== action.captureId
      )
        throw new Error(
          "Pointer input requires the current window screenshot captureId; no input dispatched",
        );
      if (
        !Number.isFinite(action.x) ||
        !Number.isFinite(action.y) ||
        action.x < 0 ||
        action.y < 0 ||
        action.x >= capture.width ||
        action.y >= capture.height
      )
        throw new Error("Click is outside captured image; no input dispatched");
      operation = {
        ...action,
        x: binding.bounds.x + (action.x * binding.bounds.width) / capture.width,
        y:
          binding.bounds.y +
          (action.y * binding.bounds.height) / capture.height,
      };
      if (action.operation === "drag") {
        if (
          !capture.image.expiresAt ||
          !Number.isFinite(Date.parse(capture.image.expiresAt)) ||
          Date.parse(capture.image.expiresAt) <= Date.now()
        )
          throw new Error(
            "Drag requires an unexpired screenshot; no input dispatched",
          );
        if (
          !Number.isFinite(action.toX) ||
          !Number.isFinite(action.toY) ||
          action.toX < 0 ||
          action.toY < 0 ||
          action.toX >= capture.width ||
          action.toY >= capture.height
        )
          throw new Error(
            "Drag destination is outside captured image; no input dispatched",
          );
        operation.toX =
          binding.bounds.x +
          (action.toX * binding.bounds.width) / capture.width;
        operation.toY =
          binding.bounds.y +
          (action.toY * binding.bounds.height) / capture.height;
      }
    }
    // Shared-desktop input invalidates existing and still-acquiring screenshots.
    this.invalidateCaptures();
    try {
      const receipt = await this.transport.request(
        {
          ...operation,
          owner,
          bindingId: binding.bindingId,
          pointerPassthroughWindowIds,
        },
        signal,
        onStopping,
      );
      if (
        !isPostedComputerInputReceipt(receipt) ||
        (action.operation === "drag" &&
          (!receipt ||
            typeof receipt !== "object" ||
            !("release" in receipt) ||
            receipt.release !== "posted"))
      )
        throw new Error(
          "Native input receipt is invalid; input outcome unknown; do not retry automatically",
        );
    } catch (error) {
      // Refusal, cancellation and uncertain native posting all require explicit reselection.
      if (this.#selected.get(owner) === binding) {
        this.#selected.delete(owner);
        this.#captures.delete(owner);
      }
      throw error;
    }
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#selected.clear();
    this.invalidateCaptures();
    await this.transport.close();
  }
}

function captureTargetKey(target: ComputerTarget): string {
  return JSON.stringify([
    target.pid ?? null,
    target.applicationId ?? null,
    target.bundleId ?? null,
    target.windowTitle ?? null,
  ]);
}

export function isPostedComputerInputReceipt(value: unknown): boolean {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    "dispatch" in value &&
    value.dispatch === "posted" &&
    "applicationEffect" in value &&
    value.applicationEffect === "unverified"
  );
}

export function requiredComputerShortcut(arguments_: Record<string, unknown>): {
  key: string;
  modifiers: string[];
} {
  const key = arguments_.key;
  if (typeof key !== "string" || !key)
    throw new Error("Unsupported shortcut key");
  const modifiers = arguments_.modifiers;
  if (
    !(
      COMPUTER_BASIC_KEYS.includes(key) ||
      (Array.from(key).length === 1 &&
        !/[\u0000-\u0020\u007f\uD800-\uDFFF]/u.test(key))
    ) ||
    !Array.isArray(modifiers) ||
    modifiers.length < 1 ||
    modifiers.length > 4 ||
    new Set(modifiers).size !== modifiers.length ||
    !modifiers.every(
      (value): value is string =>
        typeof value === "string" &&
        ["command", "control", "option", "shift"].includes(value),
    )
  )
    throw new Error("Unsupported shortcut key or modifiers");
  return { key, modifiers };
}
