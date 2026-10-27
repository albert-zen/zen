import { randomUUID } from "node:crypto";
import type { ComputerTarget } from "./computer-provider.js";

export interface BoundComputerTarget {
  bindingId: string;
  /** Native runtime capability, absent on older/missing-SPI helpers. */
  windowLocalInputAvailable?: true;
  exactWindowCaptureAvailable?: true;
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
  | { operation: "key"; key: string }
  | { operation: "type"; text: string }
  | { operation: "shortcut"; key: string; modifiers: string[] }
  | { operation: "scroll"; deltaY: number };

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

  /** One left click from the existing exact capture, never a new target lookup. */
  async backgroundClick(
    owner: string,
    target: ComputerTarget,
    bindingId: string,
    captureId: string,
    x: number,
    y: number,
    signal: AbortSignal,
  ): Promise<unknown> {
    signal.throwIfAborted();
    const binding = this.#selected.get(owner),
      capture = this.#captures.get(owner);
    if (binding?.windowLocalInputAvailable !== true)
      throw new Error(
        "Selected native helper has no window-local input primitive; no input dispatched",
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
    if (action.operation === "click") {
      const capture = this.#captures.get(owner);
      if (
        !capture ||
        capture.bindingId !== binding.bindingId ||
        capture.captureId !== action.captureId
      )
        throw new Error(
          "Click requires the current window screenshot captureId; no input dispatched",
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
      if (!isPostedComputerInputReceipt(receipt))
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
