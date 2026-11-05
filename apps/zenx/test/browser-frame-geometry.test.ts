import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import {
  browserFrameIdentityTransform,
  browserFrameCompose,
  browserFrameInvert,
  browserFrameMapPoint,
  browserFrameMapQuad,
  browserFrameContentTransform,
  browserFrameOwnerWitnessScript,
  requireBrowserFrameOwnerWitness,
  resolveBrowserFrameAncestorEvidence,
} from "../src/main/capabilities/browser-frame-geometry.js";

const viewport = {
  width: 200,
  height: 120,
  visualScale: 1,
  visualOffsetX: 0,
  visualOffsetY: 0,
};
const equalPoint = (
  actual: { x: number; y: number },
  expected: { x: number; y: number },
) =>
  assert.ok(
    Math.abs(actual.x - expected.x) < 1e-9 &&
      Math.abs(actual.y - expected.y) < 1e-9,
    "Mapped point agrees with independent expected coordinates",
  );

test("content transform preserves scale, rotation, skew and reflected native corner order", () => {
  for (const transform of [
    { a: 2, b: 0, c: 0, d: 3, e: 50, f: 40 },
    { a: 0, b: 2, c: -2, d: 0, e: 300, f: 40 },
    { a: 2, b: 0.5, c: 0.5, d: 2, e: 50, f: 40 },
    { a: -2, b: 0, c: 0, d: 2, e: 450, f: 40 },
  ]) {
    const expectedQuad = [
      transform.e,
      transform.f,
      transform.a * 200 + transform.e,
      transform.b * 200 + transform.f,
      transform.a * 200 + transform.c * 120 + transform.e,
      transform.b * 200 + transform.d * 120 + transform.f,
      transform.c * 120 + transform.e,
      transform.d * 120 + transform.f,
    ];
    const actual = browserFrameContentTransform(expectedQuad, 200, 120);
    assert.deepEqual(actual, transform);
    equalPoint(
      browserFrameMapPoint(
        browserFrameInvert(actual),
        browserFrameMapPoint(actual, { x: 10.5, y: 21.25 }),
      ),
      { x: 10.5, y: 21.25 },
    );
  }
});

test("renderer-root native quad composes once through the exact owner transform", () => {
  const rendererToTop = { a: 2, b: 0, c: 0, d: 2, e: 50, f: 40 };
  const localQuad = [80, 10, 80, 50, 50, 50, 50, 10];
  const topQuad = browserFrameMapQuad(rendererToTop, localQuad);
  assert.deepEqual(topQuad, [210, 60, 210, 140, 150, 140, 150, 60]);
  const localToRenderer = browserFrameContentTransform(localQuad, 40, 30);
  const localToTop = browserFrameCompose(rendererToTop, localToRenderer);
  assert.deepEqual(localToTop, browserFrameContentTransform(topQuad, 40, 30));
  equalPoint(browserFrameMapPoint(localToTop, { x: 10, y: 20 }), {
    x: 170,
    y: 80,
  });
  equalPoint(
    browserFrameMapPoint(browserFrameInvert(localToTop), { x: 170, y: 80 }),
    { x: 10, y: 20 },
  );
});

test("identity and inverse composition do not mutate caller-owned evidence", () => {
  const transform = Object.freeze({
    a: 1.5,
    b: 0.25,
    c: -0.5,
    d: 2,
    e: 17,
    f: -23,
  });
  assert.deepEqual(
    browserFrameCompose(browserFrameIdentityTransform, transform),
    transform,
  );
  const roundTrip = browserFrameCompose(
    browserFrameInvert(transform),
    transform,
  );
  equalPoint(browserFrameMapPoint(roundTrip, { x: -100, y: 250 }), {
    x: -100,
    y: 250,
  });
  const quad = Object.freeze([0, 0, 100, 0, 100, 80, 0, 80]);
  assert.deepEqual(
    browserFrameMapQuad(browserFrameIdentityTransform, quad),
    quad,
  );
});

test("singular, ill-conditioned, malformed and oversized mappings reject without guesses", () => {
  for (const transform of [
    { ...browserFrameIdentityTransform, a: 0 },
    { ...browserFrameIdentityTransform, a: NaN },
    { ...browserFrameIdentityTransform, a: 2e6 },
    { ...browserFrameIdentityTransform, e: 2e7 },
    { ...browserFrameIdentityTransform, d: 1e-8 },
  ])
    assert.throws(() => browserFrameInvert(transform), /transform/);
  for (const quad of [
    [],
    [0, 0, 1, 0, 1, 1, NaN, 1],
    [0, 0, 10, 0, 12, 10, 0, 10],
    [0, 0, 0, 0, 0, 0, 0, 0],
    [0, 0, 2e7, 0, 2e7, 10, 0, 10],
  ])
    assert.throws(
      () => browserFrameContentTransform(quad, 100, 100),
      /quad|transform/,
    );
  assert.throws(
    () => browserFrameContentTransform([0, 0, 1, 0, 1, 1, 0, 1], 0, 1),
    /size/,
  );
  assert.throws(
    () =>
      browserFrameMapPoint(browserFrameIdentityTransform, {
        x: Infinity,
        y: 0,
      }),
    /point/,
  );
  assert.throws(
    () =>
      browserFrameMapPoint(
        { ...browserFrameIdentityTransform, a: 2 },
        { x: 1e7, y: 0 },
      ),
    /bound/,
  );
  assert.throws(
    () =>
      browserFrameCompose(
        { ...browserFrameIdentityTransform, a: 1000, d: 1000 },
        { ...browserFrameIdentityTransform, a: 10000, d: 10000 },
      ),
    /bound/,
  );
});

function ownerFixture(slotted = false) {
  const dom = new JSDOM("<!doctype html><body></body>", {
    runScripts: "outside-only",
    url: "https://owner.test/",
  });
  const document = dom.window.document;
  const frame = document.createElement("iframe");
  frame.style.cssText =
    "width:200px;height:120px;border:3px solid;padding:2px;transform:matrix(2,0,0,2,0,0)";
  if (slotted) {
    const host = document.createElement("div");
    host.attachShadow({ mode: "open" }).innerHTML =
      '<div id="wrapper" style="transform:matrix(0,1,-1,0,0,0)"><slot></slot></div>';
    document.body.append(host);
    host.append(frame);
  } else document.body.append(frame);
  Object.defineProperties(frame, {
    clientWidth: { value: 204, configurable: true },
    clientHeight: { value: 124, configurable: true },
  });
  frame.getBoundingClientRect = () => {
    throw new Error("No JS geometry inference allowed");
  };
  Object.defineProperty(frame, "contentDocument", {
    get() {
      throw new Error("No cross-origin child reads allowed");
    },
  });
  dom.window.eval(
    'globalThis[Symbol.for("zenx-browser-targeted-input-v2")] = { document, id: "12345678901234567890123456789012", next: 1, nodes: new WeakMap(), documents: new Map([[document, { id: "12345678901234567890123456789012" }]]) }',
  );
  const fn = dom.window.eval(`(${browserFrameOwnerWitnessScript})`) as (
    this: Element,
  ) => unknown;
  const raw = () => fn.call(frame);
  const read = () => requireBrowserFrameOwnerWitness(raw(), viewport);
  return { dom, document, frame, fn, raw, read };
}

test("exact native owner witness mints stable isolated identity without reading child DOM or bounding rect", () => {
  const f = ownerFixture();
  try {
    const before = f.read();
    assert.equal(before.width, 200);
    assert.equal(before.height, 120);
    assert.equal(before.clientWidth, 204);
    assert.equal(before.paddingLeft, 2);
    assert.equal(before.borderLeft, 3);
    assert.equal(
      before.documentKey,
      "12345678901234567890123456789012|https://owner.test/",
    );
    assert.deepEqual(f.read(), before);
    f.frame.style.transform = "matrix(0,2,-2,0,0,0)";
    const changed = f.read();
    assert.equal(changed.ownerId, before.ownerId);
    assert.notEqual(changed.styleWitness, before.styleWitness);
  } finally {
    f.dom.window.close();
  }
});

test("border-box owner size and padding client dimensions remain independent", () => {
  const f = ownerFixture();
  try {
    f.frame.style.boxSizing = "border-box";
    f.frame.style.width = "210px";
    f.frame.style.height = "130px";
    assert.equal(f.read().width, 200);
    assert.equal(f.read().height, 120);
    Object.defineProperty(f.frame, "clientWidth", { value: 210 });
    assert.throws(() => f.read(), /dimensions/);
  } finally {
    f.dom.window.close();
  }
});

test("only client rounding is tolerated, never a guessed child content scale", () => {
  const f = ownerFixture();
  try {
    f.frame.style.padding = "2.2px";
    assert.equal(f.read().width, 200);
    f.frame.style.width = "200.4px";
    assert.throws(() => f.read(), /dimensions/);
    assert.throws(
      () =>
        requireBrowserFrameOwnerWitness(f.raw(), {
          ...viewport,
          visualScale: 2,
        }),
      /dimensions/,
    );
  } finally {
    f.dom.window.close();
  }
});

test("slot ancestors contribute to the exact style witness", () => {
  const f = ownerFixture(true);
  try {
    const before = f.read();
    const wrapper = f.frame.parentElement!.shadowRoot!.getElementById(
      "wrapper",
    ) as HTMLElement;
    wrapper.style.transform = "matrix(1,0,0,1,12,14)";
    // JSDOM does not invalidate its document style cache for shadow mutations.
    f.document.body.setAttribute("data-refresh", "1");
    assert.notEqual(f.read().styleWitness, before.styleWitness);
    wrapper.style.perspective = "500px";
    f.document.body.setAttribute("data-refresh", "2");
    assert.throws(() => f.read(), /unsupported/);
  } finally {
    f.dom.window.close();
  }
});

test("known closed-slot ancestry refuses rather than skipping hidden transforms", () => {
  const f = ownerFixture();
  try {
    const host = f.document.createElement("div");
    const root = host.attachShadow({ mode: "closed" });
    root.innerHTML = '<div style="perspective:100px"><slot></slot></div>';
    f.document.body.append(host);
    host.append(f.frame);
    const state = f.dom.window.eval(
      'globalThis[Symbol.for("zenx-browser-targeted-input-v2")]',
    ) as { closedRoots?: WeakMap<Element, ShadowRoot> };
    state.closedRoots = new WeakMap([[host, root]]);
    assert.equal(f.frame.assignedSlot, null);
    assert.throws(() => f.read(), /closed-slot ancestry is unresolved/);
  } finally {
    f.dom.window.close();
  }
});

for (const change of [
  "detached",
  "wrong-document",
  "wrong-kind",
  "stale-registry",
  "perspective",
  "3d",
  "individual-scale",
  "zoom",
  "animated",
  "visual-zoom",
] as const) {
  test(`${change} cannot supply trusted owner geometry`, () => {
    const f = ownerFixture();
    try {
      if (change === "detached") f.frame.remove();
      if (change === "wrong-document") {
        const other = f.document.implementation.createHTMLDocument();
        const otherFrame = other.createElement("iframe");
        other.body.append(otherFrame);
        assert.throws(() => f.fn.call(otherFrame), /owner or document/);
        return;
      }
      if (change === "wrong-kind") {
        assert.throws(() => f.fn.call(f.document.body), /owner or document/);
        return;
      }
      if (change === "stale-registry")
        f.dom.window.eval(
          'globalThis[Symbol.for("zenx-browser-targeted-input-v2")].document = null',
        );
      if (change === "perspective") f.frame.style.perspective = "100px";
      if (change === "3d")
        f.frame.style.transform = "matrix3d(1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1)";
      if (change === "individual-scale")
        f.frame.style.setProperty("scale", "2");
      if (change === "zoom") f.document.body.style.setProperty("zoom", "2");
      if (change === "animated")
        Object.defineProperty(f.frame, "getAnimations", {
          value: () => [{ playState: "running" }],
        });
      if (change === "visual-zoom")
        Object.defineProperty(f.dom.window, "visualViewport", {
          value: { scale: 2, offsetLeft: 0, offsetTop: 0 },
        });
      assert.throws(
        () => f.read(),
        /changed|unsupported|dimensional|animated|zoomed/,
      );
    } finally {
      f.dom.window.close();
    }
  });
}

test("owner witness rejects malformed native values without retaining caller objects", () => {
  const f = ownerFixture();
  try {
    const raw = f.raw() as Record<string, unknown>;
    const witness = requireBrowserFrameOwnerWitness(raw, viewport);
    raw.width = 999;
    assert.equal(witness.width, 200);
    for (const patch of [
      { ownerId: "" },
      { clientHeight: 124.5 },
      { width: NaN },
      { width: 1e8 },
      { styleWitness: "x".repeat(131073) },
    ])
      assert.throws(
        () =>
          requireBrowserFrameOwnerWitness({ ...witness, ...patch }, viewport),
        /witness|dimensions/,
      );
  } finally {
    f.dom.window.close();
  }
});

function ancestorTransport(f: ReturnType<typeof ownerFixture>) {
  const objects = new Map<string, Element>([["owner", f.frame]]);
  const roots = new Map<Element, ShadowRoot>();
  const ids = new WeakMap<Element, number>();
  const native = new Map<number, Element>();
  const released: string[] = [];
  const hooks: {
    before?: (method: string, params: Record<string, unknown>) => void;
  } = {};
  let sequence = 0;
  const send = async (method: string, params: Record<string, unknown>) => {
    hooks.before?.(method, params);
    if (method === "Runtime.releaseObject") {
      const id = String(params.objectId);
      assert.notEqual(
        id,
        "owner",
        "The ancestor helper cannot release its caller's owner",
      );
      assert.ok(objects.delete(id), "Release each helper-owned wrapper once");
      released.push(id);
      return {};
    }
    if (method === "Runtime.callFunctionOn") {
      const node = objects.get(String(params.objectId));
      assert.ok(node, "Invoke only an owned wrapper");
      try {
        const fn = f.dom.window.eval(`(${String(params.functionDeclaration)})`);
        assert.ok(
          typeof fn === "function",
          "Evaluate the trusted native ancestor query",
        );
        const value = fn.call(
          node,
          ...((params.arguments as { value: unknown }[] | undefined) ?? []).map(
            (argument) => argument.value,
          ),
        );
        if (params.returnByValue !== false) return { result: { value } };
        if (value?.nodeType !== 1)
          return { result: { subtype: "null", value: null } };
        const objectId = `ancestor:${++sequence}`;
        objects.set(objectId, value);
        return { result: { subtype: "node", objectId } };
      } catch (error) {
        return { exceptionDetails: { text: String(error) } };
      }
    }
    assert.equal(method, "DOM.describeNode");
    const node = params.objectId
      ? objects.get(String(params.objectId))
      : native.get(Number(params.backendNodeId));
    assert.ok(
      node,
      "Describe only an exact owned or previously described node",
    );
    let backendNodeId = ids.get(node);
    if (!backendNodeId) {
      backendNodeId = ++sequence;
      ids.set(node, backendNodeId);
      native.set(backendNodeId, node);
    }
    const root = node.shadowRoot ?? roots.get(node);
    return {
      node: {
        nodeType: 1,
        localName: node.localName,
        backendNodeId,
        ...(root ? { shadowRoots: [{ shadowRootType: root.mode }] } : {}),
      },
    };
  };
  return { send, objects, roots, hooks, released };
}

test("native ancestor classification allows an explicit open-slot path and cleans every created wrapper", async () => {
  const f = ownerFixture(true);
  try {
    const native = ancestorTransport(f);
    const evidence = await resolveBrowserFrameAncestorEvidence(
      "owner",
      native.send,
    );
    assert.equal(native.objects.size, 1);
    assert.ok(native.released.length > 0);
    await evidence.recheckNative();
    assert.equal(f.read().width, 200);
  } finally {
    f.dom.window.close();
  }
});

test("native metadata exposes an undiscovered closed slot before an owner witness can authorize geometry", async () => {
  const f = ownerFixture();
  try {
    const native = ancestorTransport(f);
    const root = f.document.body.attachShadow({ mode: "closed" });
    root.innerHTML =
      '<div style="transform:matrix(-1,0,0,-1,0,0)"><slot></slot></div>';
    native.roots.set(f.document.body, root);
    assert.equal(f.frame.assignedSlot, null);
    // The JS witness alone cannot see this root. Native classification must run.
    assert.equal(f.read().width, 200);
    await assert.rejects(
      resolveBrowserFrameAncestorEvidence("owner", native.send),
      /shadow-slot ancestry is unresolved/,
    );
    assert.equal(native.objects.size, 1);
  } finally {
    f.dom.window.close();
  }
});

test("ancestor cleanup is followed by native classification and exact chain confirmation", async () => {
  const f = ownerFixture();
  try {
    const native = ancestorTransport(f);
    let changed = false;
    native.hooks.before = (method) => {
      if (!changed && method === "Runtime.releaseObject") {
        changed = true;
        const root = f.document.body.attachShadow({ mode: "closed" });
        root.innerHTML = "<slot></slot>";
        native.roots.set(f.document.body, root);
      }
    };
    await assert.rejects(
      resolveBrowserFrameAncestorEvidence("owner", native.send),
      /shadow-slot ancestry is unresolved/,
    );
    assert.equal(native.objects.size, 1);
  } finally {
    f.dom.window.close();
  }
});

test("receipt can recheck native ancestors after its caller releases the owner wrapper", async () => {
  const f = ownerFixture();
  try {
    const native = ancestorTransport(f);
    const evidence = await resolveBrowserFrameAncestorEvidence(
      "owner",
      native.send,
    );
    native.objects.delete("owner");
    const root = f.document.body.attachShadow({ mode: "closed" });
    root.innerHTML = "<slot></slot>";
    native.roots.set(f.document.body, root);
    await assert.rejects(
      evidence.recheckNative(),
      /shadow-slot ancestry is unresolved/,
    );
    assert.equal(native.objects.size, 0);
  } finally {
    f.dom.window.close();
  }
});
