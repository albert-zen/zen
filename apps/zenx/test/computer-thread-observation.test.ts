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

for (const status of ["unavailable", "failed"] as const) {
  test(`Computer observation fences synchronous ${status} and restarts only on explicit publication`, () => {
    const backend = fakeBackend();
    const listeners: ComputerLiveObservationListener[] = [];
    backend.observeWindow = (target, listener) => {
      backend.liveTargets.push(target);
      listeners.push(listener);
      listener({
        type: "status",
        status: listeners.length === 1 ? status : "live",
        message: "Fixture capture status.",
      });
      return () => {
        backend.stops += 1;
        listener({ type: "status", status: "live", message: "Late cleanup" });
      };
    };
    const observation = new ComputerThreadObservation(backend);
    const events: ComputerThreadEvent[] = [];
    observation.observe({ threadId: "thread-a", frames: true }, (event) =>
      events.push(event),
    );

    observation.publish("thread-a", "first-action", windowTarget);
    assert.equal(backend.liveTargets.length, 1, "failure must not retry");
    assert.equal(backend.stops, 1, "synchronous failure cleans up its capture");
    assert.equal(events.at(-1)?.type, "status");
    assert.ok(
      events.some(
        (event) => event.type === "status" && event.status === status,
      ),
    );

    const countAfterFailure = events.length;
    listeners[0]!({ type: "status", status: "live", message: "Late live" });
    listeners[0]!(fixtureFrame());
    assert.equal(events.length, countAfterFailure);

    observation.publish("thread-a", "fresh-inspection", windowTarget);
    assert.equal(backend.liveTargets.length, 2);
    assert.equal(backend.stops, 1);
    const countAfterRestart = events.length;
    listeners[0]!({ type: "status", status, message: "Late terminal" });
    listeners[0]!(fixtureFrame());
    assert.equal(events.length, countAfterRestart);
    assert.equal(
      backend.stops,
      1,
      "stale terminal cannot stop the new capture",
    );
    listeners[1]!(fixtureFrame());
    assert.equal(events.at(-1)?.type, "frame");

    observation.publish("thread-a", "continuing-action", windowTarget);
    assert.equal(backend.liveTargets.length, 2, "healthy capture stays live");
    observation.close();
    assert.equal(backend.stops, 2);
  });
}

test("a synchronous terminal callback cannot overwrite an explicit replacement capture", () => {
  const backend = fakeBackend();
  const stopped: number[] = [];
  backend.observeWindow = (target, listener) => {
    const capture = backend.liveTargets.length;
    backend.liveTargets.push(target);
    listener({
      type: "status",
      status: capture === 0 ? "unavailable" : "live",
      message: "Fixture capture status.",
    });
    return () => stopped.push(capture);
  };
  const observation = new ComputerThreadObservation(backend);
  observation.observe({ threadId: "thread-a", frames: true }, (event) => {
    if (event.type === "status" && event.status === "unavailable") {
      observation.publish("thread-a", "fresh-inspection", windowTarget);
    }
  });

  observation.publish("thread-a", "first-action", windowTarget);
  assert.equal(backend.liveTargets.length, 2);
  assert.deepEqual(stopped, [0], "only the terminated capture is cleaned up");
  observation.publish("thread-a", "continuing-action", windowTarget);
  assert.equal(backend.liveTargets.length, 2);
  observation.close();
  assert.deepEqual(
    stopped,
    [0, 1],
    "the replacement retains its own stop handle",
  );
});

function fixtureFrame(): ComputerThreadEvent & { type: "frame" } {
  return {
    type: "frame",
    frame: {
      sequence: 1,
      mimeType: "image/jpeg",
      data: "ZmFrZQ==",
      width: 800,
      height: 600,
      capturedAt: new Date(0).toISOString(),
    },
  };
}

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
