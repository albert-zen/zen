/** Design alternative A. Deliberately NOT imported by production code. */
export interface TargetIdentity {
  pid: number;
  processStartedAt: string;
  windowId: number;
}
export interface DesktopPoint {
  x: number;
  y: number;
}
export interface WindowSnapshot {
  target: TargetIdentity;
  foreground: TargetIdentity;
  bounds: { x: number; y: number; width: number; height: number };
}
export type InputAction =
  | { kind: "key"; key: "enter" | "escape" | "tab" | "space" }
  | { kind: "click"; point: DesktopPoint; button: "left" | "right" }
  | { kind: "scroll"; point: DesktopPoint; deltaPixels: number };

function sameTarget(a: TargetIdentity, b: TargetIdentity): boolean {
  return (
    a.pid === b.pid &&
    a.processStartedAt === b.processStartedAt &&
    a.windowId === b.windowId
  );
}

/** This is preflight rejection, not atomic OS recipient isolation. */
export async function explicitTargetInput(
  target: TargetIdentity,
  action: InputAction,
  port: {
    readWindow(target: TargetIdentity): Promise<WindowSnapshot>;
    beforePost?(): void;
    postOnce(
      action: InputAction,
      expectedTarget: TargetIdentity,
    ): Promise<void>;
  },
  signal: AbortSignal,
): Promise<{ dispatch: "posted"; applicationEffect: "unverified" }> {
  if (
    !Number.isSafeInteger(target.pid) ||
    target.pid <= 0 ||
    !Number.isSafeInteger(target.windowId) ||
    target.windowId <= 0 ||
    !target.processStartedAt
  )
    throw new Error("invalid target identity");
  // Never retain a caller-mutable reference across observation awaits.
  const expected = { ...target };
  const input = structuredClone(action);
  signal.throwIfAborted();
  const snapshot = await port.readWindow(expected);
  signal.throwIfAborted();
  if (
    !sameTarget(expected, snapshot.target) ||
    !sameTarget(expected, snapshot.foreground)
  )
    throw new Error("target changed; no input dispatched");
  if (input.kind !== "key") {
    const b = snapshot.bounds;
    const p = input.point;
    if (
      ![p.x, p.y, b.x, b.y, b.width, b.height].every(Number.isFinite) ||
      b.width <= 0 ||
      b.height <= 0 ||
      p.x < b.x ||
      p.y < b.y ||
      p.x >= b.x + b.width ||
      p.y >= b.y + b.height
    )
      throw new Error("point is outside target window; no input dispatched");
    if (
      input.kind === "scroll" &&
      (!Number.isInteger(input.deltaPixels) ||
        input.deltaPixels === 0 ||
        Math.abs(input.deltaPixels) > 10000)
    )
      throw new Error("invalid pixel scroll; no input dispatched");
  }
  // A native adapter must repeat identity checks immediately before posting.
  // Neither check makes global CGEvent delivery atomic with foreground changes.
  signal.throwIfAborted();
  port.beforePost?.();
  try {
    await port.postOnce(input, expected);
  } catch (cause) {
    throw new Error(
      "input may have dispatched; outcome unknown; do not retry automatically",
      { cause },
    );
  }
  return { dispatch: "posted", applicationEffect: "unverified" };
}
