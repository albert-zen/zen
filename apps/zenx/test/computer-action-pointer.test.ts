import assert from "node:assert/strict";
import test from "node:test";

import { ComputerThreadObservation } from "../src/main/capabilities/computer-thread-observation.js";
import { observeComputerWindow } from "../src/main/capabilities/computer-electron-observation.js";
import { ComputerZenXCapabilityPackage } from "../src/main/capabilities/computer-provider.js";
import type { ComputerThreadEvent } from "../src/main/capabilities/computer-thread-observation.js";
import type {
  ComputerActionPointer,
  ComputerTarget,
  ZenXComputerBackend,
} from "../src/main/capabilities/computer-provider.js";

const target: ComputerTarget = { pid: 42, windowTitle: "Fixture" };
const pointer = (): ComputerActionPointer => ({
  x: 0.25,
  y: 0.75,
  action: "press",
  capturedAt: new Date().toISOString(),
  windowWidth: 800,
  windowHeight: 600,
});

function backend() {
  const state = { starts: 0, stops: 0 };
  const implementation: ZenXComputerBackend = {
    observeWindow: () => {
      state.starts += 1;
      return () => {
        state.stops += 1;
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
  return { implementation, state };
}

test("Computer pointer stays in its thread and target, and repeated actions retain live capture", () => {
  const { implementation, state } = backend();
  const observation = new ComputerThreadObservation(implementation);
  const events: Array<{
    type: string;
    targets?: Array<{ pointer?: ComputerActionPointer }>;
  }> = [];
  const stop = observation.observe({ threadId: "a", frames: true }, (event) =>
    events.push(event),
  );
  observation.publish("a", "first", target, pointer());
  observation.publish("a", "second", target, { ...pointer(), x: 0.5 });
  assert.equal(state.starts, 1);
  assert.equal(state.stops, 0);
  assert.equal(events.at(-1)?.targets?.[0]?.pointer?.x, 0.5);
  observation.publish("b", "other", target, pointer());
  assert.equal(events.at(-1)?.targets?.length, 1);
  observation.publish(
    "a",
    "third",
    { pid: 43, windowTitle: "Other" },
    pointer(),
  );
  assert.equal(state.starts, 2);
  assert.equal(state.stops, 1);
  stop();
  assert.equal(state.stops, 2);
});

test("a successful Computer action explicitly restarts a failed same-window capture", async () => {
  const { implementation } = backend();
  let starts = 0;
  let captures = 0;
  implementation.observeWindow = (_target, listener) => {
    const fails = ++starts === 1;
    return observeComputerWindow(async () => {
      captures += 1;
      if (fails) throw new Error("The selected Computer window changed");
      return {
        isEmpty: () => false,
        getSize: () => ({ width: 800, height: 600 }),
        toJPEG: () => Buffer.from("fresh frame"),
      } as never;
    }, listener);
  };
  implementation.press = async () => ({
    target: { pid: 42, applicationName: "Fixture", windowTitle: "Fixture" },
    control: { observationId: "observed", targetId: "button" },
    pointer: pointer(),
  });
  const capability = new ComputerZenXCapabilityPackage(implementation);
  const events: ComputerThreadEvent[] = [];
  capability.observeThread({ threadId: "a", frames: true }, (event) =>
    events.push(event),
  );
  const press = (callId: string) =>
    capability.invoke("computer_press", {
      callId,
      threadId: "a",
      name: "computer_press",
      arguments: {
        target,
        control: { observationId: "observed", targetId: "button" },
      },
      cwd: "/workspace",
      signal: new AbortController().signal,
    });
  try {
    await press("first-action");
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(
      events.some(
        (event) => event.type === "status" && event.status === "unavailable",
      ),
    );
    assert.equal(starts, 1, "a terminal failure must not automatically retry");
    assert.equal(captures, 1);

    await press("fresh-action");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(starts, 2, "an explicit successful action restarts capture");
    assert.equal(captures, 2);
    assert.equal(events.at(-1)?.type, "frame");

    await press("continuing-action");
    assert.equal(starts, 2, "healthy same-window capture stays continuous");
  } finally {
    await capability.close();
  }
});

test("Computer pointer rejects stale and invalid geometry and does not replay on a later action", () => {
  const { implementation } = backend();
  const observation = new ComputerThreadObservation(implementation);
  observation.publish("a", "stale", target, {
    ...pointer(),
    capturedAt: new Date(Date.now() - 5_000).toISOString(),
  });
  observation.publish("a", "invalid", target, { ...pointer(), x: Number.NaN });
  observation.publish("a", "outside", target, { ...pointer(), y: 1.1 });
  const events: Array<{
    type: string;
    targets?: Array<{ pointer?: ComputerActionPointer }>;
  }> = [];
  observation.observe({ threadId: "a", frames: false }, (event) =>
    events.push(event),
  );
  assert.equal(events[0]?.targets?.[0]?.pointer, undefined);
  observation.publish("a", "fresh", target, pointer());
  assert.ok(
    events.findLast((event) => event.type === "targets")?.targets?.[0]?.pointer,
  );
  observation.publish("a", "later", target);
  assert.equal(
    events.findLast((event) => event.type === "targets")?.targets?.[0]?.pointer,
    undefined,
  );
});

test("Computer observation accepts only a positive native window identity", () => {
  const { implementation } = backend();
  const observation = new ComputerThreadObservation(implementation);
  const events: Array<{
    type: string;
    targets?: Array<{ pointer?: ComputerActionPointer }>;
  }> = [];
  observation.observe({ threadId: "a", frames: false }, (event) =>
    events.push(event),
  );
  observation.publish("a", "invalid", target, { ...pointer(), windowId: -1 });
  assert.equal(
    events.findLast((event) => event.type === "targets")?.targets?.[0]?.pointer,
    undefined,
  );
  observation.publish("a", "valid", target, { ...pointer(), windowId: 193 });
  assert.equal(
    events.findLast((event) => event.type === "targets")?.targets?.[0]?.pointer
      ?.windowId,
    193,
  );
});

test("Computer action pointer is observable but omitted from the canonical tool result", async () => {
  const { implementation } = backend();
  implementation.press = async () => ({
    target: { pid: 42, applicationName: "Fixture", windowTitle: "Fixture" },
    control: { observationId: "observed", targetId: "button" },
    pointer: pointer(),
  });
  const capability = new ComputerZenXCapabilityPackage(implementation);
  const events: Array<{
    type: string;
    targets?: Array<{ pointer?: ComputerActionPointer }>;
  }> = [];
  capability.observeThread({ threadId: "a", frames: false }, (event) =>
    events.push(event),
  );
  const result = await capability.invoke("computer_press", {
    callId: "action",
    threadId: "a",
    name: "computer_press",
    arguments: {
      target,
      control: { observationId: "observed", targetId: "button" },
    },
    cwd: "/workspace",
    signal: new AbortController().signal,
  });
  assert.equal(JSON.stringify(result).includes("pointer"), false);
  assert.equal(
    events.findLast((event) => event.type === "targets")?.targets?.[0]?.pointer
      ?.action,
    "press",
  );
});
