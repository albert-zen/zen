import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { BrowserInputOutcomeUnknownError } from "../src/main/capabilities/browser-targeted-input.js";
import { JSDOM } from "jsdom";
import {
  assertRemoteFramePlacement,
  assertRemoteFixturePoint,
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

async function interruptedFixture(pressFailsBeforeDispatch = false) {
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
  const state = () => ({
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
    BrowserInputOutcomeUnknownError,
    Rpc: {
      connect: async () => ({
        evaluate: async (expression: string) => {
          if (expression === "window.contract?.ready === true") return true;
          if (expression === "document.visibilityState") return "hidden";
          if (expression === "window.contract.armReplace()")
            return { armed: true };
          if (expression === "window.contract.state()") return state();
          if (expression === "window.contract.point('canvas')")
            return { x: 100, y: 100 };
          throw new Error(`Unexpected fixture read ${expression}`);
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
      return {
        screenshot: { status: "captured" },
        ...(pressed ? {} : { inputViewport: { width: 100 } }),
        observationId: "fresh",
      };
    },
    pointerClick: async (_session: string, target: string) => {
      pointerAttempts++;
      assert.equal(target, "dedicated-owned");
      if (pressFailsBeforeDispatch)
        throw new Error("Known pre-dispatch failure");
      pressed = true;
      inputs.push({
        method: "Input.dispatchMouseEvent",
        type: "mousePressed",
        sessionId: "dedicated-session",
      });
      throw new BrowserInputOutcomeUnknownError(
        new Error("Child document replaced"),
        true,
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
    2,
    "Quarantine permits one read without waiting for input metadata",
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
    x: 132,
    y: 66,
    documentId: "fixture-document-before",
    hitId: "canvas",
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
    ]) {
      const point = remotePoint(depth);
      change(point);
      assert.throws(() => assertRemoteFixturePoint(point, "canvas", depth));
    }
  }
});
