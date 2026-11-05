import assert from "node:assert/strict";

export interface NativeFrameIdentity {
  url: string;
  processId: number;
  osProcessId: number;
  routingId: number;
}
export interface NativeInputAttempt {
  method: string;
  type: string;
  sessionId: string;
  x?: number;
  y?: number;
}
export interface NativeChildRoute {
  sessionId: string;
  parentSessionId: string;
  targetId: string;
  url: string;
}

export function assertNativeFramePlacement(
  frames: NativeFrameIdentity[],
  mode: "nested-oopif" | "nested-same-process",
  urls: string[],
): void {
  assert.equal(frames.length, 3);
  assert.deepEqual(
    frames.map((frame) => frame.url),
    urls,
  );
  for (const frame of frames) {
    assert.ok(Number.isSafeInteger(frame.processId) && frame.processId > 0);
    assert.ok(Number.isSafeInteger(frame.osProcessId) && frame.osProcessId > 0);
  }
  assert.notEqual(frames[0]!.processId, frames[1]!.processId);
  assert.notEqual(frames[0]!.osProcessId, frames[1]!.osProcessId);
  if (mode === "nested-oopif") {
    assert.notEqual(frames[1]!.processId, frames[2]!.processId);
    assert.notEqual(frames[1]!.osProcessId, frames[2]!.osProcessId);
  } else {
    assert.equal(frames[1]!.processId, frames[2]!.processId);
    assert.equal(frames[1]!.osProcessId, frames[2]!.osProcessId);
    assert.notEqual(frames[1]!.routingId, frames[2]!.routingId);
  }
}

export function assertNativeInputRoute(
  inputs: NativeInputAttempt[],
  routes: NativeChildRoute[],
  mode: "nested-oopif" | "nested-same-process",
  urls: string[],
  kind: "click" | "key",
): void {
  const outer = routes.filter((route) => route.url === urls[1]);
  assert.equal(outer.length, 1, "One exact native outer child attachment");
  assert.equal(outer[0]!.parentSessionId, "");
  assert.ok(outer[0]!.sessionId && outer[0]!.targetId);
  const leaf = routes.filter((route) => route.url === urls[2]);
  if (mode === "nested-oopif") {
    assert.equal(leaf.length, 1, "One exact nested native child attachment");
    assert.equal(leaf[0]!.parentSessionId, outer[0]!.sessionId);
    assert.notEqual(leaf[0]!.sessionId, outer[0]!.sessionId);
  } else assert.equal(leaf.length, 0, "Same-renderer leaf has no native route");
  const selected = mode === "nested-oopif" ? leaf[0]! : outer[0]!;
  assert.deepEqual(
    inputs.map(({ method, type, sessionId }) => ({ method, type, sessionId })),
    (kind === "click"
      ? ["mousePressed", "mouseReleased"]
      : ["keyDown", "keyUp"]
    ).map((type) => ({
      method:
        kind === "click"
          ? "Input.dispatchMouseEvent"
          : "Input.dispatchKeyEvent",
      type,
      sessionId: kind === "click" ? selected.sessionId : "",
    })),
  );
  if (kind === "click")
    for (const input of inputs) {
      // Canvas center (100,30); same-renderer leaf additionally has the authored
      // owner inset (45,55). Outer affine transform must not be applied twice.
      assert.ok(
        Math.abs(input.x! - (mode === "nested-oopif" ? 100 : 145)) < 0.01,
      );
      assert.ok(
        Math.abs(input.y! - (mode === "nested-oopif" ? 30 : 85)) < 0.01,
      );
    }
}
