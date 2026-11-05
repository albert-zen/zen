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
  requireBrowserInputSnapshot,
  type BrowserInputSnapshot,
  type BrowserTargetedInputPort,
} from "../src/main/capabilities/browser-targeted-input.js";

function addFrame(doc: Document, x = 40, y = 30) {
  const frame = doc.createElement("iframe");
  frame.style.cssText = "width:200px;height:120px;border:3px solid;padding:2px";
  doc.body.append(frame);
  const child = frame.contentDocument!;
  child.body.innerHTML =
    '<input id="a"><input id="b"><canvas id="canvas"></canvas>';
  const view = child.defaultView!;
  Object.defineProperties(view, {
    innerWidth: { value: 200, configurable: true },
    innerHeight: { value: 120, configurable: true },
  });
  const rect = {
    x,
    y,
    left: x,
    top: y,
    width: 210,
    height: 130,
    right: x + 210,
    bottom: y + 130,
    toJSON() {},
  };
  frame.getBoundingClientRect = () => rect;
  const points: number[][] = [];
  child.elementFromPoint = (px, py) => {
    points.push([px, py]);
    return child.getElementById("canvas");
  };
  return { frame, child, view, rect, points };
}

function fixture() {
  const dom = new JSDOM("<!doctype html><body></body>", {
    runScripts: "outside-only",
    url: "https://fixture.test/",
  });
  const outer = addFrame(dom.window.document);
  dom.window.document.elementFromPoint = () => outer.frame;
  const read = (action?: { kind: "click"; x: number; y: number }) =>
    requireBrowserInputSnapshot(
      dom.window.eval(
        action ? browserInputProbeScript(action) : browserInputSnapshotScript,
      ),
    );
  return { dom, ...outer, read };
}

function portFor(read: () => BrowserInputSnapshot, afterPress?: () => void) {
  const calls: Array<Record<string, unknown>> = [];
  let quarantine = false;
  const port: BrowserTargetedInputPort = {
    assertCurrent() {},
    snapshot: async () => read(),
    beforeDispatch() {},
    dispatch: async (_method, params, sent) => {
      calls.push(params);
      sent();
      if (calls.length === 1) afterPress?.();
    },
    quarantine() {
      quarantine = true;
    },
  };
  return {
    port,
    calls,
    get quarantined() {
      return quarantine;
    },
  };
}

test("same-origin nested iframe hit mapping includes each border and padding without changing top-level Input coordinates", async () => {
  const f = fixture();
  try {
    const inner = addFrame(f.child, 10, 12);
    f.child.elementFromPoint = (x, y) => {
      f.points.push([x, y]);
      return inner.frame;
    };
    const observed = f.read();
    assert.equal(observed.frameDocuments?.length, 2);
    const action = { kind: "click" as const, x: 70, y: 62 };
    const input = portFor(() => f.read(action));
    await dispatchBrowserTargetedInput(input.port, observed, action);
    assert.deepEqual(f.points, [
      [25, 27],
      [25, 27],
    ]);
    assert.deepEqual(inner.points, [
      [10, 10],
      [10, 10],
    ]);
    assert.deepEqual(
      input.calls.map(({ x, y, type }) => ({ x, y, type })),
      [
        { x: 70, y: 62, type: "mousePressed" },
        { x: 70, y: 62, type: "mouseReleased" },
      ],
    );
    assert.equal(input.quarantined, false);
  } finally {
    f.dom.window.close();
  }
});

test("iframe focus resolves the inner node and detects focus replacement", async () => {
  const f = fixture();
  try {
    f.child.getElementById("a")!.focus();
    const observed = f.read();
    assert.ok(observed.focusId);
    const input = portFor(() => f.read());
    await dispatchBrowserTargetedInput(input.port, observed, {
      kind: "key",
      key: "Enter",
    });
    assert.equal(input.calls.length, 2);
    f.child.getElementById("b")!.focus();
    assert.throws(
      () => assertBrowserInputSnapshot(observed, f.read()),
      /changed/,
    );
  } finally {
    f.dom.window.close();
  }
});

for (const change of [
  "mutation",
  "scroll",
  "resize",
  "input",
  "remove",
  "reload",
  "move",
] as const) {
  test(`child ${change} after screenshot invalidates targeted input before dispatch`, async () => {
    const f = fixture();
    try {
      if (change === "input") {
        const listen = f.child.addEventListener.bind(f.child);
        f.child.addEventListener = (
          type: string,
          listener: EventListenerOrEventListenerObject | null,
          options?: boolean | AddEventListenerOptions,
        ) =>
          listen(
            type,
            (event) => {
              const trusted = new Proxy(event, {
                get: (target, key) =>
                  key === "isTrusted" ? true : Reflect.get(target, key, target),
              });
              if (typeof listener === "function") listener(trusted);
              else listener?.handleEvent(trusted);
            },
            options,
          );
      }
      const observed = f.read();
      if (change === "mutation")
        f.child.getElementById("a")!.setAttribute("data-change", "yes");
      if (change === "scroll" || change === "resize")
        f.view.dispatchEvent(new f.view.Event(change));
      if (change === "input")
        f.child
          .getElementById("a")!
          .dispatchEvent(new f.view.Event("keydown", { bubbles: true }));
      if (change === "remove") f.frame.remove();
      if (change === "reload") f.frame.src = "about:blank";
      if (change === "move") f.rect.left++;
      const input = portFor(() => f.read());
      await assert.rejects(
        dispatchBrowserTargetedInput(input.port, observed, {
          kind: "click",
          x: 50,
          y: 40,
        }),
        /changed/,
      );
      assert.equal(input.calls.length, 0);
      assert.equal(input.quarantined, false);
    } finally {
      f.dom.window.close();
    }
  });
}

for (const change of ["remove", "reload", "move", "scroll"] as const) {
  test(`child ${change} after pointer press quarantines without releasing into changed frame content`, async () => {
    const f = fixture();
    try {
      const action = { kind: "click" as const, x: 50, y: 40 };
      const observed = f.read();
      const input = portFor(
        () => f.read(action),
        () => {
          if (change === "remove") f.frame.remove();
          if (change === "reload") f.frame.src = "about:blank";
          if (change === "move") f.rect.left++;
          if (change === "scroll")
            Object.defineProperty(f.view, "scrollY", { value: 10 });
        },
      );
      await assert.rejects(
        dispatchBrowserTargetedInput(input.port, observed, action),
        BrowserInputOutcomeUnknownError,
      );
      assert.equal(input.calls.length, 1);
      assert.equal(input.quarantined, true);
    } finally {
      f.dom.window.close();
    }
  });
}

test("keydown may scroll and change focus inside an unchanged iframe document", async () => {
  const f = fixture();
  try {
    f.child.getElementById("a")!.focus();
    const observed = f.read();
    const input = portFor(
      () => f.read(),
      () => {
        f.child.getElementById("b")!.focus();
        Object.defineProperty(f.view, "scrollY", { value: 10 });
        f.view.dispatchEvent(new f.view.Event("scroll"));
      },
    );
    await dispatchBrowserTargetedInput(input.port, observed, {
      kind: "key",
      key: "Tab",
    });
    assert.equal(input.calls.length, 2);
    assert.equal(input.quarantined, false);
  } finally {
    f.dom.window.close();
  }
});

for (const limitation of [
  "cross-origin",
  "transform",
  "ancestor-transform",
  "zoom",
  "scale",
  "border",
  "viewport",
] as const) {
  test(`${limitation} iframe mapping refuses locally before Input`, async () => {
    const f = fixture();
    try {
      if (limitation === "cross-origin")
        Object.defineProperty(f.frame, "contentDocument", { get: () => null });
      if (limitation === "transform") f.frame.style.transform = "rotate(10deg)";
      if (limitation === "ancestor-transform")
        f.dom.window.document.body.style.transform = "scale(2)";
      if (limitation === "zoom") f.frame.style.setProperty("zoom", "2");
      if (limitation === "scale") f.frame.style.setProperty("scale", "2");
      if (limitation === "viewport")
        Object.defineProperty(f.view, "innerWidth", { value: 199 });
      const action = {
        kind: "click" as const,
        x: limitation === "border" ? 41 : 50,
        y: 40,
      };
      assert.throws(() => f.read(action), BrowserInputUnsupportedError);
      assert.equal(f.read().documentKey.length > 32, true);
    } finally {
      f.dom.window.close();
    }
  });
}

test("iframe observers cover open-shadow descendants and retire removed documents", () => {
  const f = fixture();
  try {
    const host = f.child.createElement("div");
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = '<input id="inner">';
    f.child.body.append(host);
    const before = f.read();
    root.getElementById("inner")!.setAttribute("data-change", "yes");
    assert.throws(
      () => assertBrowserInputSnapshot(before, f.read()),
      /changed/,
    );
    f.frame.remove();
    f.read();
    assert.equal(
      f.dom.window.eval(
        'globalThis[Symbol.for("zenx-browser-targeted-input-v2")].documents.size',
      ),
      1,
    );
    const after = f.read();
    f.view.dispatchEvent(new f.view.Event("resize"));
    assertBrowserInputSnapshot(after, f.read());
  } finally {
    f.dom.window.close();
  }
});

test("frame document evidence is bounded and rejects malformed or disconnected identity chains", () => {
  const f = fixture();
  try {
    const snapshot = f.read();
    for (const frameDocuments of [
      Array(32).fill(snapshot.frameDocuments![0]),
      [{ ...snapshot.frameDocuments![0], parentDocumentKey: "foreign" }],
      [{ ...snapshot.frameDocuments![0], documentKey: snapshot.documentKey }],
      [
        {
          ...snapshot.frameDocuments![0],
          geometry: { x: NaN, y: 0, width: 200, height: 120 },
        },
      ],
    ])
      assert.throws(
        () => requireBrowserInputSnapshot({ ...snapshot, frameDocuments }),
        /frame evidence/,
      );
  } finally {
    f.dom.window.close();
  }
});
