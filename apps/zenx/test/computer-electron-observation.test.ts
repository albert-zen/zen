import assert from "node:assert/strict";
import test from "node:test";

import { observeComputerWindow } from "../src/main/capabilities/computer-electron-observation.js";
import type { ComputerLiveObservationEvent } from "../src/main/capabilities/computer-provider.js";

test("Computer live capture is serial, bounded, cancellable, and announces live once", async () => {
  const events: ComputerLiveObservationEvent[] = [];
  let captures = 0;
  let active = 0;
  let maxActive = 0;
  const stop = observeComputerWindow(async () => {
    captures += 1;
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 20));
    active -= 1;
    return fakeImage() as never;
  }, (event) => events.push(event));

  await new Promise((resolve) => setTimeout(resolve, 825));
  stop();
  const capturesAtStop = captures;
  await new Promise((resolve) => setTimeout(resolve, 800));

  assert.equal(maxActive, 1);
  assert.ok(capturesAtStop >= 2);
  assert.equal(captures, capturesAtStop);
  assert.equal(
    events.filter(
      (event) => event.type === "status" && event.status === "live",
    ).length,
    1,
  );
  const frames = events.filter((event) => event.type === "frame");
  assert.ok(frames.length >= 2);
  assert.equal(frames[0]?.frame.width, 1600);
  assert.equal(frames[0]?.frame.height, 900);
  assert.ok(frames[0]?.frame.capturedAt);
});

function fakeImage() {
  return {
    isEmpty: () => false,
    getSize: () => ({ width: 3200, height: 1800 }),
    resize: ({ width, height }: { width: number; height: number }) => ({
      isEmpty: () => false,
      getSize: () => ({ width, height }),
      resize: () => {
        throw new Error("unexpected second resize");
      },
      toJPEG: () => Buffer.from("frame"),
    }),
    toJPEG: () => {
      throw new Error("oversized image must be resized");
    },
  };
}
