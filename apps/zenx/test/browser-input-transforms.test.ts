import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import {
  assertBrowserInputSnapshot,
  browserInputProbeScript,
  browserInputSnapshotScript,
  BrowserInputOutcomeUnknownError,
  BrowserInputUnsupportedError,
  dispatchBrowserTargetedInput,
  requireBrowserInputContentQuad,
  requireBrowserInputSnapshot,
  resolveBrowserInputEvidence,
  type BrowserInputSnapshot,
} from "../src/main/capabilities/browser-targeted-input.js";

function fixture(slotted = false) {
  const dom = new JSDOM("<!doctype html><body></body>", {
    runScripts: "outside-only",
    url: "https://fixture.test/",
  });
  const document = dom.window.document;
  const frame = document.createElement("iframe");
  frame.style.cssText =
    "width:200px;height:120px;border:3px solid;padding:2px;transform:matrix(2,0,0,2,0,0)";
  if (slotted) {
    const host = document.createElement("div");
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML =
      '<div style="transform:matrix(2,0,0,2,0,0)"><slot></slot></div>';
    document.body.append(host);
    host.append(frame);
  } else document.body.append(frame);
  const child = frame.contentDocument!;
  child.body.innerHTML =
    '<input id="a"><input id="b"><canvas id="canvas"></canvas>';
  Object.defineProperties(child.defaultView!, {
    innerWidth: { value: 200, configurable: true },
    innerHeight: { value: 120, configurable: true },
  });
  const rect = {
    x: 40,
    y: 30,
    left: 40,
    top: 30,
    width: 420,
    height: 260,
    right: 460,
    bottom: 290,
    toJSON() {},
  };
  frame.getBoundingClientRect = () => rect;
  const points: number[][] = [];
  document.elementFromPoint = () => frame;
  child.elementFromPoint = (x, y) => {
    points.push([x, y]);
    return child.getElementById("canvas");
  };
  const geometry = { quad: [50, 40, 450, 40, 450, 280, 50, 280] };
  const objects = new Map<string, Element>();
  const nativeModels = new Map<Element, { id: number; quad: () => number[] }>([
    [frame, { id: 101, quad: () => geometry.quad }],
  ]);
  const registerNative = (element: Element, quad: () => number[]) =>
    nativeModels.set(element, { id: 101 + nativeModels.size, quad });
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const hooks: {
    before?: (method: string, params: Record<string, unknown>) => void;
    afterPress?: () => void;
  } = {};
  let sequence = 0;
  let quarantined = false;
  const input: Record<string, unknown>[] = [];
  const send = async (method: string, params: Record<string, unknown>) => {
    calls.push({ method, params });
    hooks.before?.(method, params);
    if (method === "Runtime.evaluate") {
      try {
        const value = dom.window.eval(String(params.expression));
        if (params.returnByValue !== false) return { result: { value } };
        if ((value as Node | null)?.nodeType !== 1)
          return { result: { subtype: "null", value: null } };
        const objectId = `owned:${++sequence}`;
        objects.set(objectId, value as Element);
        return { result: { subtype: "node", objectId } };
      } catch (error) {
        return { exceptionDetails: { text: String(error) } };
      }
    }
    if (method === "Runtime.releaseObject") {
      assert.ok(
        objects.delete(String(params.objectId)),
        "Only release each owned wrapper once",
      );
      return {};
    }
    const element = params.objectId
      ? objects.get(String(params.objectId))
      : [...nativeModels].find(
          ([, model]) => model.id === params.backendNodeId,
        )?.[0];
    const model = element && nativeModels.get(element);
    assert.ok(model, "Native evidence must name an exact registered iframe");
    if (method === "DOM.describeNode")
      return {
        node: {
          nodeType: 1,
          localName: "iframe",
          backendNodeId: model.id,
          attributes: [],
        },
      };
    assert.equal(method, "DOM.getBoxModel");
    // Width/height intentionally describe the border box, not child coordinates.
    return { model: { content: [...model.quad()], width: 210, height: 130 } };
  };
  const raw = (action?: { kind: "click"; x: number; y: number }) =>
    dom.window.eval(
      action ? browserInputProbeScript(action) : browserInputSnapshotScript,
    );
  const read = async (action?: { kind: "click"; x: number; y: number }) =>
    requireBrowserInputSnapshot(
      await resolveBrowserInputEvidence(raw(action), send),
    );
  const inspect = async () =>
    (await resolveBrowserInputEvidence({ inputSnapshot: raw() }, send)) as {
      inputSnapshot?: BrowserInputSnapshot;
    };
  const ready = async () => {
    assert.equal((await inspect()).inputSnapshot, undefined);
    return requireBrowserInputSnapshot((await inspect()).inputSnapshot);
  };
  const dispatch = (
    observed: BrowserInputSnapshot,
    action:
      | { kind: "click"; x: number; y: number }
      | { kind: "key"; key: "Enter" | "Tab" },
  ) =>
    dispatchBrowserTargetedInput(
      {
        assertCurrent() {},
        snapshot: () => read(action.kind === "click" ? action : undefined),
        beforeDispatch() {},
        async dispatch(_method, params, onDispatched) {
          input.push(params);
          onDispatched();
          if (input.length === 1) hooks.afterPress?.();
        },
        quarantine() {
          quarantined = true;
        },
      },
      observed,
      action,
    );
  return {
    dom,
    document,
    frame,
    child,
    rect,
    geometry,
    calls,
    hooks,
    objects,
    input,
    points,
    raw,
    read,
    inspect,
    ready,
    dispatch,
    registerNative,
    get quarantined() {
      return quarantined;
    },
  };
}

test("native content quad registration requires a fresh observation and maps scale without changing Input coordinates", async () => {
  const f = fixture();
  try {
    const unregistered = requireBrowserInputSnapshot(f.raw());
    assert.equal(unregistered.frameDocuments?.length, 0);
    const observed = await f.ready();
    assert.ok(observed.layoutRevision > unregistered.layoutRevision);
    assert.equal(observed.frameDocuments?.length, 1);
    assert.equal(f.objects.size, 0);
    const action = { kind: "click" as const, x: 70, y: 62 };
    await f.dispatch(observed, action);
    assert.ok(
      f.points.every(([x, y]) => x === 10 && y === 11),
      "Every leaf hit uses content coordinates",
    );
    assert.deepEqual(
      f.input.map(({ x, y, type }) => ({ x, y, type })),
      [
        { x: 70, y: 62, type: "mousePressed" },
        { x: 70, y: 62, type: "mouseReleased" },
      ],
    );
    assert.equal(f.objects.size, 0);
  } finally {
    f.dom.window.close();
  }
});

for (const transform of ["rotate", "skew", "reflect"] as const) {
  test(`${transform} retains native corner order and resolves the real inner target`, async () => {
    const f = fixture();
    try {
      if (transform === "rotate") {
        f.frame.style.transform = "matrix(0,2,-2,0,0,0)";
        f.geometry.quad = [300, 40, 300, 440, 60, 440, 60, 40];
      } else if (transform === "skew") {
        f.frame.style.transform = "matrix(2,0.5,0.5,2,0,0)";
        f.geometry.quad = [50, 40, 450, 140, 510, 380, 110, 280];
      } else {
        f.frame.style.transform = "matrix(-2,0,0,2,0,0)";
        f.geometry.quad = [450, 40, 50, 40, 50, 280, 450, 280];
      }
      const observed = await f.ready();
      const q = f.geometry.quad;
      const x = q[0]! + (q[2]! - q[0]!) * 0.25 + (q[6]! - q[0]!) * 0.5;
      const y = q[1]! + (q[3]! - q[1]!) * 0.25 + (q[7]! - q[1]!) * 0.5;
      await f.dispatch(observed, { kind: "click", x, y });
      assert.ok(
        f.points.every(
          ([px, py]) => Math.abs(px! - 50) < 1e-9 && Math.abs(py! - 60) < 1e-9,
        ),
        "Inverse affine mapping reaches the exact child point",
      );
    } finally {
      f.dom.window.close();
    }
  });
}

test("native geometry is refreshed even when the DOM bounding rectangle and mutation revision stay unchanged", async () => {
  const f = fixture();
  try {
    const observed = await f.ready();
    f.geometry.quad = [450, 40, 50, 40, 50, 280, 450, 280];
    await assert.rejects(
      f.dispatch(observed, { kind: "click", x: 70, y: 62 }),
      /geometry observation initialized or changed/,
    );
    assert.equal(f.input.length, 0);
    const fresh = await f.read();
    assert.throws(() => assertBrowserInputSnapshot(observed, fresh), /changed/);
    await f.dispatch(fresh, { kind: "click", x: 70, y: 62 });
    assert.equal(f.input.length, 2);
  } finally {
    f.dom.window.close();
  }
});

for (const stage of ["describe", "quad", "release", "recheck"] as const) {
  test(`iframe replacement during ${stage} invalidates evidence and releases owned objects`, async () => {
    const f = fixture();
    try {
      await f.ready();
      let fired = false;
      f.hooks.before = (method, params) => {
        const match =
          stage === "describe"
            ? method === "DOM.describeNode" && params.objectId
            : stage === "quad"
              ? method === "DOM.getBoxModel" && params.objectId
              : stage === "release"
                ? method === "Runtime.releaseObject"
                : method === "DOM.getBoxModel" && params.backendNodeId;
        if (!fired && match) {
          fired = true;
          f.frame.remove();
        }
      };
      await assert.rejects(f.read(), /changed/);
      assert.equal(f.objects.size, 0);
      assert.equal(f.input.length, 0);
    } finally {
      f.dom.window.close();
    }
  });
}

test("changed quad after pointer press quarantines without releasing into the changed frame", async () => {
  const f = fixture();
  try {
    const observed = await f.ready();
    f.hooks.afterPress = () => {
      f.geometry.quad = f.geometry.quad.map((value, index) =>
        index % 2 ? value : value + 1,
      );
    };
    await assert.rejects(
      f.dispatch(observed, { kind: "click", x: 70, y: 62 }),
      BrowserInputOutcomeUnknownError,
    );
    assert.equal(f.input.length, 1);
    assert.equal(f.quarantined, true);
    assert.equal(f.objects.size, 0);
  } finally {
    f.dom.window.close();
  }
});

test("parent hit testing preserves clipping and does not descend behind another element", async () => {
  const f = fixture();
  try {
    const observed = await f.ready();
    const overlay = f.document.createElement("canvas");
    f.document.body.append(overlay);
    await f.read();
    f.document.elementFromPoint = () => overlay;
    const fresh = await f.read();
    f.points.length = 0;
    await f.dispatch(fresh, { kind: "click", x: 70, y: 62 });
    assert.equal(f.points.length, 0);
    assert.throws(() => assertBrowserInputSnapshot(observed, fresh), /changed/);
  } finally {
    f.dom.window.close();
  }
});

for (const limitation of [
  "perspective",
  "3d",
  "preserve-3d",
  "zoom",
  "singular",
  "fractional-size",
  "animation",
] as const) {
  test(`${limitation} remains explicitly unsupported rather than guessed`, async () => {
    const f = fixture();
    try {
      if (limitation === "perspective") f.frame.style.perspective = "500px";
      if (limitation === "3d")
        f.frame.style.transform = "matrix3d(1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1)";
      if (limitation === "preserve-3d")
        f.frame.style.transformStyle = "preserve-3d";
      if (limitation === "zoom") f.frame.style.setProperty("zoom", "2");
      if (limitation === "singular")
        f.frame.style.transform = "matrix(0,0,0,2,0,0)";
      if (limitation === "fractional-size") f.frame.style.width = "200.5px";
      if (limitation === "animation")
        Object.defineProperty(f.frame, "getAnimations", {
          value: () => [{ playState: "running" }],
        });
      assert.throws(
        () =>
          requireBrowserInputSnapshot(f.raw({ kind: "click", x: 70, y: 62 })),
        BrowserInputUnsupportedError,
      );
      assert.equal((await f.read()).frameDocuments?.length, 0);
      assert.equal(
        f.calls.some(({ method }) => method === "DOM.getBoxModel"),
        false,
      );
    } finally {
      f.dom.window.close();
    }
  });
}

test("malformed, projective, singular and ill-conditioned native quads fail closed", () => {
  for (const quad of [
    [],
    [0, 0, 1, 0, 1, 1, NaN, 1],
    [0, 0, 10, 0, 12, 10, 0, 10],
    [0, 0, 0, 0, 0, 0, 0, 0],
    [0, 0, 1e8, 0, 1e8, 1, 0, 1],
  ])
    assert.throws(() => requireBrowserInputContentQuad(quad), /quad/);
});

test("nested ordinary frame mapping starts from the transformed parent's real child point", async () => {
  const f = fixture();
  try {
    const inner = f.child.createElement("iframe");
    inner.style.cssText = "width:40px;height:30px;border:0;padding:0";
    f.child.body.append(inner);
    const document = inner.contentDocument!;
    document.body.innerHTML = "<canvas></canvas>";
    Object.defineProperties(document.defaultView!, {
      innerWidth: { value: 40 },
      innerHeight: { value: 30 },
    });
    inner.getBoundingClientRect = () => ({
      x: 20,
      y: 10,
      left: 20,
      top: 10,
      width: 40,
      height: 30,
      right: 60,
      bottom: 40,
      toJSON() {},
    });
    f.child.elementFromPoint = () => inner;
    const points: number[][] = [];
    document.elementFromPoint = (x, y) => {
      points.push([x, y]);
      return document.querySelector("canvas");
    };
    const observed = await f.ready();
    assert.equal(observed.frameDocuments?.length, 2);
    await f.dispatch(observed, { kind: "click", x: 130, y: 100 });
    assert.ok(
      points.length > 0 && points.every(([x, y]) => x === 20 && y === 20),
      "Native outer coordinates are not offset twice",
    );
  } finally {
    f.dom.window.close();
  }
});

test("slot ancestry is included when the iframe itself has no transform", async () => {
  const f = fixture(true);
  try {
    f.frame.style.transform = "none";
    const observed = await f.ready();
    assert.equal(observed.nativeFrameCandidates?.length, 1);
    await f.dispatch(observed, { kind: "click", x: 70, y: 62 });
    assert.ok(
      f.points.every(([x, y]) => x === 10 && y === 11),
      "Slotted transform uses the native content quad",
    );
  } finally {
    f.dom.window.close();
  }
});

test("nested transformed frames invert independently from the same original root point", async () => {
  const f = fixture();
  try {
    const inner = f.child.createElement("iframe");
    inner.style.cssText =
      "width:40px;height:30px;border:0;padding:0;transform:matrix(0,1,-1,0,0,0)";
    f.child.body.append(inner);
    const document = inner.contentDocument!;
    document.body.innerHTML = "<canvas></canvas>";
    Object.defineProperties(document.defaultView!, {
      innerWidth: { value: 40 },
      innerHeight: { value: 30 },
    });
    inner.getBoundingClientRect = () => ({
      x: 50,
      y: 10,
      left: 50,
      top: 10,
      width: 30,
      height: 40,
      right: 80,
      bottom: 50,
      toJSON() {},
    });
    f.child.elementFromPoint = () => inner;
    const points: number[][] = [];
    document.elementFromPoint = (x, y) => {
      points.push([x, y]);
      return document.querySelector("canvas");
    };
    // Chromium has already mapped this quad through the outer frame's scale.
    f.registerNative(inner, () => [210, 60, 210, 140, 150, 140, 150, 60]);
    assert.equal((await f.inspect()).inputSnapshot, undefined);
    assert.equal((await f.inspect()).inputSnapshot, undefined);
    const observed = requireBrowserInputSnapshot(
      (await f.inspect()).inputSnapshot,
    );
    assert.equal(observed.frameDocuments?.length, 2);
    assert.equal(observed.nativeFrameCandidates?.length, 2);
    await f.dispatch(observed, { kind: "click", x: 170, y: 80 });
    assert.ok(
      points.length > 0 && points.every(([x, y]) => x === 10 && y === 20),
      "Nested native geometry must not consume the parent's already-local point",
    );
    assert.equal(f.objects.size, 0);
  } finally {
    f.dom.window.close();
  }
});

test("transformed iframe key release retains inner focus and child-scroll semantics", async () => {
  const f = fixture();
  try {
    f.child.getElementById("a")!.focus();
    const observed = await f.ready();
    assert.ok(observed.focusId);
    f.hooks.afterPress = () => {
      f.child.getElementById("b")!.focus();
      Object.defineProperty(f.child.defaultView!, "scrollY", { value: 20 });
      f.child.defaultView!.dispatchEvent(
        new f.child.defaultView!.Event("scroll"),
      );
    };
    await f.dispatch(observed, { kind: "key", key: "Tab" });
    assert.equal(f.input.length, 2);
    assert.equal(f.quarantined, false);
  } finally {
    f.dom.window.close();
  }
});
