import assert from "node:assert/strict";
import test from "node:test";
import {
  explicitTargetInput,
  type TargetIdentity,
  type InputAction,
  type WindowSnapshot,
} from "../docs/experiments/computer-target/explicit-target.js";
const target = {
  pid: 42,
  processStartedAt: "fixture-process-start",
  windowId: 7,
};
const bounds = { x: -900, y: 100, width: 800, height: 600 };
const signal = () => new AbortController().signal;
const view = (): WindowSnapshot => ({
  target: { ...target },
  foreground: { ...target },
  bounds: { ...bounds },
});

test("explicit target rejects focus switch, replaced process and sibling window before posting", async () => {
  for (const changed of [
    { ...target, pid: 99 },
    { ...target, windowId: 8 },
    { ...target, processStartedAt: "replacement" },
  ]) {
    let posts = 0;
    await assert.rejects(
      explicitTargetInput(
        target,
        { kind: "key", key: "enter" },
        {
          readWindow: async () => ({ ...view(), foreground: changed }),
          postOnce: async () => {
            posts++;
          },
        },
        signal(),
      ),
      /no input dispatched/u,
    );
    assert.equal(posts, 0);
  }
});

test("explicit target preserves negative desktop coordinates and explicit scroll location", async () => {
  const action = {
    kind: "scroll" as const,
    point: { x: -500, y: 350 },
    deltaPixels: 120,
  };
  const posts: unknown[] = [];
  assert.deepEqual(
    await explicitTargetInput(
      target,
      action,
      {
        readWindow: async () => view(),
        postOnce: async (a, t) => {
          posts.push([a, t]);
        },
      },
      signal(),
    ),
    { dispatch: "posted", applicationEffect: "unverified" },
  );
  assert.deepEqual(posts, [[action, target]]);
});

test("explicit target refuses outside points and never retries uncertain dispatch", async () => {
  let posts = 0;
  const port = {
    readWindow: async () => view(),
    postOnce: async () => {
      posts++;
      throw new Error("transport lost");
    },
  };
  await assert.rejects(
    explicitTargetInput(
      target,
      { kind: "click", point: { x: 0, y: 0 }, button: "left" },
      port,
      signal(),
    ),
    /outside/u,
  );
  assert.equal(posts, 0);
  await assert.rejects(
    explicitTargetInput(target, { kind: "key", key: "enter" }, port, signal()),
    /outcome unknown/u,
  );
  assert.equal(posts, 1);
});

test("explicit target does not claim that preflight closes the native delivery race", async () => {
  let foreground: TargetIdentity = { ...target };
  let dispatchRecipient: TargetIdentity | undefined;
  await explicitTargetInput(
    target,
    { kind: "key", key: "enter" },
    {
      readWindow: async () => view(),
      postOnce: async () => {
        foreground = { ...target, pid: 99 };
        dispatchRecipient = foreground;
      },
    },
    signal(),
  );
  assert.equal(
    dispatchRecipient?.pid,
    99,
    "this deliberately demonstrates the unresolved global-post race, not a safe production adapter",
  );
});

test("explicit target cancellation while reading performs no input", async () => {
  const controller = new AbortController();
  let posts = 0;
  await assert.rejects(
    explicitTargetInput(
      target,
      { kind: "key", key: "space" },
      {
        readWindow: async () => {
          controller.abort();
          return view();
        },
        postOnce: async () => {
          posts++;
        },
      },
      controller.signal,
    ),
    /abort/iu,
  );
  assert.equal(posts, 0);
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

    const invoke = () =>
      explicitTargetInput(
        captured.target,
        { kind: "click", point: { x: -700, y: 500 }, button: "left" },
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
    const rejectsFreshness = false;

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
