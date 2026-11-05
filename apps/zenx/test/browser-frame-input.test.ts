import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { BrowserFrameEvidence } from "../src/main/capabilities/browser-frame-evidence.js";
import {
  BrowserFrameInputObserver,
  browserFrameCaptureFor,
  browserFrameInputNeedsObserver,
} from "../src/main/capabilities/browser-frame-input.js";
import { dispatchBrowserTargetedInput } from "../src/main/capabilities/browser-targeted-input.js";

function fixture(remote = true, nested = false, omitRemote = false) {
  const evidence = new BrowserFrameEvidence("root-route");
  const frames = [
    {
      id: "main",
      session: "root-route",
      parent: undefined,
      width: 1000,
      height: 800,
      quad: undefined,
    },
    {
      id: "same-process",
      session: nested ? "parent-route" : "root-route",
      parent: "main",
      width: 200,
      height: 150,
      quad: nested
        ? [10, 20, 410, 20, 410, 320, 10, 320]
        : [10, 20, 210, 20, 210, 170, 10, 170],
    },
    {
      id: "inner",
      session: remote ? "child-route" : nested ? "parent-route" : "root-route",
      parent: "same-process",
      width: 80,
      height: 60,
      quad: nested
        ? [30, 40, 110, 40, 110, 100, 30, 100]
        : [40, 60, 120, 60, 120, 120, 40, 120],
    },
  ];
  const windows = new Map(
    frames.map((frame) => [
      frame.id,
      new JSDOM('<body><input id="leaf"></body>', {
        url: `https://${frame.id}.test/`,
        runScripts: "outside-only",
      }).window,
    ]),
  );
  const nodeIds = new WeakMap<object, number>();
  const nodesByBackend = new Map<number, object>();
  const objects = new Map<string, { node: object; frame: string }>();
  const contexts = new Map<
    string,
    { frame: string; id: number; uniqueId: string; name: string }
  >();
  let nextNode = 100,
    nextObject = 1;
  const attached = new Set<string>();
  let current = true;
  const calls: {
    session: string;
    method: string;
    params: Record<string, unknown>;
  }[] = [];
  const owners = new Map<string, HTMLElement>();
  const backend = (node: object) => {
    let id = nodeIds.get(node);
    if (!id) {
      id = nextNode++;
      nodeIds.set(node, id);
      nodesByBackend.set(id, node);
    }
    return id;
  };
  for (const frame of frames) {
    const window = windows.get(frame.id)!;
    Object.defineProperties(window, {
      innerWidth: { value: frame.width },
      innerHeight: { value: frame.height },
    });
    window.document.elementFromPoint = () =>
      window.document.getElementById("leaf");
    if (frame.parent) {
      const parent = windows.get(frame.parent)!;
      const owner = parent.document.createElement("iframe");
      owner.style.cssText = `width:${frame.width}px;height:${frame.height}px;border:0;padding:0`;
      parent.document.body.append(owner);
      Object.defineProperties(owner, {
        clientWidth: { value: frame.width },
        clientHeight: { value: frame.height },
      });
      owners.set(frame.id, owner);
      backend(owner);
      parent.document.elementFromPoint = () => owner;
      owner.focus();
    }
  }
  windows.get("inner")!.document.getElementById("leaf")!.focus();
  const frameRecord = (id: string) => {
    const frame = frames.find((f) => f.id === id)!;
    return {
      id,
      loaderId: "loader-" + id,
      url: `https://${id}.test/`,
      ...(frame.parent ? { parentId: frame.parent } : {}),
    };
  };
  const tree = (id: string): unknown => {
    const childId =
      id === "main"
        ? "same-process"
        : id === "same-process"
          ? "inner"
          : undefined;
    const own = frames.find((frame) => frame.id === id)!;
    const child = frames.find((frame) => frame.id === childId);
    return {
      frame: frameRecord(id),
      ...(child && (!omitRemote || child.session === own.session)
        ? { childFrames: [tree(child.id)] }
        : {}),
    };
  };
  const createContext = (session: string, frame: string, name: string) => {
    const key = session + "|" + frame + "|" + name;
    let context = contexts.get(key);
    if (!context) {
      context = {
        frame,
        id: contexts.size + 1,
        uniqueId: "context-" + key,
        name,
      };
      contexts.set(key, context);
      evidence.acceptEvent(session, "Runtime.executionContextCreated", {
        context: {
          ...context,
          auxData: { frameId: frame, isDefault: name === "" },
        },
      });
    }
    return context;
  };
  const wrap = (node: object, frame: string) => {
    const objectId = "object-" + nextObject++;
    objects.set(objectId, { node, frame });
    return { subtype: "node", objectId };
  };
  const observer = new BrowserFrameInputObserver(evidence, {
    assertCurrent() {
      if (!current) throw Error("owner retired");
    },
    async send(session, method, params) {
      calls.push({ session, method, params });
      if (method === "Page.getFrameTree")
        return {
          frameTree: tree(
            session === "child-route"
              ? "inner"
              : session === "parent-route"
                ? "same-process"
                : "main",
          ),
        };
      if (method === "Runtime.enable") {
        for (const frame of frames.filter((f) => f.session === session))
          createContext(session, frame.id, "");
        return {};
      }
      if (method === "Page.enable") return {};
      if (method === "Target.setAutoAttach") {
        const child =
          nested && session === "root-route"
            ? "parent-route"
            : remote && session === (nested ? "parent-route" : "root-route")
              ? "child-route"
              : undefined;
        if (child && !attached.has(child)) {
          attached.add(child);
          evidence.acceptEvent(session, "Target.attachedToTarget", {
            sessionId: child,
            targetInfo: { type: "iframe", targetId: "target-" + child },
            waitingForDebugger: false,
          });
        }
        return {};
      }
      if (method === "Page.createIsolatedWorld")
        return {
          executionContextId: createContext(
            session,
            String(params.frameId),
            String(params.worldName),
          ).id,
        };
      if (method === "Runtime.evaluate") {
        const context = [...contexts.values()].find(
          (c) => c.uniqueId === params.uniqueContextId,
        );
        assert.ok(context, "unique context required");
        const value = windows
          .get(context.frame)!
          .eval(String(params.expression));
        return {
          result: params.returnByValue
            ? { value }
            : value
              ? wrap(value, context.frame)
              : { value: null },
        };
      }
      if (method === "DOM.getFrameOwner")
        return { backendNodeId: backend(owners.get(String(params.frameId))!) };
      if (method === "DOM.resolveNode") {
        const context = [...contexts.values()].find(
          (c) => c.id === params.executionContextId,
        );
        assert.ok(context);
        const owner = [...owners.entries()].find(
          ([, owner]) => backend(owner) === params.backendNodeId,
        );
        assert.ok(owner);
        assert.equal(
          frames.find((f) => f.id === owner[0])!.parent,
          context.frame,
        );
        return { object: wrap(owner[1], context.frame) };
      }
      if (method === "DOM.describeNode") {
        const entry = params.objectId
          ? objects.get(String(params.objectId))
          : undefined;
        const owner = [...owners.entries()].find(
          ([, owner]) =>
            backend(owner) ===
            (params.backendNodeId ?? (entry && backend(entry.node))),
        );
        const node =
          entry?.node ??
          owner?.[1] ??
          nodesByBackend.get(params.backendNodeId as number);
        assert.ok(node);
        return {
          node: {
            nodeType: 1,
            backendNodeId: backend(node),
            localName: (node as Element).localName,
            attributes: [],
            ...(owner ? { frameId: owner[0] } : {}),
          },
        };
      }
      if (method === "DOM.getBoxModel") {
        const owner = [...owners.entries()].find(
          ([, owner]) => backend(owner) === params.backendNodeId,
        );
        assert.ok(owner);
        return {
          model: { content: frames.find((f) => f.id === owner[0])!.quad },
        };
      }
      if (method === "Runtime.callFunctionOn") {
        const entry = objects.get(String(params.objectId));
        assert.ok(entry);
        const fn = windows
          .get(entry.frame)!
          .eval("(" + params.functionDeclaration + ")") as (
          ...args: unknown[]
        ) => unknown;
        const value = fn.apply(
          entry.node,
          ((params.arguments as { value: unknown }[]) ?? []).map(
            (arg) => arg.value,
          ),
        );
        return {
          result: params.returnByValue
            ? { value }
            : value
              ? wrap(value as object, entry.frame)
              : { value: null },
        };
      }
      if (method === "Runtime.releaseObject") {
        objects.delete(String(params.objectId));
        return {};
      }
      throw Error("unexpected " + method);
    },
  });
  return {
    evidence,
    observer,
    calls,
    windows,
    frames,
    owners,
    objects,
    retire() {
      current = false;
    },
    close() {
      for (const window of windows.values()) window.close();
    },
  };
}

for (const remote of [false, true])
  test(`${remote ? "OOPIF" : "same-process cross-origin"} uses disjoint documents and exact owner chain`, async () => {
    const f = fixture(remote);
    try {
      const capture = await f.observer.prepare();
      assert.ok(capture);
      assert.equal(browserFrameCaptureFor(capture.snapshot), capture);
      assert.equal(capture.snapshot.frameDocuments?.length, 2);
      assert.equal(capture.snapshot.inputRevision, 0);
      assert.ok(capture.snapshot.focusId?.includes("inner"));
      const hit = await capture.probe({ kind: "click", x: 55, y: 75 });
      assert.ok(hit.pointerHitId?.includes("inner"));
      assert.deepEqual(
        hit.frameDocuments?.[1]?.geometry.contentQuad,
        [40, 60, 120, 60, 120, 120, 40, 120],
      );
      assert.equal(f.objects.size, 0);
      assert.equal(
        f.calls.some((call) => call.method.startsWith("Input.")),
        false,
      );
      const events: unknown[] = [];
      await dispatchBrowserTargetedInput(
        {
          assertCurrent: () => capture.assertCurrent(),
          snapshot: () => capture.probe({ kind: "click", x: 55, y: 75 }),
          beforeDispatch() {},
          quarantine(error) {
            throw error;
          },
          async dispatch(method, params, done) {
            events.push([method, params]);
            done();
          },
        },
        capture.snapshot,
        { kind: "click", x: 55, y: 75 },
      );
      assert.equal(events.length, 2);
    } finally {
      f.close();
    }
  });

test("ancestor occlusion cannot authorize a remote descendant", async () => {
  const f = fixture();
  try {
    const capture = (await f.observer.prepare())!;
    f.windows.get("main")!.document.elementFromPoint = () =>
      f.windows.get("main")!.document.getElementById("leaf");
    const hit = await capture.probe({ kind: "click", x: 55, y: 75 });
    assert.ok(hit.pointerHitId?.includes("main"));
    assert.ok(!hit.pointerHitId?.includes('"inner"'));
  } finally {
    f.close();
  }
});

test("child context replacement and detach retire screenshot authority with zero Input", async () => {
  for (const method of [
    "Runtime.executionContextDestroyed",
    "Target.detachedFromTarget",
  ]) {
    const f = fixture();
    try {
      const capture = (await f.observer.prepare())!;
      if (method === "Target.detachedFromTarget")
        f.evidence.acceptEvent("root-route", method, {
          sessionId: "child-route",
        });
      else
        f.evidence.acceptEvent("child-route", method, {
          executionContextId: 999,
        });
      await assert.rejects(
        capture.probe({ kind: "key", key: "Enter" }),
        /changed/,
      );
      assert.equal(
        f.calls.some((call) => call.method.startsWith("Input.")),
        false,
      );
    } finally {
      f.close();
    }
  }
});

test("native geometry movement cannot reuse the observed screenshot", async () => {
  const f = fixture();
  try {
    const capture = (await f.observer.prepare())!;
    f.frames[2]!.quad = [42, 60, 122, 60, 122, 120, 42, 120];
    const fresh = await capture.probe({ kind: "click", x: 55, y: 75 });
    assert.notDeepEqual(fresh.frameDocuments, capture.snapshot.frameDocuments);
    let sends = 0;
    await assert.rejects(
      dispatchBrowserTargetedInput(
        {
          assertCurrent: () => capture.assertCurrent(),
          snapshot: async () => fresh,
          beforeDispatch() {},
          quarantine() {},
          async dispatch() {
            sends++;
          },
        },
        capture.snapshot,
        { kind: "click", x: 55, y: 75 },
      ),
      /changed/,
    );
    assert.equal(sends, 0);
  } finally {
    f.close();
  }
});

test("top-level capability does not require child session support", async () => {
  assert.equal(
    browserFrameInputNeedsObserver(
      { frameTree: { frame: { id: "root" } } },
      undefined,
    ),
    false,
  );
  assert.equal(
    browserFrameInputNeedsObserver(
      {
        frameTree: {
          frame: { id: "root" },
          childFrames: [{ frame: { id: "child" } }],
        },
      },
      { frameDocuments: [{}] },
    ),
    false,
  );
  assert.equal(
    browserFrameInputNeedsObserver(
      {
        frameTree: {
          frame: { id: "root" },
          childFrames: [{ frame: { id: "child" } }],
        },
      },
      { frameDocuments: [] },
    ),
    true,
  );
});

test("nested OOPIF composes renderer-local quad through nonidentity outer owner exactly once", async () => {
  const f = fixture(true, true);
  try {
    const capture = (await f.observer.prepare())!;
    const inner = capture.snapshot.frameDocuments![1]!;
    assert.deepEqual(
      inner.geometry.contentQuad,
      [70, 100, 230, 100, 230, 220, 70, 220],
    );
    const hit = await capture.probe({ kind: "click", x: 90, y: 120 });
    assert.ok(hit.pointerHitId?.includes("inner"));
  } finally {
    f.close();
  }
});

test("failed or uncertain child setup is not replayed by a later inspection", async () => {
  const f = fixture();
  try {
    const send = f.observer.port.send;
    let attempts = 0;
    f.observer.port.send = async (session, method, params) => {
      if (method === "Target.setAutoAttach") {
        attempts++;
        throw Error("outcome unknown");
      }
      return await send(session, method, params);
    };
    await assert.rejects(f.observer.prepare(), /unknown/);
    await assert.rejects(f.observer.prepare(), /unknown/);
    assert.equal(attempts, 1);
  } finally {
    f.close();
  }
});

test("current action cancellation guard fences every frame probe command", async () => {
  const f = fixture();
  try {
    const capture = (await f.observer.prepare())!;
    const count = f.calls.length;
    await assert.rejects(
      capture.probe({ kind: "key", key: "Enter" }, () => {
        throw Error("current action canceled");
      }),
      /canceled/,
    );
    assert.equal(f.calls.length, count);
  } finally {
    f.close();
  }
});

test("native frame owner mismatch cannot borrow a different iframe node", async () => {
  const f = fixture();
  try {
    const send = f.observer.port.send;
    f.observer.port.send = async (session, method, params) => {
      const response = await send(session, method, params);
      if (method === "DOM.describeNode" && params.backendNodeId !== undefined)
        return {
          ...(response as object),
          node: {
            ...(response as { node: object }).node,
            frameId: "foreign-frame",
          },
        };
      return response;
    };
    await assert.rejects(f.observer.prepare(), /identity/);
    assert.equal(
      f.calls.some((call) => call.method.startsWith("Input.")),
      false,
    );
  } finally {
    f.close();
  }
});

test("child mutation remains part of screenshot comparison even before pointer traversal", async () => {
  const f = fixture();
  try {
    const capture = (await f.observer.prepare())!;
    f.windows.get("inner")!.document.body.setAttribute("data-changed", "yes");
    const fresh = await capture.probe();
    assert.equal(fresh.layoutRevision, capture.snapshot.layoutRevision + 1);
    let sent = 0;
    await assert.rejects(
      dispatchBrowserTargetedInput(
        {
          assertCurrent: () => capture.assertCurrent(),
          snapshot: async () => fresh,
          beforeDispatch() {},
          quarantine() {},
          async dispatch() {
            sent++;
          },
        },
        capture.snapshot,
        { kind: "key", key: "Enter" },
      ),
      /changed/,
    );
    assert.equal(sent, 0);
  } finally {
    f.close();
  }
});

test("owner stylesheet is verified again after native geometry reads", async () => {
  const f = fixture();
  try {
    const send = f.observer.port.send;
    let reads = 0;
    f.observer.port.send = async (session, method, params) => {
      const response = await send(session, method, params);
      if (method === "DOM.getBoxModel" && ++reads === 2)
        f.owners.get("inner")!.style.transform =
          "matrix3d(1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1)";
      return response;
    };
    await assert.rejects(f.observer.prepare());
    assert.equal(
      f.calls.some((call) => call.method.startsWith("Input.")),
      false,
    );
  } finally {
    f.close();
  }
});

test("global depth9 mixed renderer graph is rejected despite bounded per-route trees", async () => {
  const evidence = new BrowserFrameEvidence("r0");
  const enabled = new Set<string>();
  let worldCalls = 0;
  const ranges: Record<string, [number, number]> = {
    r0: [0, 3],
    r1: [4, 7],
    r2: [8, 9],
  };
  const node = (id: number, end: number): unknown => ({
    frame: {
      id: "f" + id,
      loaderId: "l" + id,
      url: "https://frame.test/" + id,
      ...(id ? { parentId: "f" + (id - 1) } : {}),
    },
    ...(id < end ? { childFrames: [node(id + 1, end)] } : {}),
  });
  const observer = new BrowserFrameInputObserver(evidence, {
    assertCurrent() {},
    async send(session, method) {
      const [start, end] = ranges[session]!;
      if (method === "Page.getFrameTree")
        return { frameTree: node(start, Math.min(9, end + 1)) };
      if (method === "Page.enable") return {};
      if (method === "Runtime.enable") {
        for (let id = start; id <= end; id++)
          evidence.acceptEvent(session, "Runtime.executionContextCreated", {
            context: {
              id: id + 1,
              uniqueId: "unique" + id,
              name: "",
              auxData: { frameId: "f" + id, isDefault: true },
            },
          });
        return {};
      }
      if (method === "Target.setAutoAttach") {
        if (session !== "r2" && !enabled.has(session)) {
          enabled.add(session);
          const child = session === "r0" ? "r1" : "r2";
          evidence.acceptEvent(session, "Target.attachedToTarget", {
            sessionId: child,
            targetInfo: { type: "iframe", targetId: "target" + child },
            waitingForDebugger: false,
          });
        }
        return {};
      }
      if (method === "Page.createIsolatedWorld") worldCalls++;
      throw Error("unexpected " + method);
    },
  });
  await assert.rejects(observer.prepare(), /identity/);
  assert.equal(worldCalls, 0);
});

for (const method of [
  "Page.navigatedWithinDocument",
  "Page.frameStartedNavigating",
  "Page.frameStartedLoading",
  "Page.documentOpened",
])
  test(
    method +
      " invalidates old capture but preserves proven live contexts for fresh inspect",
    async () => {
      const f = fixture();
      try {
        const old = (await f.observer.prepare())!;
        const contexts = f.evidence.contexts("child-route");
        f.evidence.acceptEvent(
          "child-route",
          method,
          method === "Page.documentOpened"
            ? {
                frame: {
                  id: "inner",
                  parentId: "same-process",
                  loaderId: "loader-inner",
                  url: "https://inner.test/",
                },
              }
            : { frameId: "inner", url: "https://inner.test/#next" },
        );
        await assert.rejects(
          old.probe({ kind: "key", key: "Enter" }),
          /changed/,
        );
        assert.deepEqual(f.evidence.contexts("child-route"), contexts);
        const fresh = await f.observer.prepare();
        assert.ok(fresh);
        assert.ok(
          (await fresh.probe({ kind: "key", key: "Enter" })).focusId?.includes(
            "inner",
          ),
        );
      } finally {
        f.close();
      }
    },
  );

test("omitted remote child trees are discovered only through exact parent-derived sessions", async () => {
  const f = fixture(true, true, true);
  try {
    const rootTree = await f.observer.port.send(
      "root-route",
      "Page.getFrameTree",
      {},
    );
    assert.equal(
      (rootTree as { frameTree: { childFrames?: unknown } }).frameTree
        .childFrames,
      undefined,
    );
    assert.equal(
      browserFrameInputNeedsObserver(rootTree, {
        frameDocuments: [],
        frameOwnerIds: ["exact-owner"],
      }),
      true,
    );
    const capture = (await f.observer.prepare(rootTree))!;
    assert.equal(capture.snapshot.frameDocuments?.length, 2);
    assert.deepEqual(
      capture.snapshot.frameDocuments![1]!.geometry.contentQuad,
      [70, 100, 230, 100, 230, 220, 70, 220],
    );
    assert.ok(
      (
        await capture.probe({ kind: "click", x: 90, y: 120 })
      ).pointerHitId?.includes("inner"),
    );
  } finally {
    f.close();
  }
});

test("missing native child attachment cannot hide an observed iframe owner", async () => {
  const f = fixture(true, true, true);
  try {
    const send = f.observer.port.send;
    f.observer.port.send = async (session, method, params) =>
      method === "Target.setAutoAttach"
        ? {}
        : await send(session, method, params);
    await assert.rejects(f.observer.prepare(), /identity/);
    assert.equal(
      f.calls.some((call) => call.method.startsWith("Input.")),
      false,
    );
  } finally {
    f.close();
  }
});

test("incomplete local owner scan never authorizes a truncated frame vector", async () => {
  const f = fixture(true, true, true);
  try {
    const window = f.windows.get("main")!;
    const fragment = window.document.createDocumentFragment();
    for (let index = 0; index < 8200; index++)
      fragment.append(window.document.createElement("span"));
    window.document.body.prepend(fragment);
    await assert.rejects(f.observer.prepare(), /identity/);
  } finally {
    f.close();
  }
});

const mouseParams = (
  type: "mousePressed" | "mouseReleased",
  x = 55,
  y = 75,
) => ({
  type,
  x,
  y,
  button: "left",
  buttons: type === "mousePressed" ? 1 : 0,
  clickCount: 1,
});
for (const scenario of [
  {
    name: "same-process leaf",
    remote: false,
    nested: false,
    x: 55,
    y: 75,
    session: "root-route",
    point: [55, 75],
  },
  {
    name: "OOPIF leaf",
    remote: true,
    nested: false,
    x: 55,
    y: 75,
    session: "child-route",
    point: [15, 15],
  },
  {
    name: "nested OOPIF under scaled owner",
    remote: true,
    nested: true,
    x: 90,
    y: 120,
    session: "child-route",
    point: [10, 10],
  },
  {
    name: "same-process leaf inside scaled OOPIF",
    remote: false,
    nested: true,
    x: 90,
    y: 120,
    session: "parent-route",
    point: [40, 50],
  },
])
  test(`preselected mouse uses renderer-root coordinates for ${scenario.name}`, async () => {
    const f = fixture(scenario.remote, scenario.nested);
    try {
      const capture = (await f.observer.prepare())!;
      const action = { kind: "click" as const, x: scenario.x, y: scenario.y };
      const calls: unknown[] = [];
      await dispatchBrowserTargetedInput(
        {
          assertCurrent: capture.assertCurrent,
          snapshot: () => capture.probe(action),
          prepareMouse: (snapshot) =>
            capture.prepareMouse(snapshot, async (session, params, done) => {
              calls.push([session, params.type, params.x, params.y]);
              done();
            }),
          beforeDispatch() {},
          quarantine(error) {
            throw error;
          },
          async dispatch() {
            assert.fail("active mouse must not fall back to root dispatch");
          },
        },
        capture.snapshot,
        action,
      );
      assert.deepEqual(calls, [
        [scenario.session, "mousePressed", ...scenario.point],
        [scenario.session, "mouseReleased", ...scenario.point],
      ]);
    } finally {
      f.close();
    }
  });

test("active-chain root hit uses its own receipt and never borrows child routing", async () => {
  const f = fixture();
  try {
    f.windows.get("main")!.document.elementFromPoint = () =>
      f.windows.get("main")!.document.getElementById("leaf");
    const capture = (await f.observer.prepare())!;
    const hit = await capture.probe({ kind: "click", x: 55, y: 75 });
    let sent: unknown;
    const receipt = capture.prepareMouse(hit, async (session, params, done) => {
      sent = [session, params.x, params.y];
      done();
    });
    assert.ok(Object.isFrozen(receipt));
    await receipt.dispatch(mouseParams("mousePressed"), () => {});
    assert.deepEqual(sent, ["root-route", 55, 75]);
  } finally {
    f.close();
  }
});

test("mouse receipt rejects copied, missing, foreign and previously selected probe evidence", async () => {
  const f = fixture(),
    other = fixture();
  try {
    const capture = (await f.observer.prepare())!,
      foreign = (await other.observer.prepare())!;
    const hit = await capture.probe({ kind: "click", x: 55, y: 75 });
    const send = async () => {
      assert.fail("forged evidence cannot send");
    };
    for (const snapshot of [
      capture.snapshot,
      structuredClone(hit),
      { ...hit, sessionId: "child-route" },
    ])
      assert.throws(() => capture.prepareMouse(snapshot, send), /identity/);
    assert.throws(() => foreign.prepareMouse(hit, send), /identity/);
    capture.prepareMouse(hit, send);
    assert.throws(() => capture.prepareMouse(hit, send), /identity/);
  } finally {
    f.close();
    other.close();
  }
});

test("mouse release requires a full probe begun after press ACK and cannot replay", async () => {
  const f = fixture();
  try {
    const capture = (await f.observer.prepare())!;
    const action = { kind: "click" as const, x: 55, y: 75 };
    const initial = await capture.probe(action),
      old = await capture.probe(action);
    let sends = 0;
    const receipt = capture.prepareMouse(
      initial,
      async (_session, _params, done) => {
        sends++;
        done();
      },
    );
    await receipt.dispatch(mouseParams("mousePressed"), () => {});
    await assert.rejects(
      receipt.dispatch(mouseParams("mouseReleased"), () => {}),
      /identity/,
    );
    assert.throws(() => receipt.assertSnapshot(initial), /identity/);
    assert.throws(() => receipt.assertSnapshot(old), /identity/);
    const releaseProof = await capture.probe(action);
    receipt.assertSnapshot(releaseProof);
    assert.throws(
      () => capture.prepareMouse(releaseProof, async () => {}),
      /identity/,
    );
    await receipt.dispatch(mouseParams("mouseReleased"), () => {});
    await assert.rejects(
      receipt.dispatch(mouseParams("mouseReleased"), () => {}),
      /identity/,
    );
    assert.equal(sends, 2);
  } finally {
    f.close();
  }
});

for (const change of [
  { type: "mouseMoved" },
  { button: "right" },
  { buttons: 0 },
  { x: 1 },
  { clickCount: 2 },
  { modifiers: 0 },
  { sessionId: "foreign" },
])
  test(`preselected mouse refuses altered native pair ${JSON.stringify(change)}`, async () => {
    const f = fixture();
    try {
      const capture = (await f.observer.prepare())!;
      const receipt = capture.prepareMouse(
        await capture.probe({ kind: "click", x: 55, y: 75 }),
        async () => {
          assert.fail("invalid pair sent");
        },
      );
      await assert.rejects(
        receipt.dispatch(
          { ...mouseParams("mousePressed"), ...change },
          () => {},
        ),
        /identity/,
      );
    } finally {
      f.close();
    }
  });

for (const fault of [
  "detach-replace",
  "context",
  "owner-retired",
  "quad",
  "occlusion",
  "send-unknown",
])
  test(`child mouse ${fault} after press quarantines root with no successor release`, async () => {
    const f = fixture();
    try {
      const capture = (await f.observer.prepare())!;
      const action = { kind: "click" as const, x: 55, y: 75 };
      const calls: unknown[] = [];
      let quarantined = 0;
      await assert.rejects(
        dispatchBrowserTargetedInput(
          {
            assertCurrent: capture.assertCurrent,
            snapshot: () => capture.probe(action),
            prepareMouse: (snapshot) =>
              capture.prepareMouse(snapshot, async (session, params, done) => {
                calls.push([session, params.type]);
                done();
                if (fault === "detach-replace") {
                  f.evidence.acceptEvent(
                    "root-route",
                    "Target.detachedFromTarget",
                    { sessionId: "child-route" },
                  );
                  f.evidence.acceptEvent(
                    "root-route",
                    "Target.attachedToTarget",
                    {
                      sessionId: "successor-route",
                      targetInfo: { type: "iframe", targetId: "successor" },
                      waitingForDebugger: false,
                    },
                  );
                } else if (fault === "context")
                  f.evidence.acceptEvent(
                    "child-route",
                    "Runtime.executionContextsCleared",
                    {},
                  );
                else if (fault === "owner-retired") f.retire();
                else if (fault === "quad")
                  f.frames[2]!.quad = [42, 60, 122, 60, 122, 120, 42, 120];
                else if (fault === "occlusion")
                  f.windows.get("main")!.document.elementFromPoint = () =>
                    f.windows.get("main")!.document.getElementById("leaf");
                else throw Error("native send outcome unknown");
              }),
            beforeDispatch() {},
            quarantine() {
              quarantined++;
            },
            async dispatch() {
              assert.fail("no root fallback");
            },
          },
          capture.snapshot,
          action,
        ),
        /outcome is unknown/,
      );
      assert.deepEqual(calls, [["child-route", "mousePressed"]]);
      assert.equal(quarantined, 1);
    } finally {
      f.close();
    }
  });

test("focused remote keys retain root dispatch and cannot prepare a mouse route", async () => {
  const f = fixture();
  try {
    const capture = (await f.observer.prepare())!;
    const calls: unknown[] = [];
    await dispatchBrowserTargetedInput(
      {
        assertCurrent: capture.assertCurrent,
        snapshot: () => capture.probe({ kind: "key", key: "Enter" }),
        prepareMouse() {
          assert.fail("key cannot select child mouse receipt");
        },
        beforeDispatch() {},
        quarantine(error) {
          throw error;
        },
        async dispatch(method, params, done) {
          calls.push([method, params.type]);
          done();
        },
      },
      capture.snapshot,
      { kind: "key", key: "Enter" },
    );
    assert.deepEqual(calls, [
      ["Input.dispatchKeyEvent", "keyDown"],
      ["Input.dispatchKeyEvent", "keyUp"],
    ]);
  } finally {
    f.close();
  }
});

test("probe started before press ACK cannot authorize release even if it completes later", async () => {
  const f = fixture();
  try {
    const capture = (await f.observer.prepare())!;
    const action = { kind: "click" as const, x: 55, y: 75 };
    let acknowledge!: () => void, resume!: () => void;
    const ack = new Promise<void>((resolve) => {
      acknowledge = resolve;
    });
    const resumed = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const receipt = capture.prepareMouse(
      await capture.probe(action),
      async () => ack,
    );
    const pressing = receipt.dispatch(mouseParams("mousePressed"), () => {});
    const send = f.observer.port.send;
    let blocked = false;
    f.observer.port.send = async (session, method, params) => {
      if (!blocked) {
        blocked = true;
        await resumed;
      }
      return send(session, method, params);
    };
    const earlyProbe = capture.probe(action);
    assert.ok(blocked);
    acknowledge();
    await pressing;
    resume();
    // Use the completed original probe, not a new post-ACK observation.
    const awaited = await earlyProbe;
    assert.throws(() => receipt.assertSnapshot(awaited), /identity/);
  } finally {
    f.close();
  }
});

test("acknowledged child release followed by lifecycle change is unknown without held-input quarantine", async () => {
  const f = fixture();
  try {
    const capture = (await f.observer.prepare())!;
    const action = { kind: "click" as const, x: 55, y: 75 };
    let sent = 0,
      quarantined = 0;
    await assert.rejects(
      dispatchBrowserTargetedInput(
        {
          assertCurrent: capture.assertCurrent,
          snapshot: () => capture.probe(action),
          prepareMouse: (snapshot) =>
            capture.prepareMouse(snapshot, async (_session, params, done) => {
              sent++;
              done();
              if (params.type === "mouseReleased")
                f.evidence.acceptEvent(
                  "child-route",
                  "Runtime.executionContextsCleared",
                  {},
                );
            }),
          beforeDispatch() {},
          quarantine() {
            quarantined++;
          },
          async dispatch() {
            assert.fail("no fallback");
          },
        },
        capture.snapshot,
        action,
      ),
      /Both input events were acknowledged/,
    );
    assert.equal(sent, 2);
    assert.equal(quarantined, 0);
  } finally {
    f.close();
  }
});
