import { randomUUID } from "node:crypto";
import type { ComputerTarget } from "./computer-provider.js";

export interface BoundComputerTarget {
  bindingId: string;
  target: {
    pid: number;
    applicationName: string;
    bundleId?: string;
    windowTitle: string;
  };
  windowId: number;
  bounds: { x: number; y: number; width: number; height: number };
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
  readonly #captures = new Map<
    string,
    { bindingId: string; captureId: string; width: number; height: number }
  >();
  constructor(readonly transport: TargetTransport) {}

  async select(
    owner: string,
    target: ComputerTarget,
    signal: AbortSignal,
  ): Promise<BoundComputerTarget> {
    this.#selected.delete(owner);
    this.#captures.delete(owner);
    const result = (await this.transport.request(
      { operation: "select", owner, target },
      signal,
    )) as BoundComputerTarget;
    signal.throwIfAborted();
    this.#selected.set(owner, result);
    return result;
  }

  async capture<T extends { width: number; height: number }>(
    owner: string,
    target: ComputerTarget,
    signal: AbortSignal,
    capture: (binding: BoundComputerTarget) => Promise<T>,
  ): Promise<T & { bindingId: string; captureId: string }> {
    const binding = await this.select(owner, target, signal);
    const image = await capture(binding);
    await this.transport.request(
      { operation: "verify", owner, bindingId: binding.bindingId },
      signal,
    );
    if (this.#selected.get(owner) !== binding)
      throw new Error("Computer target changed while capturing; capture again");
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
    });
    return { ...image, bindingId: binding.bindingId, captureId };
  }

  selectedBindingId(owner: string): string {
    const binding = this.#selected.get(owner);
    if (!binding)
      throw new Error(
        "Select a Computer target before input; no input dispatched",
      );
    return binding.bindingId;
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
    try {
      await this.transport.request(
        {
          ...operation,
          owner,
          bindingId: binding.bindingId,
          pointerPassthroughWindowIds,
        },
        signal,
        onStopping,
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
    this.#selected.clear();
    this.#captures.clear();
    await this.transport.close();
  }
}
