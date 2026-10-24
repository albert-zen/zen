import assert from "node:assert/strict";
import test from "node:test";
import { CaptureBindingExperiment } from "../docs/experiments/computer-target/capture-binding.js";
import type {
  InputAction,
  WindowSnapshot,
} from "../docs/experiments/computer-target/explicit-target.js";
const target = { pid: 42, processStartedAt: "fixture", windowId: 7 };
const snapshot = (): WindowSnapshot => ({
  target: { ...target },
  foreground: { ...target },
  bounds: { x: -1200, y: 100, width: 1000, height: 800 },
});
const image = { width: 500, height: 400 };
const signal = () => new AbortController().signal;
const click = {
  kind: "click" as const,
  imagePoint: { x: 250, y: 200 },
  button: "left" as const,
};

test("capture pixels map through actual image dimensions into negative-origin desktop points", async () => {
  const registry = new CaptureBindingExperiment();
  const posted: InputAction[] = [];
  const token = registry.retain("thread-a", snapshot(), image);
  const port = {
    readWindow: async () => snapshot(),
    postOnce: async (a: InputAction) => {
      posted.push(a);
    },
  };
  assert.deepEqual(
    await registry.act("thread-a", token, click, port, signal()),
    { dispatch: "posted", applicationEffect: "unverified" },
  );
  assert.deepEqual(posted, [
    { kind: "click", point: { x: -700, y: 500 }, button: "left" },
  ]);
  await assert.rejects(
    registry.act("thread-a", token, click, port, signal()),
    /unknown/u,
  );
  assert.equal(posted.length, 1);
});

test("foreign, expired and moved-window captures never dispatch", async () => {
  let now = 1;
  const registry = new CaptureBindingExperiment(() => now);
  let posts = 0;
  const port = {
    readWindow: async () => snapshot(),
    postOnce: async () => {
      posts++;
    },
  };
  const token = registry.retain("a", snapshot(), image);
  await assert.rejects(
    registry.act("b", token, click, port, signal()),
    /foreign/u,
  );
  now = 30001;
  await assert.rejects(
    registry.act("a", token, click, port, signal()),
    /expired/u,
  );
  const moved = registry.retain("a", snapshot(), image);
  await assert.rejects(
    registry.act(
      "a",
      moved,
      click,
      {
        ...port,
        readWindow: async () => ({
          ...snapshot(),
          bounds: { ...snapshot().bounds, x: 0 },
        }),
      },
      signal(),
    ),
    /moved/u,
  );
  assert.equal(posts, 0);
});

test("capture rejects focus drift and out-of-image coordinates", async () => {
  const registry = new CaptureBindingExperiment();
  let posts = 0;
  const port = {
    readWindow: async () => ({
      ...snapshot(),
      foreground: { ...target, pid: 99 },
    }),
    postOnce: async () => {
      posts++;
    },
  };
  await assert.rejects(
    registry.act(
      "a",
      registry.retain("a", snapshot(), image),
      click,
      port,
      signal(),
    ),
    /target changed/u,
  );
  await assert.rejects(
    registry.act(
      "a",
      registry.retain("a", snapshot(), image),
      { ...click, imagePoint: { x: 500, y: 0 } },
      port,
      signal(),
    ),
    /outside captured/u,
  );
  assert.equal(posts, 0);
});

test("uncertain dispatch consumes capture without retries and capture data is immutable", async () => {
  const registry = new CaptureBindingExperiment();
  const original = snapshot();
  const token = registry.retain("a", original, image);
  original.target.pid = 999;
  let posts = 0;
  const port = {
    readWindow: async () => snapshot(),
    postOnce: async () => {
      posts++;
      throw new Error("lost receipt");
    },
  };
  await assert.rejects(
    registry.act("a", token, click, port, signal()),
    /outcome unknown/u,
  );
  await assert.rejects(
    registry.act("a", token, click, port, signal()),
    /unknown or foreign/u,
  );
  assert.equal(posts, 1);
});

test("capture store is bounded and expired entries release capacity", () => {
  let now = 0;
  const registry = new CaptureBindingExperiment(() => now);
  for (let i = 0; i < 64; i++) registry.retain("a", snapshot(), image);
  assert.throws(() => registry.retain("a", snapshot(), image), /budget/u);
  now = 30000;
  assert.doesNotThrow(() => registry.retain("a", snapshot(), image));
});

// The same fixture matrix runs in both competing drafts.
test("comparison matrix: target, geometry, lifetime and uncertain delivery", async () => {
  for (const scenario of [
    "stable",
    "other-process",
    "other-window",
    "reused-pid",
    "moved",
    "expired",
    "post-error",
    "late-focus-switch",
  ] as const) {
    let time = 0;
    const captured: WindowSnapshot = {
      target: { pid: 42, processStartedAt: "fixture", windowId: 7 },
      foreground: { pid: 42, processStartedAt: "fixture", windowId: 7 },
      bounds: { x: -1200, y: 100, width: 1000, height: 800 },
    };
    const current = structuredClone(captured);
    const posts: InputAction[] = [];
    let recipient = 42;
    const port = {
      readWindow: async () => current,
      postOnce: async (action: InputAction) => {
        posts.push(action);
        if (scenario === "post-error") throw new Error("lost receipt");
        if (scenario === "late-focus-switch") recipient = 99;
      },
    };

    const registry = new CaptureBindingExperiment(() => time);
    const token = registry.retain("owner", captured, {
      width: 500,
      height: 400,
    });
    const invoke = () =>
      registry.act(
        "owner",
        token,
        { kind: "click", imagePoint: { x: 250, y: 200 }, button: "left" },
        port,
        signal(),
      );

    if (scenario === "other-process") current.foreground.pid = 99;
    if (scenario === "other-window") current.foreground.windowId = 8;
    if (scenario === "reused-pid")
      current.foreground.processStartedAt = "replacement";
    if (scenario === "moved") current.bounds.x = -1100;
    if (scenario === "expired") time = 30000;
    const rejectsIdentity = [
      "other-process",
      "other-window",
      "reused-pid",
    ].includes(scenario);
    const rejectsFreshness = scenario === "moved" || scenario === "expired";

    if (rejectsIdentity || rejectsFreshness) {
      await assert.rejects(invoke());
      assert.equal(posts.length, 0, scenario);
    } else if (scenario === "post-error") {
      await assert.rejects(invoke(), /outcome unknown/u);
      assert.equal(posts.length, 1);
    } else {
      assert.deepEqual(await invoke(), {
        dispatch: "posted",
        applicationEffect: "unverified",
      });
      assert.deepEqual(
        posts,
        [{ kind: "click", point: { x: -700, y: 500 }, button: "left" }],
        scenario,
      );
      if (scenario === "late-focus-switch")
        assert.equal(
          recipient,
          99,
          "known unresolved race, not a protection claim",
        );
    }
  }
});

test("capture that expires during awaited observation refuses before posting", async () => {
  let now = 0;
  const registry = new CaptureBindingExperiment(() => now);
  const token = registry.retain("a", snapshot(), image);
  let posts = 0;
  await assert.rejects(
    registry.act(
      "a",
      token,
      click,
      {
        readWindow: async () => {
          now = 30001;
          return snapshot();
        },
        postOnce: async () => {
          posts += 1;
        },
      },
      signal(),
    ),
    /expired capture; no input dispatched/u,
  );
  assert.equal(posts, 0);
});
