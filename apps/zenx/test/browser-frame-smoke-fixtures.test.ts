import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import {
  assertRemoteFramePlacement,
  remoteFrameContractPage,
  targetedInputContractPage,
} from "../src/main/browser-parallel-input-smoke.js";

const configuration = {
  mode: "cross-origin-same-process" as const,
  parentOrigin: "http://127.0.0.1:30001",
  childOrigin: "http://127.0.0.1:30002",
  nonce: "0bff1000-ffff-4000-8000-000000000001",
};

function box(left: number, top: number, width: number, height: number) {
  return {
    left,
    top,
    width,
    height,
    x: left,
    y: top,
    right: left + width,
    bottom: top + height,
    toJSON() {
      return { x: left, y: top, width, height };
    },
  };
}

test("affine fixture points use an independent forward matrix and ignore iframe AABBs", () => {
  const dom = new JSDOM(targetedInputContractPage("/?mode=affine-frame"), {
    runScripts: "dangerously",
  });
  try {
    const frame = dom.window.document.querySelector("iframe")!;
    assert.equal(frame.style.transformOrigin, "322px 256px");
    assert.equal(frame.style.padding, "11px 7px");
    frame.contentDocument!.querySelector("#canvas")!.getBoundingClientRect =
      () => box(0, 0, 200, 60);
    frame.getBoundingClientRect = () => {
      throw new Error("The point oracle must never use the transformed AABB");
    };
    const actual = dom.window.contract.point("canvas");
    // The local center (100,30), content inset (12,16), and origin (322,256)
    // produce equal -210 offsets, independently computed from the CSS fixture.
    const angle = Math.PI / 12;
    const expected = {
      x: 422 - 210 * Math.cos(angle) + 210 * Math.sin(angle),
      y: 346 - 210 * Math.sin(angle) - 210 * Math.cos(angle),
    };
    assert.ok(Math.abs(actual.x - expected.x) < 1e-9);
    assert.ok(Math.abs(actual.y - expected.y) < 1e-9);
    frame.getBoundingClientRect = () => box(10, 20, 700, 600);
    dom.window.contract.flipTransform();
    const reflected = dom.window.contract.point("canvas");
    assert.ok(
      Math.abs(
        reflected.x - (422 - 210 * Math.cos(angle) - 210 * Math.sin(angle)),
      ) < 1e-9,
    );
    assert.ok(
      Math.abs(
        reflected.y - (346 + 210 * Math.sin(angle) - 210 * Math.cos(angle)),
      ) < 1e-9,
    );
    assert.notEqual(reflected.x, actual.x);
    assert.equal(Reflect.get(frame.contentWindow!, "mainWorldProbeCalls"), 0);
  } finally {
    dom.window.close();
  }
});

test("remote child accepts only the exact parent, origin, nonce and fixed commands", () => {
  const replies: { message: Record<string, unknown>; origin: string }[] = [];
  const dom = new JSDOM(remoteFrameContractPage("child", configuration), {
    url: configuration.childOrigin,
    runScripts: "dangerously",
    beforeParse(window) {
      window.postMessage = (
        message: Record<string, unknown>,
        origin?: string | WindowPostMessageOptions,
      ) => {
        assert.equal(typeof origin, "string");
        replies.push({ message, origin: origin as string });
      };
    },
  });
  try {
    const send = (
      changes: Record<string, unknown> = {},
      source: MessageEventSource | null = dom.window as unknown as Window,
      origin = configuration.parentOrigin,
    ) =>
      dom.window.dispatchEvent(
        new dom.window.MessageEvent("message", {
          source,
          origin,
          data: {
            kind: "request",
            nonce: configuration.nonce,
            id: 1,
            method: "focus",
            argument: "text-b",
            ...changes,
          },
        }),
      );
    assert.equal(replies.length, 1);
    assert.equal(replies[0]!.message.kind, "ready");
    send({}, null);
    send({}, dom.window as unknown as Window, "http://127.0.0.1:30003");
    send({ nonce: "wrong" });
    send({ kind: "reply" });
    send({ id: -1 });
    send({ method: "evaluate", argument: "window.parent.hacked=true" });
    send({ argument: "body" });
    assert.equal(replies.length, 1);
    assert.equal(dom.window.document.activeElement?.id, "text-a");
    send();
    assert.equal(dom.window.document.activeElement?.id, "text-b");
    assert.equal(replies.length, 2);
    assert.equal(replies[1]!.origin, configuration.parentOrigin);
    assert.equal(replies[1]!.message.nonce, configuration.nonce);
    // Synthetic JSDOM events stay untrusted. Native acceptance is separate.
    dom.window.document
      .querySelector("#text-b")!
      .dispatchEvent(
        new dom.window.KeyboardEvent("keydown", { bubbles: true }),
      );
    send({ id: 2, method: "state" });
    const state = replies.at(-1)!.message.result as {
      events: { trusted: boolean }[];
    };
    assert.deepEqual(
      Array.from(state.events, (event) => event.trusted),
      [false],
    );
  } finally {
    dom.window.close();
  }
});

test("remote parent ignores forged readiness and replies and binds requests to the exact child", async () => {
  const dom = new JSDOM(remoteFrameContractPage("parent", configuration), {
    url: configuration.parentOrigin,
    runScripts: "dangerously",
  });
  try {
    const frame = dom.window.document.querySelector("iframe")!;
    const child = frame.contentWindow!;
    const send = (
      data: Record<string, unknown>,
      source: MessageEventSource | null = child as unknown as Window,
      origin = configuration.childOrigin,
    ) =>
      dom.window.dispatchEvent(
        new dom.window.MessageEvent("message", {
          source,
          origin,
          data: { nonce: configuration.nonce, ...data },
        }),
      );
    send({ kind: "ready" }, null);
    send(
      { kind: "ready" },
      child as unknown as Window,
      configuration.parentOrigin,
    );
    send({ kind: "ready", nonce: "wrong" });
    assert.equal(dom.window.contract.ready, false);
    send({ kind: "ready" });
    assert.equal(dom.window.contract.ready, true);
    const requests: { message: Record<string, unknown>; origin: string }[] = [];
    child.postMessage = (
      message: Record<string, unknown>,
      origin?: string | WindowPostMessageOptions,
    ) => {
      assert.equal(typeof origin, "string");
      requests.push({ message, origin: origin as string });
    };
    const pending = dom.window.contract.point("canvas") as Promise<{
      x: number;
      y: number;
    }>;
    assert.equal(requests.length, 1);
    assert.equal(requests[0]!.origin, configuration.childOrigin);
    const id = requests[0]!.message.id;
    const reply = { kind: "reply", id, result: { x: 100, y: 30 } };
    let resolved = false;
    void pending.then(() => {
      resolved = true;
    });
    send(reply, null);
    send(reply, child as unknown as Window, configuration.parentOrigin);
    send({ ...reply, nonce: "wrong" });
    send({ ...reply, id: 999 });
    await Promise.resolve();
    assert.equal(resolved, false);
    send(reply);
    const point = await pending;
    assert.equal(point.x, 132);
    assert.equal(point.y, 66);
    dom.window.contract.reopenFrame();
    assert.equal(dom.window.contract.ready, false);
    assert.equal(new URL(frame.src).searchParams.get("revision"), "1");
  } finally {
    dom.window.close();
  }
});

test("remote fixture accepts exact loopback origins only", () => {
  for (const childOrigin of [
    "https://example.com",
    "http://127.0.0.1:30002/path",
    configuration.parentOrigin,
  ])
    assert.throws(() =>
      remoteFrameContractPage("parent", { ...configuration, childOrigin }),
    );
  assert.throws(() =>
    remoteFrameContractPage("child", { ...configuration, nonce: "forged" }),
  );
});

const context = (frameId: string) => ({
  id: frameId === "root" ? 1 : 2,
  uniqueId: `context-${frameId}`,
  auxData: { frameId, isDefault: true },
});
const base = {
  mode: "cross-origin-same-process" as const,
  rootFrameId: "root",
  childFrameId: "child",
  rootContexts: [context("root"), context("child")],
  targets: [],
  childUrl: configuration.childOrigin,
  ownerBackendNodeId: 42,
};

test("same-process evidence needs the actual root-session child context and no OOPIF target", () => {
  assert.doesNotThrow(() => assertRemoteFramePlacement(base));
  assert.throws(
    () =>
      assertRemoteFramePlacement({ ...base, rootContexts: [context("root")] }),
    /real child default context/,
  );
  assert.throws(
    () =>
      assertRemoteFramePlacement({
        ...base,
        targets: [{ type: "iframe", targetId: "child", url: base.childUrl }],
      }),
    /must not actually be an OOPIF/,
  );
});

test("OOPIF evidence requires target, session and child default context identity", () => {
  const evidence = {
    ...base,
    mode: "cross-origin-oopif" as const,
    rootContexts: [context("root")],
    targets: [
      { type: "iframe", targetId: "distinct-child-target", url: base.childUrl },
    ],
    childSessionId: "child-session",
    childSessionTargetId: "distinct-child-target",
    childAttachedEvent: {
      sessionId: "child-session",
      targetInfo: {
        targetId: "distinct-child-target",
        type: "iframe",
        url: base.childUrl,
      },
    },
    childSessionFrameId: "child",
    childContexts: [context("child")],
  };
  assert.doesNotThrow(() => assertRemoteFramePlacement(evidence));
  for (const patch of [
    { targets: [] },
    { childSessionId: undefined },
    { childAttachedEvent: undefined },
    { ownerBackendNodeId: 0 },
    { childSessionTargetId: "other" },
    { childSessionFrameId: "other" },
    { childContexts: [context("other")] },
    { rootContexts: [context("root"), context("child")] },
  ])
    assert.throws(() => assertRemoteFramePlacement({ ...evidence, ...patch }));
});
