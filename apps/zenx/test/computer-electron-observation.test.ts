import assert from "node:assert/strict";
import test from "node:test";

import { observeComputerWindow } from "../src/main/capabilities/computer-electron-observation.js";
import type { ComputerLiveObservationEvent } from "../src/main/capabilities/computer-provider.js";

test("a capture already in flight retains its acquisition-start timestamp", async () => {
  let release!: () => void;
  let captureStartedAt = 0;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const events: ComputerLiveObservationEvent[] = [];
  const stop = observeComputerWindow(
    async () => {
      captureStartedAt = Date.now();
      await pending;
      return fakeImage() as never;
    },
    (event) => events.push(event),
  );
  try {
    await new Promise((resolve) => setTimeout(resolve, 20));
    const actionStartedAt = Date.now();
    release();
    await new Promise((resolve) => setImmediate(resolve));
    const frame = events.find((event) => event.type === "frame");
    assert.ok(frame && frame.type === "frame");
    assert.ok(Date.parse(frame.frame.capturedAt) <= captureStartedAt);
    assert.ok(
      Date.parse(frame.frame.capturedAt) < actionStartedAt,
      "an action during capture must not paint on pre-action pixels",
    );
  } finally {
    stop();
  }
});

test("Computer live capture is serial, bounded, cancellable, and announces live once", async () => {
  const events: ComputerLiveObservationEvent[] = [];
  let captures = 0;
  let active = 0;
  let maxActive = 0;
  const stop = observeComputerWindow(
    async () => {
      captures += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active -= 1;
      return fakeImage() as never;
    },
    (event) => events.push(event),
  );

  await new Promise((resolve) => setTimeout(resolve, 825));
  stop();
  const capturesAtStop = captures;
  await new Promise((resolve) => setTimeout(resolve, 800));

  assert.equal(maxActive, 1);
  assert.ok(capturesAtStop >= 2);
  assert.equal(captures, capturesAtStop);
  assert.equal(
    events.filter((event) => event.type === "status" && event.status === "live")
      .length,
    1,
  );
  const frames = events.filter((event) => event.type === "frame");
  assert.ok(frames.length >= 2);
  assert.equal(frames[0]?.frame.width, 1600);
  assert.equal(frames[0]?.frame.height, 900);
  assert.ok(frames[0]?.frame.capturedAt);
});

test("Computer live frame carries exact window geometry separately from scaled image size", async () => {
  const events: ComputerLiveObservationEvent[] = [];
  const stop = observeComputerWindow(
    async () => ({
      image: fakeImage() as never,
      windowWidth: 3200,
      windowHeight: 1800,
      windowId: 193,
    }),
    (event) => events.push(event),
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  stop();
  const frame = events.find((event) => event.type === "frame");
  assert(frame?.type === "frame");
  assert.equal(frame.frame.width, 1600);
  assert.equal(frame.frame.windowWidth, 3200);
  assert.equal(frame.frame.windowHeight, 1800);
  assert.equal(frame.frame.windowId, 193);
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
