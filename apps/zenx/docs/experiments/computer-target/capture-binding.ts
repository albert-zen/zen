/** Design alternative B. Deliberately NOT imported by production code. */
import { randomUUID } from "node:crypto";
import {
  explicitTargetInput,
  type WindowSnapshot,
  type InputAction,
  type TargetIdentity,
} from "./explicit-target.js";

interface Capture {
  owner: string;
  snapshot: WindowSnapshot;
  image: { width: number; height: number };
  expiresAt: number;
}
export type ImageAction =
  | { kind: "key"; key: "enter" | "escape" | "tab" | "space" }
  | {
      kind: "click";
      imagePoint: { x: number; y: number };
      button: "left" | "right";
    }
  | {
      kind: "scroll";
      imagePoint: { x: number; y: number };
      deltaPixels: number;
    };

/** Memory-only, one-shot experimental binding; not a new durable session. */
export class CaptureBindingExperiment {
  readonly #captures = new Map<string, Capture>();
  constructor(readonly now: () => number = Date.now) {}

  retain(
    owner: string,
    snapshot: WindowSnapshot,
    image: { width: number; height: number },
  ): string {
    if (
      !owner ||
      !Number.isInteger(image.width) ||
      !Number.isInteger(image.height) ||
      image.width <= 0 ||
      image.height <= 0
    )
      throw new Error("invalid capture");
    for (const [id, capture] of this.#captures)
      if (capture.expiresAt <= this.now()) this.#captures.delete(id);
    if (this.#captures.size >= 64) throw new Error("capture budget exhausted");
    const id = randomUUID();
    this.#captures.set(
      id,
      structuredClone({
        owner,
        snapshot,
        image,
        expiresAt: this.now() + 30000,
      }),
    );
    return id;
  }

  async act(
    owner: string,
    captureId: string,
    action: ImageAction,
    port: {
      readWindow(target: TargetIdentity): Promise<WindowSnapshot>;
      postOnce(action: InputAction, expected: TargetIdentity): Promise<void>;
    },
    signal: AbortSignal,
  ) {
    const capture = this.#captures.get(captureId);
    if (!capture || capture.owner !== owner)
      throw new Error("unknown or foreign capture; no input dispatched");
    if (capture.expiresAt <= this.now()) {
      this.#captures.delete(captureId);
      throw new Error("expired capture; no input dispatched");
    }
    const assertFresh = () => {
      if (capture.expiresAt <= this.now())
        throw new Error("expired capture; no input dispatched");
    };
    // Consumption is deliberate even on later failure. Never replay uncertain input.
    this.#captures.delete(captureId);
    const input = structuredClone(action);
    const b = capture.snapshot.bounds;
    let mapped: InputAction;
    if (input.kind === "key") mapped = input;
    else {
      const p = input.imagePoint;
      if (
        ![p.x, p.y].every(Number.isFinite) ||
        p.x < 0 ||
        p.y < 0 ||
        p.x >= capture.image.width ||
        p.y >= capture.image.height
      )
        throw new Error("outside captured image; no input dispatched");
      const point = {
        x: b.x + (p.x * b.width) / capture.image.width,
        y: b.y + (p.y * b.height) / capture.image.height,
      };
      mapped =
        input.kind === "click"
          ? { kind: "click", point, button: input.button }
          : { kind: "scroll", point, deltaPixels: input.deltaPixels };
    }
    return await explicitTargetInput(
      capture.snapshot.target,
      mapped,
      {
        readWindow: async (target) => {
          const current = await port.readWindow(target);
          assertFresh();
          const c = current.bounds;
          if (
            c.x !== b.x ||
            c.y !== b.y ||
            c.width !== b.width ||
            c.height !== b.height
          )
            throw new Error("window moved or resized; recapture before input");
          return current;
        },
        beforePost: assertFresh,
        postOnce: port.postOnce,
      },
      signal,
    );
  }
}
