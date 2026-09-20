import assert from "node:assert/strict";
import test from "node:test";

import {
  ComputerThreadObservation,
  type ComputerThreadEvent,
} from "../src/main/capabilities/computer-thread-observation.js";
import type {
  ComputerLiveObservationListener,
  ComputerTarget,
  ZenXComputerBackend,
} from "../src/main/capabilities/computer-provider.js";

const windowTarget: ComputerTarget = {
  pid: 42,
  bundleId: "dev.zen.fixture",
  windowTitle: "Fixture window",
};

test("Computer observation is thread and invocation scoped and stops the exact live window", () => {
  const backend = fakeBackend();
  const observation = new ComputerThreadObservation(backend);
  observation.publish("thread-a", "call-a", windowTarget);
  observation.publish("thread-b", "call-b", {
    pid: 43,
    windowTitle: "Other window",
  });

  const events: ComputerThreadEvent[] = [];
  const stop = observation.observe(
    { threadId: "thread-a", frames: true },
    (event) => events.push(event),
  );
  const targets = events.find((event) => event.type === "targets");
  assert.equal(targets?.type, "targets");
  assert.equal(targets.targets.length, 1);
  assert.equal(targets.targets[0]?.invocationId, "call-a");
  assert.equal(targets.targets[0]?.target.windowTitle, "Fixture window");
  assert.equal(backend.liveTargets.length, 1);
  assert.equal(backend.liveTargets[0]?.windowTitle, "Fixture window");

  backend.liveListener?.({
    type: "frame",
    frame: {
      sequence: 1,
      mimeType: "image/jpeg",
      data: "ZmFrZQ==",
      width: 800,
      height: 600,
      capturedAt: new Date(0).toISOString(),
    },
  });
  assert.equal(events.at(-1)?.type, "frame");
  stop();
  assert.equal(backend.stops, 1);
});

test("Computer observation fences a prior target generation and bounds target history", () => {
  const backend = fakeBackend();
  const observation = new ComputerThreadObservation(backend);
  for (let index = 0; index < 12; index += 1) {
    observation.publish("thread-a", `call-${String(index)}`, {
      pid: index + 1,
      windowTitle: `Window ${String(index)}`,
    });
  }
  const events: ComputerThreadEvent[] = [];
  observation.observe({ threadId: "thread-a", frames: false }, (event) =>
    events.push(event),
  );
  const targets = events.find((event) => event.type === "targets");
  assert.equal(targets?.type, "targets");
  assert.equal(targets.targets.length, 8);
  assert.equal(targets.targets[0]?.invocationId, "call-4");
  assert.equal(targets.targets.at(-1)?.invocationId, "call-11");
  assert.equal(backend.liveTargets.length, 0);
});

test("Computer observation moves one resolved window forward instead of duplicating it", () => {
  const backend = fakeBackend();
  const observation = new ComputerThreadObservation(backend);
  observation.publish("thread-a", "call-1", windowTarget);
  observation.publish("thread-a", "call-2", windowTarget);
  const events: ComputerThreadEvent[] = [];
  observation.observe({ threadId: "thread-a", frames: false }, (event) =>
    events.push(event),
  );
  const targets = events.find((event) => event.type === "targets");
  assert.equal(targets?.type, "targets");
  assert.equal(targets.targets.length, 1);
  assert.equal(targets.targets[0]?.invocationId, "call-2");
});

function fakeBackend(): ZenXComputerBackend & {
  liveTargets: ComputerTarget[];
  liveListener?: ComputerLiveObservationListener;
  stops: number;
} {
  return {
    liveTargets: [],
    stops: 0,
    observeWindow(target, listener) {
      this.liveTargets.push(target);
      this.liveListener = listener;
      listener({
        type: "status",
        status: "live",
        message: "Live fixture window.",
      });
      return () => {
        this.stops += 1;
      };
    },
    inspect: async () => {
      throw new Error("unused");
    },
    press: async () => {
      throw new Error("unused");
    },
    setValue: async () => {
      throw new Error("unused");
    },
    screenshot: async () => {
      throw new Error("unused");
    },
    foregroundClick: async () => undefined,
    foregroundKeyPress: async () => undefined,
    foregroundScroll: async () => undefined,
    close: () => undefined,
  };
}
