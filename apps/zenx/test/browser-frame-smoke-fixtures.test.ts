import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { UserBrowserMutationOutcomeUnknownError } from "../src/main/capabilities/user-browser-provider.js";
import { BrowserInputOutcomeUnknownError } from "../src/main/capabilities/browser-targeted-input.js";
import { JSDOM } from "jsdom";
import {
  assertRemoteFramePlacement,
  assertRemoteProviderRoute,
  assertRemoteFixturePoint,
  observeRemoteFramePlacement,
  settleRemoteFixturePair,
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
  id: frameId === "root" ? 1 : frameId === "child" ? 2 : 3,
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

test("nested owner forwards only exact endpoints and applies its independent offset", async () => {
  const leafOrigin = "http://nested.localhost:30002";
  const replies: { message: Record<string, unknown>; origin: string }[] = [];
  const dom = new JSDOM(
    remoteFrameContractPage("child", {
      ...configuration,
      mode: "nested-oopif",
      leafOrigin,
    }),
    {
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
    },
  );
  try {
    const leaf = dom.window.document.querySelector("iframe")!.contentWindow!;
    const requests: { message: Record<string, unknown>; origin: string }[] = [];
    leaf.postMessage = (
      message: Record<string, unknown>,
      origin?: string | WindowPostMessageOptions,
    ) => {
      assert.equal(typeof origin, "string");
      requests.push({ message, origin: origin as string });
    };
    const send = (
      source: Window | null,
      origin: string,
      data: Record<string, unknown>,
    ) =>
      dom.window.dispatchEvent(
        new dom.window.MessageEvent("message", {
          source,
          origin,
          data: { nonce: configuration.nonce, ...data },
        }),
      );
    const parent = dom.window as unknown as Window;
    const child = leaf as unknown as Window;
    send(child, leafOrigin, { kind: "ready" });
    assert.equal(replies.length, 1);
    assert.equal(replies[0]!.origin, configuration.parentOrigin);
    const point = {
      kind: "request",
      id: 1,
      method: "point",
      argument: "canvas",
    };
    send(null, configuration.parentOrigin, point);
    send(parent, leafOrigin, point);
    send(parent, configuration.parentOrigin, { ...point, nonce: "wrong" });
    send(parent, configuration.parentOrigin, {
      ...point,
      method: "evaluate",
      argument: "1+1",
    });
    assert.equal(requests.length, 0);
    send(parent, configuration.parentOrigin, point);
    assert.equal(requests.length, 1);
    assert.equal(requests[0]!.origin, leafOrigin);
    const response = { kind: "reply", id: 1, result: { x: 100, y: 30 } };
    send(null, leafOrigin, response);
    send(child, configuration.parentOrigin, response);
    send(child, leafOrigin, { ...response, nonce: "wrong" });
    assert.equal(replies.length, 1);
    send(child, leafOrigin, response);
    const result = replies[1]!.message.result as { x: number; y: number };
    assert.equal(result.x, 145);
    assert.equal(result.y, 85);
    assert.equal(replies[1]!.origin, configuration.parentOrigin);
    send(child, leafOrigin, response);
    assert.equal(
      replies.length,
      2,
      "A duplicate response cannot resolve another request",
    );
  } finally {
    dom.window.close();
  }
});

test("nested placement requires each distinct frame/context/target/session chain", () => {
  const root = {
    ...base,
    mode: "nested-oopif" as const,
    rootContexts: [context("root")],
    targets: [{ type: "iframe", targetId: "target-one", url: base.childUrl }],
    childSessionId: "session-one",
    childSessionTargetId: "target-one",
    childSessionFrameId: "child",
    childAttachedEvent: {
      sessionId: "session-one",
      targetInfo: {
        type: "iframe",
        targetId: "target-one",
        url: base.childUrl,
      },
    },
    childContexts: [context("child")],
    descendant: {
      ...base,
      mode: "cross-origin-oopif" as const,
      rootFrameId: "child",
      childFrameId: "leaf",
      rootContexts: [context("child")],
      childUrl: "http://nested.localhost:30002",
      ownerBackendNodeId: 43,
      targets: [
        {
          type: "iframe",
          targetId: "target-two",
          url: "http://nested.localhost:30002",
        },
      ],
      childSessionId: "session-two",
      childSessionTargetId: "target-two",
      childSessionFrameId: "leaf",
      childAttachedEvent: {
        sessionId: "session-two",
        targetInfo: {
          type: "iframe",
          targetId: "target-two",
          url: "http://nested.localhost:30002",
        },
      },
      childContexts: [context("leaf")],
    },
  };
  assert.doesNotThrow(() => assertRemoteFramePlacement(root));
  assert.throws(
    () => assertRemoteFramePlacement({ ...root, descendant: undefined }),
    /independently observed/,
  );
  assert.throws(() =>
    assertRemoteFramePlacement({
      ...root,
      descendant: { ...root.descendant, rootFrameId: "unrelated" },
    }),
  );
  const local = {
    ...root,
    mode: "nested-same-process" as const,
    descendant: {
      ...root.descendant,
      mode: "cross-origin-same-process" as const,
      rootContexts: [context("child"), context("leaf")],
      targets: [],
    },
  };
  assert.doesNotThrow(() => assertRemoteFramePlacement(local));
  assert.throws(() =>
    assertRemoteFramePlacement({
      ...local,
      descendant: { ...local.descendant, rootContexts: [context("child")] },
    }),
  );
});

test("armed replacement cannot be triggered by a synthetic untrusted pointer event", () => {
  const replies: Record<string, unknown>[] = [];
  const dom = new JSDOM(remoteFrameContractPage("child", configuration), {
    url: configuration.childOrigin,
    runScripts: "dangerously",
    beforeParse(window) {
      window.postMessage = (message: Record<string, unknown>) => {
        replies.push(message);
      };
    },
  });
  try {
    const request = (method: string, id: number) =>
      dom.window.dispatchEvent(
        new dom.window.MessageEvent("message", {
          source: dom.window as unknown as Window,
          origin: configuration.parentOrigin,
          data: { kind: "request", nonce: configuration.nonce, id, method },
        }),
      );
    request("state", 1);
    const original = replies.at(-1)!.result as { documentId: string };
    request("armReplace", 2);
    assert.equal((replies.at(-1)!.result as { armed: boolean }).armed, true);
    dom.window.document
      .querySelector("#canvas")!
      .dispatchEvent(new dom.window.Event("pointerdown", { bubbles: true }));
    request("state", 3);
    const current = replies.at(-1)!.result as {
      documentId: string;
      events: { trusted: boolean }[];
    };
    assert.equal(current.documentId, original.documentId);
    assert.deepEqual(
      Array.from(current.events, (event) => event.trusted),
      [false],
    );
  } finally {
    dom.window.close();
  }
});

async function interruptedFixture(
  pressFailsBeforeDispatch = false,
  unknownKind:
    "base" | "raw-held" | "raw-other" | "plain" | "base-not-held" = "base",
) {
  const source = await readFile(
    new URL("../src/main/browser-parallel-input-smoke.ts", import.meta.url),
    "utf8",
  );
  const parsed = ts.createSourceFile(
    "smoke.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const declaration = parsed.statements.find(
    (node) =>
      ts.isFunctionDeclaration(node) &&
      node.name?.text === "runInterruptedRemoteFrameSmoke",
  );
  assert.ok(declaration);
  const inputs: { method: string; type: string; sessionId: string }[] = [];
  let opened = false,
    pressed = false,
    closed = false,
    pointerAttempts = 0,
    keyAttempts = 0,
    inspections = 0;
  const operations: string[] = [];
  const failures: Record<string, unknown>[] = [];
  const state = () => ({
    mode: "cross-origin-oopif",
    childVisibility: "hidden",
    documentId: pressed ? "replacement" : "original",
    events: pressed
      ? [{ type: "pointerdown", trusted: true, target: "canvas" }]
      : [],
    clicks: 0,
    visibility: "hidden",
  });
  const context = {
    // This VM seam passes plain synthetic observations across realms. Normalize
    // only test assertion values, never the real fixture or provider transport.
    assert: {
      ...assert,
      deepEqual: (actual: unknown, expected: unknown, message?: string) =>
        assert.deepEqual(
          JSON.parse(JSON.stringify(actual)),
          JSON.parse(JSON.stringify(expected)),
          message,
        ),
    },
    AbortSignal,
    assertRemoteFixturePoint,
    console: { error() {} },
    BrowserInputOutcomeUnknownError,
    UserBrowserMutationOutcomeUnknownError,
    Rpc: {
      connect: async () => ({
        evaluate: async (expression: string) => {
          if (expression === "window.contract?.ready === true") return true;
          if (expression === "document.visibilityState") return "hidden";
          if (expression === "window.contract.armReplace()")
            return { armed: true };
          if (expression === "window.contract.state()") return state();
          if (expression === "window.contract.point('canvas')")
            return { ...remotePoint(1), documentId: "original" };
          throw new Error(`Unexpected fixture read ${expression}`);
        },
        send: async (method: string) => {
          assert.equal(method, "Page.captureScreenshot");
          operations.push("setup-compositor");
          return { data: "synthetic-read-only-capture" };
        },
        close() {
          operations.push("close-observer");
        },
      }),
    },
    fetch: async () => ({
      json: async () =>
        closed
          ? []
          : [{ id: "dedicated-owned", webSocketDebuggerUrl: "ws://fixture" }],
    }),
    poll: async (read: () => Promise<unknown>) => {
      for (let count = 0; count < 3; count++) {
        const result = await read();
        if (result !== undefined) return result;
      }
      throw new Error("Bounded synthetic fixture poll expired");
    },
  };
  const invoke = runInNewContext(
    `(${ts
      .transpileModule(declaration.getText(parsed), {
        compilerOptions: { target: ts.ScriptTarget.ES2022 },
      })
      .outputText.trim()
      .replace(/;$/, "")})`,
    context,
  ) as (options: unknown) => Promise<Record<string, unknown>>;
  const backend = {
    open: async () => {
      opened = true;
      operations.push("open-dedicated");
      return { tabId: "dedicated-owned" };
    },
    inspect: async (_session: string, target: string) => {
      assert.equal(target, "dedicated-owned");
      inspections++;
      operations.push("inspect");
      return {
        screenshot: { status: "captured" },
        ...(pressed ? {} : { inputViewport: { width: 100 } }),
        observationId: "fresh",
      };
    },
    pointerClick: async (_session: string, target: string) => {
      pointerAttempts++;
      operations.push("pointer");
      assert.equal(target, "dedicated-owned");
      if (pressFailsBeforeDispatch)
        throw new Error("Known pre-dispatch failure");
      pressed = true;
      inputs.push({
        method: "Input.dispatchMouseEvent",
        type: "mousePressed",
        sessionId: "dedicated-session",
      });
      if (unknownKind === "raw-held" || unknownKind === "raw-other")
        throw new UserBrowserMutationOutcomeUnknownError(
          unknownKind === "raw-held"
            ? "Browser targeted input"
            : "Browser other operation",
          "Child document replaced",
        );
      if (unknownKind === "plain")
        throw new Error(
          "Browser targeted input outcome is unknown (Child document replaced)",
        );
      throw new BrowserInputOutcomeUnknownError(
        new Error("Child document replaced"),
        unknownKind !== "base-not-held",
      );
    },
    keyPress: async (_session: string, target: string) => {
      keyAttempts++;
      assert.equal(target, "dedicated-owned");
      throw new Error("Tab input blocked until physical target closes");
    },
    closeTab: async (_session: string, target: string) => {
      assert.equal(target, "dedicated-owned");
      operations.push("detach-provider");
    },
  };
  return {
    run: () =>
      invoke({
        backend,
        sessionId: "fixture-session",
        endpoint: "http://127.0.0.1:1234",
        url: `${configuration.parentOrigin}/input-contract`,
        browserRpc: {
          send: async (method: string, params: { targetId: string }) => {
            assert.equal(method, "Target.closeTarget");
            assert.equal(params.targetId, "dedicated-owned");
            closed = true;
            operations.push("close-physical-target");
            return { success: true };
          },
        },
        inputs,
        onFailure: (receipt: Record<string, unknown>) => failures.push(receipt),
        guard: async () => {
          operations.push("guard");
        },
      }),
    state: () => ({
      opened,
      closed,
      pointerAttempts,
      keyAttempts,
      inspections,
      inputs,
      operations,
      failures,
    }),
  };
}

test("interrupted-pair harness closes only its dedicated target and never retries or releases", async () => {
  const fixture = await interruptedFixture();
  const result = await fixture.run();
  assert.equal(result.inputDispatches, 1);
  assert.equal(result.successorReleaseDispatches, 0);
  const state = fixture.state();
  assert.equal(state.opened, true);
  assert.equal(state.closed, true);
  assert.equal(state.pointerAttempts, 1);
  assert.equal(
    state.keyAttempts,
    1,
    "Only a different fresh action checks quarantine",
  );
  assert.equal(state.inputs.length, 1);
  assert.equal(
    state.inspections,
    3,
    "Discovery precedes final capture, then quarantine permits one ordinary read",
  );
  assert.deepEqual(state.operations.slice(-3), [
    "detach-provider",
    "close-physical-target",
    "guard",
  ]);
});

test("interrupted-pair harness still closes its dedicated target on an unexpected failure", async () => {
  const fixture = await interruptedFixture(true);
  await assert.rejects(fixture.run());
  const state = fixture.state();
  assert.equal(state.closed, true);
  assert.equal(state.pointerAttempts, 1);
  assert.equal(state.keyAttempts, 0);
  assert.deepEqual(state.inputs, []);
  assert.match(
    String((state.failures[0]!.originalError as { message: string }).message),
    /Known pre-dispatch failure/,
  );
  assert.deepEqual(state.failures[0]!.inputAttempts, []);
  assert.equal(state.failures[0]!.pointerCalls, 1);
  assert.ok(
    state.operations.indexOf("setup-compositor") <
      state.operations.indexOf("pointer"),
  );
});

test("both hosted entrypoints require real provider remote-frame effects", async () => {
  for (const filename of [
    "browser-parallel-input-smoke.ts",
    "user-browser-smoke.ts",
  ]) {
    const source = await readFile(
      new URL(`../src/main/${filename}`, import.meta.url),
      "utf8",
    );
    const parsed = ts.createSourceFile(
      filename,
      source,
      ts.ScriptTarget.Latest,
      true,
    );
    const calls: ts.CallExpression[] = [];
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        node.expression.getText(parsed) === "runTargetedInputContractSmoke"
      )
        calls.push(node);
      ts.forEachChild(node, visit);
    };
    visit(parsed);
    assert.equal(
      calls.length,
      1,
      `${filename} must exercise the shared contract`,
    );
    const argument = calls[0]!.arguments[0]!;
    assert.ok(ts.isObjectLiteralExpression(argument));
    const mode = argument.properties.find(
      (node) =>
        ts.isPropertyAssignment(node) &&
        node.name.getText(parsed) === "remoteFrameInput",
    );
    assert.ok(
      mode &&
        ts.isPropertyAssignment(mode) &&
        ts.isStringLiteral(mode.initializer),
    );
    assert.equal(
      mode.initializer.text,
      "supported",
      `${filename} must not silently accept unsupported provider input`,
    );
  }
});

function remoteState(
  changes: Partial<Parameters<typeof settleRemoteFixturePair>[1]> = {},
): Parameters<typeof settleRemoteFixturePair>[1] {
  return {
    mode: "cross-origin-same-process",
    documentId: "fixture-document-before",
    widgets: {},
    values: { "text-a": "before" },
    events: [],
    clicks: 0,
    visibility: "hidden",
    outer: "contract-frame",
    ...changes,
  };
}

function remoteEvents(kind: "click" | "key", id: string) {
  return (
    kind === "click" ? ["pointerdown", "pointerup"] : ["keydown", "keyup"]
  ).map((type) => ({ type, trusted: true, target: id }));
}

test("remote witness settles only the issued trusted pair and effect through read-only prefixes", async () => {
  for (const kind of ["click", "key"] as const) {
    const id = kind === "click" ? "canvas" : "text-a";
    const events = remoteEvents(kind, id);
    const expectedEffect =
      kind === "click" ? { clicks: 1 } : { values: { "text-a": "before " } };
    const reads = [
      remoteState(),
      remoteState({ events: events.slice(0, 1) }),
      remoteState({ events }),
      remoteState({ events, ...expectedEffect }),
    ];
    let count = 0;
    const result = await settleRemoteFixturePair(
      async () => {
        assert.ok(
          count < reads.length,
          "Settlement must stop at exact completion",
        );
        return reads[count++]!;
      },
      remoteState(),
      kind,
      id,
    );
    assert.equal(result.reads, 4);
    assert.equal(count, 4);
    assert.deepEqual(result.state, reads[3]);
  }
});

test("remote witness rejects wrong targets, trust, ordering, effects or document without retry", async () => {
  const events = remoteEvents("click", "canvas");
  for (const invalid of [
    remoteState({ events: [{ ...events[0]!, target: "text-a" }] }),
    remoteState({ events: [{ ...events[0]!, trusted: false }] }),
    remoteState({ events: [events[1]!] }),
    remoteState({ events: [...events, events[0]!] }),
    remoteState({ events, clicks: 2 }),
    remoteState({ documentId: "replacement-document" }),
    remoteState({ visibility: "visible" }),
  ]) {
    let reads = 0;
    await assert.rejects(
      settleRemoteFixturePair(
        async () => {
          reads++;
          return invalid;
        },
        remoteState(),
        "click",
        "canvas",
      ),
    );
    assert.equal(
      reads,
      1,
      "An invalid witness must fail immediately, without retry",
    );
  }
  await assert.rejects(
    settleRemoteFixturePair(
      async () =>
        remoteState({
          values: { "text-a": "unexpected" },
        }),
      remoteState(),
      "key",
      "text-a",
    ),
    /Unexpected remote text effect/u,
  );
  await assert.rejects(
    settleRemoteFixturePair(
      async () => remoteState(),
      remoteState({
        events: [{ type: "keydown", trusted: true, target: "text-a" }],
      }),
      "click",
      "canvas",
    ),
    /history must not change/u,
  );
});

function remotePoint(
  depth: 1 | 2,
): Parameters<typeof assertRemoteFixturePoint>[0] {
  return {
    x: depth === 1 ? 132 : 177,
    y: depth === 1 ? 66 : 121,
    documentId: "fixture-document-before",
    hitId: "canvas",
    localPoint: { x: 100, y: 30 },
    childViewport: {
      width: depth === 1 ? 620 : 400,
      height: depth === 1 ? 480 : 300,
      scrollX: 0,
      scrollY: 0,
    },
    owners: [
      {
        id: "contract-frame",
        hitId: "contract-frame",
        left: 20,
        top: 20,
        width: 644,
        height: 512,
        scrollX: 0,
        scrollY: 0,
      },
      ...(depth === 2
        ? [
            {
              id: "nested-contract-frame",
              hitId: "nested-contract-frame",
              left: 40,
              top: 50,
              width: 410,
              height: 310,
              scrollX: 0,
              scrollY: 0,
            },
          ]
        : []),
    ],
  };
}

test("authored remote point requires current owner geometry and exact parent and inner hits", () => {
  for (const depth of [1, 2] as const) {
    assertRemoteFixturePoint(remotePoint(depth), "canvas", depth);
    for (const change of [
      (point: ReturnType<typeof remotePoint>) => {
        point.hitId = "text-a";
      },
      (point: ReturnType<typeof remotePoint>) => {
        point.x = Number.NaN;
      },
      (point: ReturnType<typeof remotePoint>) => {
        point.owners[depth - 1]!.hitId = "overlay";
      },
      (point: ReturnType<typeof remotePoint>) => {
        point.owners[depth - 1]!.left += 1;
      },
      (point: ReturnType<typeof remotePoint>) => {
        point.owners[depth - 1]!.width += 1;
      },
      (point: ReturnType<typeof remotePoint>) => {
        point.owners[depth - 1]!.scrollY = 1;
      },
      (point: ReturnType<typeof remotePoint>) => {
        point.owners.pop();
      },
      (point: ReturnType<typeof remotePoint>) => {
        point.childViewport.scrollY = 106;
      },
      (point: ReturnType<typeof remotePoint>) => {
        point.childViewport.height = 0;
      },
      (point: ReturnType<typeof remotePoint>) => {
        point.localPoint.y = -76;
      },
    ]) {
      const point = remotePoint(depth);
      change(point);
      assert.throws(() => assertRemoteFixturePoint(point, "canvas", depth));
    }
  }
});

function placementFixture(
  mode: Parameters<typeof observeRemoteFramePlacement>[2],
  fault?:
    | "extra-owner"
    | "wrong-src"
    | "duplicate-target"
    | "wrong-owner"
    | "wrong-parent"
    | "wrong-placeholder"
    | "missing-attached-event"
    | "duplicate-attached-event"
    | "missing-parent-id",
  expectedChildRevision = 0,
) {
  const nested = mode.startsWith("nested-");
  const config = {
    ...configuration,
    mode,
    childOrigin:
      mode === "cross-origin-same-process"
        ? configuration.childOrigin
        : "http://localhost:30002",
    ...(nested
      ? {
          leafOrigin:
            mode === "nested-oopif"
              ? "http://nested.localhost:30002"
              : "http://localhost:30001",
        }
      : {}),
  };
  const url = (
    origin: string,
    pathname: string,
    values: Record<string, string>,
  ) => {
    const result = new URL(pathname, origin);
    for (const [key, value] of Object.entries(values))
      result.searchParams.set(key, value);
    return result.href;
  };
  const rootUrl = url(config.parentOrigin, "/input-contract", config);
  const childUrl = url(config.childOrigin, "/remote-frame-child", {
    ...config,
    ...(expectedChildRevision > 0
      ? { revision: String(expectedChildRevision) }
      : {}),
  });
  const layers = [
    {
      id: "root-frame",
      url: rootUrl,
      session: undefined as string | undefined,
      target: undefined as string | undefined,
      local: mode === "cross-origin-same-process",
      backend: 101,
    },
    {
      id: "child-frame",
      url: childUrl,
      session:
        mode === "cross-origin-same-process" ? undefined : "child-session",
      target:
        mode === "cross-origin-same-process"
          ? undefined
          : "child-target-distinct",
      local: mode === "nested-same-process",
      backend: 202,
    },
    ...(nested
      ? [
          {
            id: "leaf-frame",
            url: url(config.leafOrigin!, "/remote-frame-child", {
              ...config,
              parentOrigin: config.childOrigin,
              childOrigin: config.leafOrigin!,
              leafOrigin: "",
            }),
            session: mode === "nested-oopif" ? "leaf-session" : "child-session",
            target:
              mode === "nested-oopif" ? "leaf-target-distinct" : undefined,
            local: false,
            backend: 303,
          },
        ]
      : []),
  ];
  type Endpoint = Parameters<typeof observeRemoteFramePlacement>[0];
  type Event = Parameters<Parameters<Endpoint["onEvent"]>[0]>[0];
  const rootListeners = new Set<(event: Event) => void>();
  const browserListeners = new Set<(event: Event) => void>();
  const operations: {
    method: string;
    params: Record<string, unknown>;
    sessionId?: string;
  }[] = [];
  const targets = layers
    .filter((layer) => layer.target)
    .map((layer) => ({
      targetId: layer.target!,
      type: "iframe",
      url: layer.url,
    }));
  const send: Endpoint["send"] = async (method, params = {}, sessionId) => {
    operations.push({ method, params, sessionId });
    const layerIndex = sessionId
      ? layers.findIndex((layer) => layer.session === sessionId)
      : 0;
    assert.notEqual(layerIndex, -1);
    const layer = layers[layerIndex]!;
    const child = layers[layerIndex + 1];
    if (method === "Runtime.disable") return {};
    if (method === "Runtime.enable") {
      for (const current of [layer, ...(layer.local && child ? [child] : [])]) {
        const event = {
          method: "Runtime.executionContextCreated",
          params: { context: context(current.id) },
          ...(sessionId ? { sessionId } : {}),
        };
        for (const listener of sessionId ? browserListeners : rootListeners)
          listener(event);
      }
      return {};
    }
    if (method === "Page.getFrameTree")
      return {
        frameTree: {
          frame: {
            id: layer.id,
            url: layer.url,
            ...(layerIndex > 0 && fault !== "missing-parent-id"
              ? {
                  parentId:
                    fault === "wrong-parent"
                      ? "foreign-parent"
                      : layers[layerIndex - 1]!.id,
                }
              : {}),
          },
          ...(child && (layer.local || fault === "wrong-placeholder")
            ? {
                childFrames: [
                  {
                    frame: {
                      id:
                        fault === "wrong-placeholder"
                          ? "foreign-child"
                          : child.id,
                      url: child.url,
                    },
                  },
                ],
              }
            : {}),
        },
      };
    if (method === "DOM.getDocument")
      return { root: { nodeId: layer.backend + 1000 } };
    if (method === "DOM.querySelectorAll") {
      assert.equal(params.nodeId, layer.backend + 1000);
      assert.equal(params.selector, "iframe");
      return {
        nodeIds:
          fault === "extra-owner" ? [layer.backend, 999] : [layer.backend],
      };
    }
    if (method === "DOM.describeNode") {
      assert.equal(params.nodeId, layer.backend);
      assert.ok(child);
      return {
        node: {
          localName: "iframe",
          backendNodeId: layer.backend,
          attributes: [
            "id",
            layerIndex === 0 ? "contract-frame" : "nested-contract-frame",
            "src",
            fault === "wrong-src" ? "http://localhost:1/foreign" : child.url,
          ],
        },
      };
    }
    if (method === "DOM.getFrameOwner") {
      assert.equal(params.frameId, child?.id);
      return { backendNodeId: fault === "wrong-owner" ? 999 : layer.backend };
    }
    if (method === "Target.getTargets")
      return {
        targetInfos:
          fault === "duplicate-target" ? [...targets, targets[0]] : targets,
      };
    if (method === "Target.attachToTarget") {
      const target = targets.find(
        (target) => target.targetId === params.targetId,
      );
      assert.ok(target);
      const attached = layers.find(
        (layer) => layer.target === target.targetId,
      )!;
      assert.equal(params.flatten, true);
      if (fault !== "missing-attached-event")
        for (const listener of browserListeners) {
          const event = {
            method: "Target.attachedToTarget",
            params: { sessionId: attached.session, targetInfo: target },
          };
          listener(event);
          if (fault === "duplicate-attached-event") listener(event);
        }
      return { sessionId: attached.session };
    }
    if (method === "Target.detachFromTarget") return {};
    throw new Error(`Unexpected fixture CDP method ${method}`);
  };
  const endpoint = (listeners: typeof rootListeners): Endpoint => ({
    send,
    onEvent: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  });
  return {
    run: () =>
      observeRemoteFramePlacement(
        endpoint(rootListeners),
        endpoint(browserListeners),
        mode,
        rootUrl,
        expectedChildRevision,
      ),
    operations,
    listeners: () => rootListeners.size + browserListeners.size,
  };
}

test("placement discovery joins omitted remote trees to exact owners and child sessions recursively", async () => {
  for (const mode of [
    "cross-origin-same-process",
    "cross-origin-oopif",
    "nested-oopif",
    "nested-same-process",
  ] as const) {
    const fixture = placementFixture(mode);
    const evidence = await fixture.run();
    assert.equal(evidence.childFrameId, "child-frame");
    assert.equal(evidence.ownerBackendNodeId, 101);
    const replacement = await placementFixture(mode, undefined, 1).run();
    assert.equal(
      new URL(replacement.childUrl).searchParams.get("revision"),
      "1",
    );
    if (replacement.descendant)
      assert.equal(
        new URL(replacement.descendant.childUrl).searchParams.has("revision"),
        false,
      );
    assert.equal(
      evidence.parentTreeChildFrames?.length,
      mode === "cross-origin-same-process" ? 1 : 0,
    );
    if (mode.startsWith("nested-")) {
      assert.equal(evidence.descendant?.childFrameId, "leaf-frame");
      assert.equal(evidence.descendant?.ownerBackendNodeId, 202);
      assert.equal(
        evidence.descendant?.parentTreeChildFrames?.length,
        mode === "nested-same-process" ? 1 : 0,
      );
    }
    assert.equal(fixture.listeners(), 0);
    assert.equal(
      fixture.operations.some(({ method }) => method.startsWith("Input.")),
      false,
    );
    assert.deepEqual(
      fixture.operations
        .filter(({ method }) => method === "Target.detachFromTarget")
        .map(({ params }) => params.sessionId),
      mode === "cross-origin-same-process"
        ? []
        : mode === "nested-oopif"
          ? ["leaf-session", "child-session"]
          : ["child-session"],
    );
  }
  const noParent = await placementFixture(
    "cross-origin-oopif",
    "missing-parent-id",
  ).run();
  assert.equal(noParent.childSessionParentFrameId, undefined);
  assert.equal(
    noParent.ownerBackendNodeId,
    101,
    "Exact native owner join, never an invented parent ID",
  );
});

test("placement discovery refuses ambiguous targets and mismatched ownership and always detaches", async (t) => {
  t.mock.method(console, "error", () => undefined);
  for (const fault of [
    "extra-owner",
    "wrong-src",
    "duplicate-target",
    "wrong-owner",
    "wrong-parent",
    "wrong-placeholder",
    "missing-attached-event",
    "duplicate-attached-event",
  ] as const) {
    const fixture = placementFixture("cross-origin-oopif", fault);
    await assert.rejects(fixture.run(), fault);
    assert.equal(fixture.listeners(), 0);
    const attached = fixture.operations.filter(
      ({ method }) => method === "Target.attachToTarget",
    );
    const detached = fixture.operations.filter(
      ({ method }) => method === "Target.detachFromTarget",
    );
    assert.equal(detached.length, attached.length, fault);
    assert.equal(
      fixture.operations.some(({ method }) => method.startsWith("Input.")),
      false,
    );
  }
});

test("remote fixture focus prevents setup scrolling and reports actual child viewport and point", () => {
  const replies: Record<string, unknown>[] = [];
  const focusCalls: { id: string; preventScroll: boolean | undefined }[] = [];
  const dom = new JSDOM(
    remoteFrameContractPage("child", {
      ...configuration,
      mode: "cross-origin-oopif",
    }),
    {
      url: configuration.childOrigin,
      runScripts: "dangerously",
      beforeParse(window) {
        // This checks authored focus options, not real native viewport timing.
        Object.defineProperties(window, {
          innerWidth: { value: 0, configurable: true },
          innerHeight: { value: 0, configurable: true },
        });
        const focus = window.HTMLElement.prototype.focus;
        window.HTMLElement.prototype.focus = function (
          this: HTMLElement,
          options,
        ) {
          focusCalls.push({
            id: this.id,
            preventScroll: options?.preventScroll,
          });
          return focus.call(this, options);
        };
        window.postMessage = (message: Record<string, unknown>) => {
          replies.push(message);
        };
      },
    },
  );
  try {
    assert.deepEqual(focusCalls, [{ id: "text-a", preventScroll: true }]);
    Object.defineProperties(dom.window, {
      innerWidth: { value: 620 },
      innerHeight: { value: 480 },
    });
    const send = (method: string, argument?: string) =>
      dom.window.dispatchEvent(
        new dom.window.MessageEvent("message", {
          source: dom.window as unknown as Window,
          origin: configuration.parentOrigin,
          data: {
            kind: "request",
            nonce: configuration.nonce,
            id: 1,
            method,
            argument,
          },
        }),
      );
    send("focus", "text-b");
    assert.deepEqual(focusCalls, [
      { id: "text-a", preventScroll: true },
      { id: "text-b", preventScroll: true },
    ]);
    // An externally changed scroll is reported unchanged, never reset/repaired.
    Object.defineProperty(dom.window, "scrollY", { value: 106 });
    dom.window.document.querySelector("#canvas")!.getBoundingClientRect = () =>
      box(0, -106, 200, 60);
    send("point", "canvas");
    const point = JSON.parse(JSON.stringify(replies.at(-1)!.result));
    assert.deepEqual(point.localPoint, { x: 100, y: -76 });
    assert.deepEqual(point.childViewport, {
      width: 620,
      height: 480,
      scrollX: 0,
      scrollY: 106,
    });
    assert.equal(dom.window.scrollY, 106);
    send("state");
    const state = JSON.parse(JSON.stringify(replies.at(-1)!.result));
    assert.deepEqual(state.viewport, point.childViewport);
  } finally {
    dom.window.close();
  }
});

async function routeDiagnosticFixture(
  fault?:
    | "root-press-unknown"
    | "child-owner"
    | "physical-close"
    | "foreground"
    | "provider-detach"
    | "root-visible"
    | "child-visible"
    | "unique-context"
    | "foreign-detach"
    | `${"destroyed" | "cleared" | "replaced" | "detached"}-${"before" | "after"}`,
) {
  const source = await readFile(
    new URL("../src/main/browser-parallel-input-smoke.ts", import.meta.url),
    "utf8",
  );
  const parsed = ts.createSourceFile(
    "smoke.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const declaration = parsed.statements.find(
    (node) =>
      ts.isFunctionDeclaration(node) &&
      node.name?.text === "runRemoteFrameRouteDiagnostics",
  );
  assert.ok(declaration);
  const created: {
    id: string;
    url: string;
    closed: boolean;
    events: ReturnType<typeof remoteEvents>;
    rootEvents: ReturnType<typeof remoteEvents>;
    clicks: number;
  }[] = [];
  const operations: string[] = [];
  const inputs: {
    target: string;
    route: string;
    type: unknown;
    x: unknown;
    y: unknown;
  }[] = [];
  const receipts: Record<string, unknown>[] = [];
  const listeners = new Set<(event: Record<string, unknown>) => void>();
  let current: (typeof created)[number] | undefined;
  let nonce = 0;
  const placement = (record: (typeof created)[number]) => ({
    ...base,
    mode: "cross-origin-oopif" as const,
    rootFrameId: record.id,
    childFrameId: `${record.id}-child`,
    rootContexts: [context(record.id)],
    childUrl: `http://localhost:30002/${record.id}-child`,
    targets: [
      {
        type: "iframe",
        targetId: `${record.id}-target`,
        url: `http://localhost:30002/${record.id}-child`,
      },
    ],
    childSessionId: `${record.id}-observed-session`,
    childSessionTargetId: `${record.id}-target`,
    childSessionFrameId: `${record.id}-child`,
    childSessionParentFrameId: record.id,
    childContexts: [context(`${record.id}-child`)],
    childAttachedEvent: {
      sessionId: `${record.id}-observed-session`,
      targetInfo: {
        type: "iframe",
        targetId: `${record.id}-target`,
        url: `http://localhost:30002/${record.id}-child`,
      },
    },
  });
  const state = (record: (typeof created)[number]) =>
    remoteState({
      mode: "cross-origin-oopif",
      documentId: record.id,
      events: [...record.events],
      clicks: record.clicks,
      routeEvents: [...record.events],
      rootEvents: [...record.rootEvents],
      visibility:
        fault === "root-visible" &&
        record === created[0] &&
        !record.closed &&
        inputs.length > 0
          ? "visible"
          : "hidden",
      childVisibility:
        fault === "child-visible" &&
        record === created[0] &&
        !record.closed &&
        inputs.length > 0
          ? "visible"
          : "hidden",
    });
  const emitLifecycle = (record: (typeof created)[number]) => {
    const sessionId = `${record.id}-dispatch-session`;
    let event: Record<string, unknown>;
    if (fault?.startsWith("destroyed"))
      event = {
        sessionId,
        method: "Runtime.executionContextDestroyed",
        params: { executionContextId: 1 },
      };
    else if (fault?.startsWith("cleared"))
      event = {
        sessionId,
        method: "Runtime.executionContextsCleared",
        params: {},
      };
    else if (fault?.startsWith("replaced"))
      event = {
        sessionId,
        method: "Runtime.executionContextCreated",
        params: {
          context: {
            ...context(`${record.id}-child`),
            uniqueId: "replacement-context",
          },
        },
      };
    else
      event = {
        method: "Target.detachedFromTarget",
        params: {
          sessionId:
            fault === "foreign-detach" ? "unrelated-session" : sessionId,
        },
      };
    operations.push(`lifecycle:${String(fault)}`);
    for (const listener of listeners) listener(event);
  };
  const input = (
    record: (typeof created)[number],
    route: string,
    params: Record<string, unknown>,
  ) => {
    inputs.push({
      target: record.id,
      route,
      type: params.type,
      x: params.x,
      y: params.y,
    });
    operations.push(`input:${record.id}:${String(params.type)}`);
    if (
      fault === "root-press-unknown" &&
      record === created[0] &&
      params.type === "mousePressed"
    )
      throw new Error("unknown press outcome");
    const event = {
      type: params.type === "mousePressed" ? "pointerdown" : "pointerup",
      trusted: true,
      target: route === "root" ? "contract-frame" : "canvas",
    };
    if (route === "root") record.rootEvents.push(event);
    else {
      record.events.push(event);
      if (params.type === "mouseReleased") record.clicks++;
      if (params.type === "mousePressed" && fault?.endsWith("-after"))
        emitLifecycle(record);
    }
    return {};
  };
  const browserRpc = {
    onEvent: (listener: (event: Record<string, unknown>) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    send: async (
      method: string,
      params: Record<string, unknown> = {},
      sessionId?: string,
    ) => {
      assert.ok(current);
      const evidence = placement(current);
      if (method === "Target.attachToTarget") {
        assert.equal(params.targetId, evidence.childSessionTargetId);
        for (const listener of listeners)
          listener({
            method: "Target.attachedToTarget",
            params: {
              sessionId: `${current.id}-dispatch-session`,
              targetInfo: evidence.targets[0],
            },
          });
        return { sessionId: `${current.id}-dispatch-session` };
      }
      if (method === "Runtime.enable") {
        for (const listener of listeners)
          listener({
            method: "Runtime.executionContextCreated",
            sessionId,
            params: { context: context(`${current.id}-child`) },
          });
        return {};
      }
      if (method === "Runtime.evaluate") {
        assert.equal(params.expression, "document.URL");
        assert.equal(
          params.uniqueContextId,
          evidence.childContexts[0]!.uniqueId,
        );
        assert.equal(sessionId, `${current.id}-dispatch-session`);
        operations.push(`unique-context:${current.id}`);
        if (fault === "unique-context")
          return { exceptionDetails: { text: "Context is gone" } };
        return { result: { value: evidence.childUrl } };
      }
      if (method === "Page.getFrameTree")
        return {
          frameTree: {
            frame: {
              id: evidence.childFrameId,
              parentId: evidence.rootFrameId,
              url: evidence.childUrl,
            },
          },
        };
      if (method === "Input.dispatchMouseEvent") {
        assert.equal(sessionId, `${current.id}-dispatch-session`);
        return input(current, "child", params);
      }
      if (method === "Target.detachFromTarget") {
        operations.push(`detach-child:${current.id}`);
        return {};
      }
      if (method === "Target.closeTarget") {
        assert.equal(params.targetId, current.id);
        operations.push(`physical-close:${current.id}`);
        if (fault === "physical-close") return { success: false };
        current.closed = true;
        return { success: true };
      }
      throw new Error(`Unexpected browser command ${method}`);
    },
  };
  const run = runInNewContext(
    `${ts.transpileModule(declaration.getText(parsed), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText}; runRemoteFrameRouteDiagnostics`,
    {
      assert: {
        ...assert,
        deepEqual: (a: unknown, b: unknown, message?: string) =>
          assert.deepEqual(
            JSON.parse(JSON.stringify(a)),
            JSON.parse(JSON.stringify(b)),
            message,
          ),
      },
      URL,
      AbortSignal,
      process: { platform: "darwin" },
      console: { log() {} },
      randomUUID: () => `diagnostic-nonce-${++nonce}`,
      assertRemoteFixturePoint,
      assertRemoteFramePlacement,
      observeRemoteFramePlacement: async () => {
        assert.ok(current);
        return placement(current);
      },
      fetch: async () => ({
        json: async () => [
          { id: "unrelated-user-target", webSocketDebuggerUrl: "unrelated" },
          ...created
            .filter((record) => !record.closed)
            .map((record) => ({
              id: record.id,
              webSocketDebuggerUrl: record.id,
            })),
        ],
      }),
      poll: async (read: () => Promise<unknown>) => {
        const result = await read();
        assert.notEqual(result, undefined);
        return result;
      },
      // The actual bounded settlement helper has separate prefix/deadline tests.
      // Here two read-only samples model absent delivery without a 20s unit wait.
      settleRemoteFixturePair: async (
        read: () => Promise<ReturnType<typeof remoteState>>,
      ) => {
        const first = await read();
        if (first.events.length === 2 && first.clicks === 1)
          return { state: first, reads: 1 };
        await read();
        throw new Error("No child pair observed within diagnostic settlement");
      },
      Rpc: {
        connect: async (id: string) => {
          const record = created.find((record) => record.id === id)!;
          return {
            evaluate: async (expression: string) => {
              if (expression === "window.contract?.ready === true") return true;
              if (expression === "document.visibilityState") return "hidden";
              if (expression === "window.contract.point('canvas')")
                return { ...remotePoint(1), documentId: record.id };
              if (expression === "window.contract.state()")
                return state(record);
              throw new Error(`Unexpected fixture expression ${expression}`);
            },
            send: async (method: string, params: Record<string, unknown>) => {
              if (method === "Page.captureScreenshot") {
                if (
                  record === created[1] &&
                  (fault?.endsWith("-before") || fault === "foreign-detach")
                )
                  emitLifecycle(record);
                return { data: "synthetic-compositor-image" };
              }
              if (method === "DOM.getFrameOwner")
                return {
                  backendNodeId:
                    fault === "child-owner" ? 999 : base.ownerBackendNodeId,
                };
              if (method === "Input.dispatchMouseEvent")
                return input(record, "root", params);
              throw new Error(`Unexpected root command ${method}`);
            },
            close: () => {
              operations.push(`close-observer:${record.id}`);
            },
          };
        },
      },
    },
  ) as (options: Record<string, unknown>) => Promise<void>;
  return {
    run: () =>
      run({
        backend: {
          open: async (_session: string, url: string) => {
            assert.ok(
              created.every((record) => record.closed),
              "Prior target must physically close before a new case",
            );
            current = {
              id: `owned-${created.length}`,
              url,
              closed: false,
              events: [],
              rootEvents: [],
              clicks: 0,
            };
            created.push(current);
            operations.push(`open:${current.id}`);
            return { tabId: current.id };
          },
          closeTab: async (_session: string, id: string) => {
            assert.equal(id, current?.id);
            operations.push(`provider-detach:${id}`);
            if (fault === "provider-detach")
              throw new Error("provider detach failed");
          },
        },
        sessionId: "owned-session",
        endpoint: "http://127.0.0.1:9222",
        url: "http://127.0.0.1:30001/input-contract?mode=cross-origin-oopif",
        browserRpc,
        guard: async () => {
          assert.ok(current);
          operations.push(`guard:${current.id}`);
          if (
            fault === "foreground" &&
            current === created[0] &&
            !current.closed &&
            inputs.length === 1
          )
            throw new Error("foreground changed");
        },
        report: (receipt: Record<string, unknown>) =>
          receipts.push(JSON.parse(JSON.stringify(receipt))),
      }),
    created,
    receipts,
    inputs,
    operations,
    listeners,
  };
}

test("protocol route comparison owns two fresh targets, never falls back, and keeps child coordinates local", async () => {
  const f = await routeDiagnosticFixture();
  await f.run();
  assert.equal(f.created.length, 2);
  assert.notEqual(
    new URL(f.created[0]!.url).searchParams.get("nonce"),
    new URL(f.created[1]!.url).searchParams.get("nonce"),
  );
  assert.ok(f.created.every((record) => record.closed));
  assert.equal(f.listeners.size, 0);
  assert.deepEqual(f.inputs, [
    { target: "owned-0", route: "root", type: "mousePressed", x: 132, y: 66 },
    { target: "owned-0", route: "root", type: "mouseReleased", x: 132, y: 66 },
    { target: "owned-1", route: "child", type: "mousePressed", x: 100, y: 30 },
    { target: "owned-1", route: "child", type: "mouseReleased", x: 100, y: 30 },
  ]);
  for (const [index, operation] of f.operations.entries()) {
    if (operation.startsWith("input:"))
      assert.equal(
        f.operations[index - 1],
        `guard:${operation.split(":")[1]}`,
        "Foreground guard must precede each send, not only each pair",
      );
  }
  assert.equal(f.receipts[0]!.outcome, "inconclusive");
  assert.equal(f.receipts[1]!.outcome, "observed-exact-leaf-pair-and-effect");
  for (const receipt of f.receipts) {
    assert.equal(receipt.providerAcceptance, "not-exercised");
    assert.equal(receipt.layer, "protocol-diagnostic-only");
    assert.equal(receipt.platform, "darwin");
    assert.equal(receipt.dispatchAttempts, 2);
    assert.equal(receipt.acknowledgedDispatches, 2);
    assert.equal(receipt.physicallyClosed, true);
  }
  assert.equal(
    (f.receipts[0]!.after as ReturnType<typeof remoteState>).rootEvents!.length,
    2,
  );
  assert.ok(
    f.operations.indexOf("physical-close:owned-0") <
      f.operations.indexOf("open:owned-1"),
  );
});

for (const fault of [
  "root-press-unknown",
  "foreground",
  "child-owner",
  "provider-detach",
] as const) {
  test(`protocol diagnostic preserves ${fault} and closes the exact target without replay`, async () => {
    const f = await routeDiagnosticFixture(fault);
    if (fault === "foreground") {
      await assert.rejects(f.run(), /foreground changed/);
      assert.equal(f.created.length, 1);
      assert.equal(f.receipts[0]!.fatalSafetyFailure, true);
    } else await f.run();
    assert.ok(f.created.every((record) => record.closed));
    assert.equal(f.listeners.size, 0);
    if (fault === "root-press-unknown" || fault === "foreground")
      assert.deepEqual(
        f.inputs
          .filter((input) => input.target === "owned-0")
          .map((input) => input.type),
        ["mousePressed"],
      );
    if (fault === "root-press-unknown")
      assert.equal(f.receipts[0]!.acknowledgedDispatches, 0);
    if (fault === "foreground")
      assert.match(
        String(f.receipts[0]!.foregroundGuardError),
        /foreground changed/,
      );
    if (fault === "child-owner")
      assert.equal(
        f.inputs.filter((input) => input.target === "owned-1").length,
        0,
      );
    if (fault === "provider-detach")
      assert.ok(f.receipts.every((receipt) => receipt.providerDetachError));
  });
}

test("protocol diagnostic does not start another case after uncertain physical teardown", async () => {
  const f = await routeDiagnosticFixture("physical-close");
  await assert.rejects(f.run(), /physically close/);
  assert.equal(f.created.length, 1);
  assert.equal(f.receipts.length, 1);
  assert.equal(f.receipts[0]!.physicallyClosed, undefined);
  assert.ok(f.receipts[0]!.teardownError);
  assert.equal(f.inputs.length, 2);
});

test("real fixture route witnesses keep root and leaf synthetic events separate and untrusted", async () => {
  const replies: Record<string, unknown>[] = [];
  const child = new JSDOM(remoteFrameContractPage("child", configuration), {
    url: configuration.childOrigin,
    runScripts: "dangerously",
    beforeParse(window) {
      window.postMessage = (message: Record<string, unknown>) => {
        replies.push(message);
      };
    },
  });
  const parent = new JSDOM(remoteFrameContractPage("parent", configuration), {
    url: configuration.parentOrigin,
    runScripts: "dangerously",
  });
  try {
    child.window.document.querySelector("#canvas")!.dispatchEvent(
      new child.window.MouseEvent("mousedown", {
        bubbles: true,
        clientX: 100,
        clientY: 30,
      }),
    );
    child.window.dispatchEvent(
      new child.window.MessageEvent("message", {
        source: child.window as unknown as Window,
        origin: configuration.parentOrigin,
        data: {
          kind: "request",
          nonce: configuration.nonce,
          id: 1,
          method: "state",
        },
      }),
    );
    const childState = JSON.parse(JSON.stringify(replies.at(-1)!.result));
    assert.deepEqual(
      childState.events,
      [],
      "Existing exact pointer/key witness is unchanged",
    );
    assert.deepEqual(childState.routeEvents, [
      {
        type: "mousedown",
        trusted: false,
        target: "canvas",
        clientX: 100,
        clientY: 30,
      },
    ]);
    const frame = parent.window.document.querySelector("iframe")!;
    const send = (data: Record<string, unknown>) =>
      parent.window.dispatchEvent(
        new parent.window.MessageEvent("message", {
          source: frame.contentWindow!,
          origin: configuration.childOrigin,
          data: { nonce: configuration.nonce, ...data },
        }),
      );
    frame.contentWindow!.postMessage = (message: Record<string, unknown>) => {
      send({ kind: "reply", id: message.id, result: childState });
    };
    send({ kind: "ready" });
    frame.dispatchEvent(
      new parent.window.MouseEvent("mousedown", {
        bubbles: true,
        clientX: 132,
        clientY: 66,
      }),
    );
    const result = JSON.parse(
      JSON.stringify(await parent.window.contract.state()),
    );
    assert.deepEqual(result.routeEvents, childState.routeEvents);
    assert.deepEqual(result.rootEvents, [
      {
        type: "mousedown",
        trusted: false,
        target: "contract-frame",
        clientX: 132,
        clientY: 66,
      },
    ]);
    assert.equal(result.childVisibility, childState.visibility);
  } finally {
    child.window.close();
    parent.window.close();
  }
});

for (const fault of ["root-visible", "child-visible"] as const) {
  test(`protocol diagnostic treats ${fault} as fatal even when physical cleanup restores state`, async () => {
    const f = await routeDiagnosticFixture(fault);
    await assert.rejects(f.run(), /must stay hidden/);
    assert.equal(f.created.length, 1);
    assert.equal(f.created[0]!.closed, true);
    assert.equal(f.inputs.length, 1);
    assert.equal(f.receipts[0]!.fatalSafetyFailure, true);
    assert.ok(f.receipts[0]!.visibilityGuardError);
  });
}

for (const lifecycle of [
  "destroyed",
  "cleared",
  "replaced",
  "detached",
] as const) {
  for (const timing of ["before", "after"] as const) {
    test(`diagnostic child ${lifecycle} ${timing} press prevents dispatch to a successor context`, async () => {
      const f = await routeDiagnosticFixture(`${lifecycle}-${timing}`);
      await f.run();
      assert.ok(f.created.every((record) => record.closed));
      assert.equal(f.listeners.size, 0);
      const childInputs = f.inputs.filter(
        (input) => input.target === "owned-1",
      );
      assert.deepEqual(
        childInputs.map((input) => input.type),
        timing === "before" ? [] : ["mousePressed"],
      );
      assert.equal(f.receipts[1]!.outcome, "inconclusive");
      assert.ok(f.receipts[1]!.childLifecycleInvalidatedBy);
      assert.match(String(f.receipts[1]!.error), /context\/session changed/);
    });
  }
}

test("diagnostic evaluates the pinned child unique context before input and ignores unrelated detach", async () => {
  const stale = await routeDiagnosticFixture("unique-context");
  await stale.run();
  assert.equal(
    stale.inputs.filter((input) => input.target === "owned-1").length,
    0,
  );
  assert.ok(stale.created.every((record) => record.closed));
  const unrelated = await routeDiagnosticFixture("foreign-detach");
  await unrelated.run();
  assert.equal(
    unrelated.receipts[1]!.outcome,
    "observed-exact-leaf-pair-and-effect",
  );
});

function affineRemotePoint(reflected = false): ReturnType<typeof remotePoint> {
  const point = remotePoint(2);
  const c = Math.cos(Math.PI / 12),
    s = Math.sin(Math.PI / 12);
  const angle = reflected ? -s : s;
  return {
    ...point,
    outerAffine: true,
    reflected,
    x: 422 + c * (145 + 12 - 322) - angle * (85 + 16 - 256),
    y: 346 + angle * (145 + 12 - 322) + c * (85 + 16 - 256),
    owners: [
      {
        ...point.owners[0]!,
        left: 422 - c * 322 - s * 256,
        top: 346 - s * 322 - c * 256,
        width: c * 644 + s * 512,
        height: s * 644 + c * 512,
      },
      point.owners[1]!,
    ],
  };
}

test("affine remote owner composes the authored matrix after the mixed descendant offset", async () => {
  const config = {
    ...configuration,
    mode: "nested-same-process" as const,
    childOrigin: "http://localhost:30002",
    leafOrigin: "http://localhost:30001",
    outerAffine: "true" as const,
  };
  const dom = new JSDOM(remoteFrameContractPage("parent", config), {
    url: configuration.parentOrigin,
    runScripts: "dangerously",
  });
  try {
    const frame = dom.window.document.querySelector("iframe")!;
    assert.equal(frame.style.transformOrigin, "322px 256px");
    assert.match(frame.style.transform, /^matrix\(/);
    assert.equal(new URL(frame.src).searchParams.get("outerAffine"), "true");
    const expected = affineRemotePoint();
    frame.getBoundingClientRect = () =>
      box(
        expected.owners[0]!.left,
        expected.owners[0]!.top,
        expected.owners[0]!.width,
        expected.owners[0]!.height,
      );
    dom.window.document.elementFromPoint = () => frame;
    const send = (data: Record<string, unknown>) =>
      dom.window.dispatchEvent(
        new dom.window.MessageEvent("message", {
          source: frame.contentWindow as unknown as Window,
          origin: config.childOrigin,
          data: { nonce: config.nonce, ...data },
        }),
      );
    frame.contentWindow!.postMessage = (message: unknown) => {
      const request = message as { id: number; method: string };
      assert.equal(request.method, "point");
      send({
        kind: "reply",
        id: request.id,
        result: {
          ...remotePoint(2),
          x: 145,
          y: 85,
          owners: [remotePoint(2).owners[1]],
        },
      });
    };
    send({ kind: "ready" });
    const actual = await dom.window.contract.point("canvas");
    assertRemoteFixturePoint(actual, "canvas", 2);
    assert.ok(Math.abs(actual.x - expected.x) < 1e-9);
    assert.ok(Math.abs(actual.y - expected.y) < 1e-9);
    const geometry = dom.window.contract.flipTransform();
    assert.deepEqual(geometry.before, geometry.after);
    const flipped = await dom.window.contract.point("canvas");
    assertRemoteFixturePoint(flipped, "canvas", 2);
    assert.ok(Math.abs(flipped.x - affineRemotePoint(true).x) < 1e-9);
    assert.notEqual(flipped.x, actual.x);
    assert.notEqual(flipped.y, actual.y);
    frame.getBoundingClientRect = () => box(-999, -999, 1, 1);
    const wrongBounds = await dom.window.contract.point("canvas");
    assert.equal(
      wrongBounds.x,
      flipped.x,
      "Authored point never follows AABB-derived coordinates",
    );
    assert.throws(() => assertRemoteFixturePoint(wrongBounds, "canvas", 2));
  } finally {
    dom.window.close();
  }
});

test("provider route oracle distinguishes top, leaf, and mixed renderer-root coordinates", () => {
  const root = { sessionId: "provider-root", socketId: 7 };
  const point = affineRemotePoint();
  for (const mode of [
    "cross-origin-same-process",
    "cross-origin-oopif",
    "nested-oopif",
    "nested-same-process",
  ] as const) {
    const placement = {
      ...base,
      mode,
      childSessionTargetId: "outer-target",
      descendant: {
        ...base,
        mode: "cross-origin-oopif" as const,
        rootFrameId: "child",
        childFrameId: "leaf",
        childSessionTargetId: "leaf-target",
      },
    };
    const remote = mode !== "cross-origin-same-process";
    const nested = mode === "nested-oopif";
    const coordinate = !remote
      ? point
      : mode === "nested-same-process"
        ? { x: 145, y: 85 }
        : point.localPoint;
    const inputs = ["mousePressed", "mouseReleased"].map((type) => ({
      method: "Input.dispatchMouseEvent",
      type,
      sessionId: remote ? "provider-child" : root.sessionId,
      socketId: root.socketId,
      x: coordinate.x,
      y: coordinate.y,
      route: {
        targetId: nested ? "leaf-target" : "outer-target",
        frameId: nested ? "leaf" : "child",
        parentFrameId: nested ? "child" : "root",
        parentSessionId: nested ? "provider-outer" : root.sessionId,
        parentTargetId: nested ? "outer-target" : undefined,
        grandparentSessionId: nested ? root.sessionId : undefined,
      },
    }));
    assert.doesNotThrow(() =>
      assertRemoteProviderRoute({
        kind: "click",
        inputs,
        root,
        placement,
        point,
      }),
    );
    for (const change of [
      (input: (typeof inputs)[number]) => {
        input.x += 1;
      },
      (input: (typeof inputs)[number]) => {
        input.socketId++;
      },
      (input: (typeof inputs)[number]) => {
        input.sessionId = "different-session";
      },
      ...(remote
        ? [
            (input: (typeof inputs)[number]) => {
              input.route.targetId = "wrong-target";
            },
            (input: (typeof inputs)[number]) => {
              input.route.frameId = input.route.targetId;
            },
            (input: (typeof inputs)[number]) => {
              input.route.parentFrameId = "unrelated-frame";
            },
            ...(nested
              ? [
                  (input: (typeof inputs)[number]) => {
                    input.route.grandparentSessionId = "foreign-root-session";
                  },
                ]
              : []),
            (input: (typeof inputs)[number]) => {
              if (nested) input.route.parentTargetId = "wrong-parent-target";
              else input.route.parentSessionId = "wrong-parent-session";
            },
          ]
        : []),
    ]) {
      const changed = structuredClone(inputs);
      change(changed[0]!);
      assert.throws(() =>
        assertRemoteProviderRoute({
          kind: "click",
          inputs: changed,
          root,
          placement,
          point,
        }),
      );
    }
    if (mode === "nested-same-process") {
      const leafLocal = inputs.map((input) => ({
        ...input,
        ...point.localPoint,
      }));
      assert.throws(() =>
        assertRemoteProviderRoute({
          kind: "click",
          inputs: leafLocal,
          root,
          placement,
          point,
        }),
      );
    }
    const keys = ["keyDown", "keyUp"].map((type) => ({
      method: "Input.dispatchKeyEvent",
      type,
      sessionId: root.sessionId,
      socketId: root.socketId,
    }));
    assert.doesNotThrow(() =>
      assertRemoteProviderRoute({ kind: "key", inputs: keys, root, placement }),
    );
    assert.throws(() =>
      assertRemoteProviderRoute({
        kind: "key",
        inputs: keys.map((input) => ({
          ...input,
          sessionId: "provider-child",
        })),
        root,
        placement,
      }),
    );
  }
});

test("actual passive provider tap joins trusted attachment ancestry and native frame replies before Input attempts", async () => {
  const source = await readFile(
    new URL("../src/main/browser-parallel-input-smoke.ts", import.meta.url),
    "utf8",
  );
  const parsed = ts.createSourceFile(
    "smoke.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const declaration = parsed.statements.find(
    (statement) =>
      ts.isFunctionDeclaration(statement) &&
      statement.name?.text === "runTargetedInputContractSmoke",
  ) as ts.FunctionDeclaration;
  const statements = declaration.body!.statements;
  const witness = statements.filter(
    (statement) =>
      statement.getText(parsed).startsWith("const providerSockets =") ||
      statement
        .getText(parsed)
        .startsWith("WebSocket.prototype.send = function"),
  );
  assert.equal(witness.length, 2);
  class Socket extends EventEmitter {
    constructor(readonly url: string) {
      super();
    }
    send(_body: string) {
      /* Native send is never rewritten by the fixture. */
    }
  }
  const inputs: Record<string, unknown>[] = [];
  const excluded = new Socket("browser-socket");
  const socket = new Socket("browser-socket");
  const control = runInNewContext(
    ts.transpileModule(
      witness.map((statement) => statement.getText(parsed)).join("\n") +
        ";({providerSockets})",
      { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
    ).outputText,
    {
      WebSocket: Socket,
      originalSend: Socket.prototype.send,
      version: { webSocketDebuggerUrl: "browser-socket" },
      placementRpc: { socket: excluded },
      inputs,
      assert,
    },
  ) as { providerSockets: Map<Socket, { listener(raw: unknown): void }> };
  const send = (body: unknown) => socket.send(JSON.stringify(body));
  const receive = (body: unknown) =>
    socket.emit("message", JSON.stringify(body));
  send({ id: 1, method: "Runtime.enable", sessionId: "root-session" });
  receive({
    method: "Target.attachedToTarget",
    sessionId: "root-session",
    params: {
      sessionId: "outer-session",
      targetInfo: { type: "iframe", targetId: "outer-target" },
    },
  });
  receive({
    method: "Target.attachedToTarget",
    sessionId: "outer-session",
    params: {
      sessionId: "leaf-session",
      targetInfo: { type: "iframe", targetId: "leaf-target" },
    },
  });
  send({ id: 20, method: "Page.getFrameTree", sessionId: "leaf-session" });
  receive({
    id: 20,
    sessionId: "foreign-session",
    result: {
      frameTree: { frame: { id: "forged-frame", parentId: "forged-parent" } },
    },
  });
  send({
    id: 21,
    method: "Input.dispatchMouseEvent",
    sessionId: "leaf-session",
    params: { type: "mousePressed", x: 100, y: 30 },
  });
  assert.equal(
    (inputs.pop()!.route as { frameId?: string }).frameId,
    undefined,
    "Mismatched reply session must not bind frame identity",
  );
  send({ id: 2, method: "Page.getFrameTree", sessionId: "leaf-session" });
  receive({
    id: 2,
    sessionId: "leaf-session",
    result: {
      frameTree: {
        frame: { id: "leaf-native-frame", parentId: "outer-native-frame" },
      },
    },
  });
  send({
    id: 3,
    method: "Input.dispatchMouseEvent",
    sessionId: "leaf-session",
    params: { type: "mousePressed", x: 100, y: 30 },
  });
  assert.equal(inputs.length, 1, "Attempts are recorded before any ACK");
  const first = JSON.parse(JSON.stringify(inputs[0]));
  assert.deepEqual(first.route, {
    targetId: "leaf-target",
    parentSessionId: "outer-session",
    parentTargetId: "outer-target",
    grandparentSessionId: "root-session",
    frameId: "leaf-native-frame",
    parentFrameId: "outer-native-frame",
  });
  assert.equal(first.x, 100);
  receive({
    method: "Target.detachedFromTarget",
    params: { sessionId: "leaf-session" },
  });
  send({
    id: 4,
    method: "Input.dispatchMouseEvent",
    sessionId: "leaf-session",
    params: { type: "mouseReleased", x: 100, y: 30 },
  });
  assert.deepEqual(
    JSON.parse(JSON.stringify(inputs[1])).route,
    {},
    "Detached session cannot retain native route authority",
  );
  excluded.send(
    JSON.stringify({
      method: "Input.dispatchMouseEvent",
      sessionId: "diagnostic-only",
      params: { type: "mousePressed" },
    }),
  );
  assert.equal(inputs.length, 2);
  for (const [observed, value] of control.providerSockets)
    observed.off("message", value.listener);
});

test("interrupted fixture recognizes only the exact raw targeted-input unknown wrapper", async () => {
  const raw = await interruptedFixture(false, "raw-held");
  const report = await raw.run();
  assert.equal(report.inputDispatches, 1);
  assert.equal(raw.state().keyAttempts, 1);
  assert.equal(raw.state().closed, true);
  for (const kind of ["raw-other", "plain", "base-not-held"] as const) {
    const wrong = await interruptedFixture(false, kind);
    await assert.rejects(wrong.run());
    assert.equal(wrong.state().pointerAttempts, 1);
    assert.equal(wrong.state().keyAttempts, 0);
    assert.equal(wrong.state().inputs.length, 1);
    assert.equal(wrong.state().closed, true);
    assert.equal(wrong.state().failures.length, 1);
  }
});
