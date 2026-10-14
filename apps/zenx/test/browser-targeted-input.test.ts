import { evaluateBrowserDocument } from "../src/main/capabilities/browser-provider.js";
import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import {
  assertBrowserInputSnapshot,
  browserInputPoint,
  browserInputProbeScript,
  browserInputSnapshotScript,
  requireBrowserInputSnapshot,
  resolveBrowserInputEvidence,
  BrowserInputUnsupportedError,
  dispatchBrowserTargetedInput,
  BrowserInputOutcomeUnknownError,
  type BrowserInputSnapshot,
  type BrowserTargetedInputPort,
} from "../src/main/capabilities/browser-targeted-input.js";
const snapshot = (): BrowserInputSnapshot => ({
  documentKey: "0123456789abcdef0123456789abcdef|https://fixture.test",
  viewport: {
    width: 640,
    height: 480,
    deviceScaleFactor: 2,
    scrollX: 0,
    scrollY: 0,
    visualScale: 1,
    visualOffsetX: 0,
    visualOffsetY: 0,
  },
  focusId: "input-1",
  inputRevision: 0,
  layoutRevision: 0,
});
function fixture() {
  let current = snapshot();
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  let quarantined = false;
  let forbidden = false;
  const port: BrowserTargetedInputPort = {
    assertCurrent() {
      if (forbidden) throw new Error("control changed");
    },
    snapshot: async () => structuredClone(current),
    dispatch: async (method, params, onDispatched) => {
      calls.push({ method, params });
      onDispatched();
      current.inputRevision++;
    },
    beforeDispatch() {},
    quarantine() {
      quarantined = true;
    },
  };
  return {
    port,
    calls,
    current,
    change: () => {
      forbidden = true;
    },
    get quarantined() {
      return quarantined;
    },
  };
}
test("targeted click uses CSS viewport coordinates, never OS input or tab activation", async () => {
  const f = fixture();
  await dispatchBrowserTargetedInput(f.port, snapshot(), {
    kind: "click",
    x: 100,
    y: 80,
  });
  assert.deepEqual(
    f.calls.map((x) => [x.method, x.params.type, x.params.x, x.params.y]),
    [
      ["Input.dispatchMouseEvent", "mousePressed", 100, 80],
      ["Input.dispatchMouseEvent", "mouseReleased", 100, 80],
    ],
  );
  assert.equal(f.quarantined, false);
});
test("named key uses the exact observed focused element and no unbounded shortcut", async () => {
  const f = fixture();
  await dispatchBrowserTargetedInput(f.port, snapshot(), {
    kind: "key",
    key: "Enter",
  });
  assert.deepEqual(
    f.calls.map((x) => [x.method, x.params.type, x.params.key]),
    [
      ["Input.dispatchKeyEvent", "keyDown", "Enter"],
      ["Input.dispatchKeyEvent", "keyUp", "Enter"],
    ],
  );
  const g = fixture();
  g.current.focusId = null;
  await assert.rejects(
    dispatchBrowserTargetedInput(
      g.port,
      { ...snapshot(), focusId: null },
      { kind: "key", key: "Enter" },
    ),
    /focused element/,
  );
  assert.equal(g.calls.length, 0);
});
test("stale focus, scroll, resize, input and document dispatch no input", async () => {
  for (const change of [
    (s: BrowserInputSnapshot) => (s.focusId = "other"),
    (s: BrowserInputSnapshot) => (s.viewport.scrollY = 5),
    (s: BrowserInputSnapshot) => (s.viewport.width = 600),
    (s: BrowserInputSnapshot) => s.inputRevision++,
    (s: BrowserInputSnapshot) => (s.documentKey += "new"),
  ]) {
    const f = fixture();
    change(f.current);
    await assert.rejects(
      dispatchBrowserTargetedInput(f.port, snapshot(), {
        kind: "click",
        x: 5,
        y: 5,
      }),
      /changed/,
    );
    assert.equal(f.calls.length, 0);
    assert.equal(f.quarantined, false);
  }
});
test("control change, navigation, or concurrent input after press never releases into a successor", async () => {
  for (const change of [
    (f: ReturnType<typeof fixture>) => f.change(),
    (f: ReturnType<typeof fixture>) => (f.current.documentKey += "new"),
    (f: ReturnType<typeof fixture>) => f.current.inputRevision++,
  ]) {
    const f = fixture();
    const send = f.port.dispatch;
    f.port.dispatch = async (method, params, onDispatched) => {
      await send(method, params, onDispatched);
      change(f);
    };
    await assert.rejects(
      dispatchBrowserTargetedInput(f.port, snapshot(), {
        kind: "click",
        x: 5,
        y: 5,
      }),
      BrowserInputOutcomeUnknownError,
    );
    assert.equal(f.calls.length, 1);
    assert.equal(f.quarantined, true);
  }
});
test("cancel before press is safe; cancel after press is quarantined without replay", async () => {
  for (const before of [true, false]) {
    const f = fixture();
    const controller = new AbortController();
    if (before) controller.abort();
    else {
      const send = f.port.dispatch;
      f.port.dispatch = async (m, p, onDispatched) => {
        await send(m, p, onDispatched);
        controller.abort();
      };
    }
    await assert.rejects(
      dispatchBrowserTargetedInput(
        f.port,
        snapshot(),
        { kind: "key", key: "Enter" },
        controller.signal,
      ),
    );
    assert.equal(f.calls.length, before ? 0 : 1);
    assert.equal(f.quarantined, !before);
  }
});
test("coordinates and zoom are validated rather than guessing screenshot DPR", () => {
  const s = snapshot();
  assert.deepEqual(browserInputPoint(s, 639, 479), { x: 639, y: 479 });
  for (const [x, y] of [
    [640, 0],
    [-1, 0],
    [NaN, 0],
    [0, Infinity],
  ])
    assert.throws(() => browserInputPoint(s, x, y));
  assert.throws(
    () =>
      assertBrowserInputSnapshot(s, {
        ...s,
        viewport: { ...s.viewport, deviceScaleFactor: 1 },
      }),
    /changed/,
  );
});

test("a keydown's own scroll and focus change does not strand its keyup", async () => {
  const f = fixture();
  const send = f.port.dispatch;
  f.port.dispatch = async (method, params, onDispatched) => {
    await send(method, params, onDispatched);
    if (params.type === "rawKeyDown") {
      f.current.viewport.scrollY = 50;
      f.current.layoutRevision++;
      f.current.focusId = "next-field";
    }
  };
  await dispatchBrowserTargetedInput(f.port, snapshot(), {
    kind: "key",
    key: "Tab",
  });
  assert.equal(f.calls.length, 2);
  assert.equal(f.quarantined, false);
});

test("a fence change after acknowledged release is unknown but does not quarantine held input", async () => {
  const f = fixture();
  const send = f.port.dispatch;
  f.port.dispatch = async (method, params, onDispatched) => {
    await send(method, params, onDispatched);
    if (params.type === "mouseReleased") f.change();
  };
  await assert.rejects(
    dispatchBrowserTargetedInput(f.port, snapshot(), {
      kind: "click",
      x: 5,
      y: 5,
    }),
    (error) =>
      error instanceof BrowserInputOutcomeUnknownError &&
      !error.inputMayRemainPressed,
  );
  assert.equal(f.calls.length, 2);
  assert.equal(f.quarantined, false);
});

test("native picker controls and associated label descendants reject before any input", () => {
  const dom = new JSDOM(
    '<input type="file" id="file"><label for="file"><span id="file-label">Choose file</span></label><input id="text"><label for="text" id="text-label">Text</label>',
    { runScripts: "outside-only", url: "https://fixture.test" },
  );
  try {
    for (const id of ["file", "file-label"]) {
      dom.window.document.elementFromPoint = () =>
        dom.window.document.getElementById(id);
      assert.throws(
        () =>
          requireBrowserInputSnapshot(
            dom.window.eval(
              browserInputProbeScript({ kind: "click", x: 5, y: 5 }),
            ),
          ),
        /BROWSER_INPUT_UNSUPPORTED:native-surface/u,
      );
    }
    dom.window.document.elementFromPoint = () =>
      dom.window.document.getElementById("text-label");
    assert.equal(
      typeof (
        dom.window.eval(
          browserInputProbeScript({ kind: "click", x: 5, y: 5 }),
        ) as BrowserInputSnapshot
      ).pointerHitId,
      "string",
    );
  } finally {
    dom.window.close();
  }
});

test("a synchronous adapter rejection before the send boundary neither consumes nor quarantines", async () => {
  const f = fixture();
  let consumed = false;
  f.port.beforeDispatch = () => {
    consumed = true;
  };
  f.port.dispatch = () => {
    throw new Error("not sent");
  };
  await assert.rejects(
    dispatchBrowserTargetedInput(f.port, snapshot(), {
      kind: "click",
      x: 5,
      y: 5,
    }),
    /not sent/u,
  );
  assert.equal(consumed, false);
  assert.equal(f.quarantined, false);
});

test("acknowledged press completes its release when window handlers consume DOM observer events", async () => {
  for (const kind of ["key", "click"] as const) {
    for (const stop of [
      "stopPropagation",
      "stopImmediatePropagation",
    ] as const) {
      const dom = new JSDOM('<input id="field"><canvas id="canvas"></canvas>', {
        runScripts: "outside-only",
        url: "https://fixture.test",
      });
      try {
        const { document } = dom.window;
        const target = document.getElementById(
          kind === "key" ? "field" : "canvas",
        )!;
        if (kind === "key") target.focus();
        document.elementFromPoint = () => target;
        let consumed = 0;
        const eventType = kind === "key" ? "keydown" : "pointerdown";
        // Registered before the tracker, including the same-level immediate-stop case.
        dom.window.addEventListener(
          eventType,
          (event) => {
            consumed++;
            event[stop]();
          },
          true,
        );
        const listen = document.addEventListener.bind(document);
        document.addEventListener = (
          type: string,
          listener: EventListenerOrEventListenerObject | null,
          options?: boolean | AddEventListenerOptions,
        ) =>
          listen(
            type,
            (event) => {
              // JSDOM cannot create trusted native events. This shim covers only
              // event propagation + helper protocol semantics, not native acceptance.
              const trustedView = new Proxy(event, {
                get: (target, key) =>
                  key === "isTrusted" ? true : Reflect.get(target, key, target),
              });
              if (typeof listener === "function") listener(trustedView);
              else listener?.handleEvent(trustedView);
            },
            options,
          );
        const action =
          kind === "key"
            ? { kind, key: "Enter" as const }
            : { kind, x: 5, y: 5 };
        const read = () =>
          dom.window.eval(
            browserInputProbeScript(action),
          ) as BrowserInputSnapshot;
        const observed = read();
        const sent: unknown[] = [];
        let quarantined = false;
        const port: BrowserTargetedInputPort = {
          assertCurrent() {},
          snapshot: async () => read(),
          beforeDispatch() {},
          dispatch: async (_method, params, onDispatched) => {
            sent.push(params.type);
            onDispatched();
            target.dispatchEvent(
              new dom.window.Event(
                params.type === "keyUp"
                  ? "keyup"
                  : params.type === "mouseReleased"
                    ? "pointerup"
                    : eventType,
                { bubbles: true },
              ),
            );
          },
          quarantine() {
            quarantined = true;
          },
        };
        await dispatchBrowserTargetedInput(port, observed, action);
        assert.deepEqual(
          sent,
          kind === "key"
            ? ["keyDown", "keyUp"]
            : ["mousePressed", "mouseReleased"],
        );
        assert.equal(consumed, 1);
        assert.equal(quarantined, false);
      } finally {
        dom.window.close();
      }
    }
  }
});

function shadowFixture(mode: ShadowRootMode = "open") {
  const dom = new JSDOM('<div id="host" tabindex="0"></div>', {
    runScripts: "outside-only",
    url: "https://fixture.test",
  });
  const host = dom.window.document.getElementById("host")!;
  const root = host.attachShadow({ mode });
  root.innerHTML = '<input id="a"><input id="b"><canvas id="canvas"></canvas>';
  dom.window.document.elementFromPoint = () => host;
  return {
    dom,
    host,
    root,
    read: () =>
      dom.window.eval(browserInputSnapshotScript) as BrowserInputSnapshot,
  };
}

test("open shadow focus resolves the real input and invalidates A to B before dispatch", async () => {
  const f = shadowFixture();
  try {
    (f.root.getElementById("a") as HTMLElement).focus();
    const before = f.read();
    (f.root.getElementById("b") as HTMLElement).focus();
    const after = f.read();
    assert.notEqual(before.focusId, null);
    assert.notEqual(before.focusId, after.focusId);
    assert.throws(() => assertBrowserInputSnapshot(before, after), /changed/);
    let sent = 0;
    await assert.rejects(
      dispatchBrowserTargetedInput(
        {
          assertCurrent() {},
          snapshot: async () => after,
          beforeDispatch() {},
          dispatch: async () => {
            sent++;
          },
          quarantine() {},
        },
        before,
        { kind: "key", key: "Enter" },
      ),
      /changed/,
    );
    assert.equal(sent, 0);
    f.root.elementFromPoint = () => f.root.getElementById("canvas");
    const pointer = f.dom.window.eval(
      browserInputProbeScript({ kind: "click", x: 5, y: 5 }),
    ) as BrowserInputSnapshot;
    assert.equal(typeof pointer.pointerHitId, "string");
  } finally {
    f.dom.window.close();
  }
});

test("shadow native picker controls and associated labels reject before any Input dispatch", async () => {
  const f = shadowFixture();
  try {
    for (const control of [
      'input type="file"',
      'input type="color"',
      'input type="date"',
      "select",
    ]) {
      f.root.innerHTML = `<${control} id="picker"></${control.split(" ")[0]}><label id="label" tabindex="0" for="picker"><span id="child">Choose</span></label>`;
      for (const id of ["picker", "label", "child"]) {
        const target = f.root.getElementById(id)!;
        f.root.elementFromPoint = () => target;
        let sent = 0;
        await assert.rejects(
          dispatchBrowserTargetedInput(
            {
              assertCurrent() {},
              snapshot: async () =>
                f.dom.window.eval(
                  browserInputProbeScript({ kind: "click", x: 5, y: 5 }),
                ) as BrowserInputSnapshot,
              beforeDispatch() {},
              dispatch: async () => {
                sent++;
              },
              quarantine() {},
            },
            f.read(),
            { kind: "click", x: 5, y: 5 },
          ),
          /BROWSER_INPUT_UNSUPPORTED:native-surface/,
        );
        assert.equal(sent, 0);
        if (id !== "child") {
          (target as HTMLElement).focus();
          const observed = f.read();
          assert.equal(observed.focusId, null);
          await assert.rejects(
            dispatchBrowserTargetedInput(
              {
                assertCurrent() {},
                snapshot: async () => f.read(),
                beforeDispatch() {},
                dispatch: async () => {
                  sent++;
                },
                quarantine() {},
              },
              observed,
              { kind: "key", key: "Enter" },
            ),
            /BROWSER_INPUT_UNSUPPORTED:native-surface/,
          );
          assert.equal(sent, 0);
        }
      }
    }
  } finally {
    f.dom.window.close();
  }
});

test("closed or indeterminate shadow surfaces reject locally while DOM snapshot stays available", async () => {
  const f = shadowFixture("closed");
  try {
    const evidence = domEvidence(f.dom, new Map([[f.host, f.root]]));
    (f.root.getElementById("a") as HTMLElement).focus();
    const inspected = await evidence.read();
    assert.equal(inspected.focusId, null);
    assert.equal(inspected.focusUnsupported, "shadow-surface");
    await assert.rejects(
      evidence.read({ kind: "click", x: 5, y: 5 }),
      (error) =>
        error instanceof BrowserInputUnsupportedError &&
        error.reason === "shadow-surface",
    );
    assert.equal(f.read().viewport.width, 1024);
    assert.equal(evidence.liveObjects.size, 0);
  } finally {
    f.dom.window.close();
  }
  const open = shadowFixture();
  try {
    open.root.elementFromPoint = () => open.host;
    assert.throws(
      () =>
        requireBrowserInputSnapshot(
          open.dom.window.eval(
            browserInputProbeScript({ kind: "click", x: 5, y: 5 }),
          ),
        ),
      /BROWSER_INPUT_UNSUPPORTED:shadow-surface/,
    );
  } finally {
    open.dom.window.close();
  }
});

function domEvidence(dom: JSDOM, closedRoots = new Map<Element, ShadowRoot>()) {
  let sequence = 0;
  const liveObjects = new Map<string, Element>();
  const backendNodes = new Map<number, Element>();
  const nodeIds = new WeakMap<Element, number>();
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const fixture: {
    before?: (method: string, params: Record<string, unknown>) => void;
    malformed?: boolean;
  } = {};
  const send = async (method: string, params: Record<string, unknown>) => {
    calls.push({ method, params });
    fixture.before?.(method, params);
    if (method === "Runtime.evaluate") {
      const value = dom.window.eval(String(params.expression));
      if (params.returnByValue !== false) return { result: { value } };
      if (!(value instanceof dom.window.Element))
        return { result: { subtype: "null", value: null } };
      const objectId = `owned:${++sequence}`;
      liveObjects.set(objectId, value);
      return { result: { subtype: "node", objectId } };
    }
    if (method === "Runtime.releaseObject") {
      assert.ok(liveObjects.delete(String(params.objectId)));
      return {};
    }
    assert.equal(method, "DOM.describeNode");
    assert.equal(params.depth, 0);
    assert.equal(params.pierce, false);
    const node = params.objectId
      ? liveObjects.get(String(params.objectId))
      : backendNodes.get(Number(params.backendNodeId));
    assert.ok(
      node,
      "Only a node allocated by this exact fixture session may be described",
    );
    if (fixture.malformed) return { node: {} };
    let backendNodeId = nodeIds.get(node);
    if (!backendNodeId) {
      backendNodeId = ++sequence;
      nodeIds.set(node, backendNodeId);
      backendNodes.set(backendNodeId, node);
    }
    const shadow = node.shadowRoot ?? closedRoots.get(node);
    return {
      node: {
        backendNodeId,
        nodeType: 1,
        localName: node.localName,
        attributes: [...node.attributes].flatMap((attribute) => [
          attribute.name,
          attribute.value,
        ]),
        ...(shadow ? { shadowRoots: [{ shadowRootType: shadow.mode }] } : {}),
      },
    };
  };
  return {
    fixture,
    calls,
    liveObjects,
    closedRoots,
    read: async (action?: { kind: "click"; x: number; y: number }) =>
      requireBrowserInputSnapshot(
        await resolveBrowserInputEvidence(
          dom.window.eval(
            action
              ? browserInputProbeScript(action)
              : browserInputSnapshotScript,
          ),
          send,
        ),
      ),
  };
}

test("trusted metadata admits ordinary div/span/contenteditable without admitting closed roots", async () => {
  const dom = new JSDOM(
    '<button><span id="styled">Save</span></button><div id="widget" role="button" tabindex="0">Submit</div><div id="editor" tabindex="0" contenteditable="true">Draft</div>',
    { runScripts: "outside-only", url: "https://fixture.test" },
  );
  try {
    const evidence = domEvidence(dom);
    for (const id of ["styled", "widget", "editor"]) {
      const element = dom.window.document.getElementById(id)!;
      dom.window.document.elementFromPoint = () => element;
      const snapshot = await evidence.read({ kind: "click", x: 5, y: 5 });
      assert.equal(typeof snapshot.pointerHitId, "string");
      assert.ok(snapshot.pointerBackendNodeId);
      assert.equal(evidence.liveObjects.size, 0);
    }
    dom.window.document.getElementById("editor")!.focus();
    const focused = await evidence.read();
    assert.ok(focused.focusId && focused.focusBackendNodeId);
    assert.equal(focused.focusUnsupported, undefined);
  } finally {
    dom.window.close();
  }
});

for (const boundary of [
  "reference",
  "describe",
  "release",
  "final-probe",
  "final-describe",
] as const) {
  for (const change of ["replacement", "closed-root"] as const) {
    test(`${change} at ${boundary} invalidates exact surface evidence before input`, async () => {
      const dom = new JSDOM('<div id="widget" tabindex="0">Widget</div>', {
        runScripts: "outside-only",
        url: "https://fixture.test",
      });
      try {
        const evidence = domEvidence(dom);
        let node = dom.window.document.getElementById("widget")!;
        node.focus();
        dom.window.document.elementFromPoint = () => node;
        let changed = false;
        evidence.fixture.before = (method, params) => {
          const match =
            boundary === "reference"
              ? method === "Runtime.evaluate" && params.returnByValue === false
              : boundary === "describe"
                ? method === "DOM.describeNode" && params.objectId !== undefined
                : boundary === "release"
                  ? method === "Runtime.releaseObject"
                  : boundary === "final-probe"
                    ? method === "Runtime.evaluate" &&
                      params.returnByValue === true
                    : method === "DOM.describeNode" &&
                      params.backendNodeId !== undefined;
          if (!match || changed) return;
          changed = true;
          if (change === "replacement") {
            const replacement = node.cloneNode(true) as HTMLElement;
            node.replaceWith(replacement);
            node = replacement;
            node.focus();
          } else {
            const root = node.attachShadow({ mode: "closed" });
            root.innerHTML = '<input type="file">';
            evidence.closedRoots.set(node, root);
          }
        };
        await assert.rejects(evidence.read({ kind: "click", x: 5, y: 5 }));
        assert.equal(changed, true);
        assert.equal(evidence.liveObjects.size, 0);
      } finally {
        dom.window.close();
      }
    });
  }
}

test("unknown surface metadata cannot masquerade as a classified native refusal", async () => {
  const dom = new JSDOM('<div id="widget">Widget</div>', {
    runScripts: "outside-only",
    url: "https://fixture.test",
  });
  try {
    const evidence = domEvidence(dom);
    dom.window.document.elementFromPoint = () =>
      dom.window.document.getElementById("widget");
    evidence.fixture.malformed = true;
    await assert.rejects(
      evidence.read({ kind: "click", x: 5, y: 5 }),
      (error) =>
        !(error instanceof BrowserInputUnsupportedError) &&
        /evidence.*malformed/.test(String(error)),
    );
    assert.equal(evidence.liveObjects.size, 0);
  } finally {
    dom.window.close();
  }
});

test("shadow layout changes invalidate screenshots and bounded discovery rejects only untracked roots", () => {
  const f = shadowFixture();
  try {
    const observed = f.read();
    f.root.getElementById("canvas")!.setAttribute("width", "320");
    assert.throws(
      () => assertBrowserInputSnapshot(observed, f.read()),
      /changed/,
    );
    const beforeScroll = f.read();
    f.root
      .getElementById("canvas")!
      .dispatchEvent(new f.dom.window.Event("scroll"));
    assert.throws(
      () => assertBrowserInputSnapshot(beforeScroll, f.read()),
      /changed/,
    );
    const beforeNewRoot = f.read();
    const host = f.dom.window.document.createElement("div");
    f.dom.window.document.body.append(host);
    f.read(); // Account for the light-DOM insertion first.
    const beforeAttach = f.read();
    host.attachShadow({ mode: "open" }).innerHTML = "<canvas></canvas>";
    assert.throws(
      () => assertBrowserInputSnapshot(beforeAttach, f.read()),
      /changed/,
    );
    assert.throws(
      () => assertBrowserInputSnapshot(beforeNewRoot, f.read()),
      /changed/,
    );
    for (let index = 0; index < 129; index++) {
      const extra = f.dom.window.document.createElement("div");
      f.dom.window.document.body.append(extra);
      const root = extra.attachShadow({ mode: "open" });
      root.innerHTML = "<input>";
      root.elementFromPoint = () => root.querySelector("input");
      if (index === 128) {
        f.dom.window.document.elementFromPoint = () => extra;
        root.querySelector("input")!.focus();
      }
    }
    assert.equal(f.read().focusId, null);
    assert.throws(
      () =>
        requireBrowserInputSnapshot(
          f.dom.window.eval(
            browserInputProbeScript({ kind: "click", x: 5, y: 5 }),
          ),
        ),
      /BROWSER_INPUT_UNSUPPORTED:shadow-surface/,
    );
  } finally {
    f.dom.window.close();
  }
});

test("nested open roots resolve supported leaves without treating outer hosts as opaque", () => {
  const f = shadowFixture();
  try {
    const nestedHost = f.dom.window.document.createElement("div");
    f.root.append(nestedHost);
    const nested = nestedHost.attachShadow({ mode: "open" });
    nested.innerHTML = '<input id="inner"><canvas id="inner-canvas"></canvas>';
    const input = nested.getElementById("inner") as HTMLInputElement;
    input.focus();
    assert.notEqual(f.read().focusId, null);
    f.root.elementFromPoint = () => nestedHost;
    nested.elementFromPoint = () => nested.getElementById("inner-canvas");
    assert.equal(
      typeof (
        f.dom.window.eval(
          browserInputProbeScript({ kind: "click", x: 5, y: 5 }),
        ) as BrowserInputSnapshot
      ).pointerHitId,
      "string",
    );
    let lastRoot = nested;
    for (let index = 0; index < 33; index++) {
      const host = f.dom.window.document.createElement("div");
      lastRoot.append(host);
      lastRoot.elementFromPoint = () => host;
      lastRoot = host.attachShadow({ mode: "open" });
    }
    lastRoot.innerHTML = "<input>";
    lastRoot.querySelector("input")!.focus();
    const leaf = lastRoot;
    lastRoot.elementFromPoint = () => leaf.querySelector("input");
    assert.equal(f.read().focusId, null);
    assert.throws(
      () =>
        requireBrowserInputSnapshot(
          f.dom.window.eval(
            browserInputProbeScript({ kind: "click", x: 5, y: 5 }),
          ),
        ),
      /BROWSER_INPUT_UNSUPPORTED:shadow-surface/,
    );
  } finally {
    f.dom.window.close();
  }
});

test("Electron and Workspace evaluation preserves only known structured surface refusals", async () => {
  for (const known of [true, false]) {
    const commands: string[] = [];
    await assert.rejects(
      evaluateBrowserDocument(
        {
          sendCommand: async (method) => {
            commands.push(method);
            if (method === "Page.getFrameTree")
              return { frameTree: { frame: { id: "main" } } };
            if (method === "Page.createIsolatedWorld")
              return { executionContextId: 1 };
            return known
              ? {
                  result: {
                    value: { browserInputUnsupported: "native-surface" },
                  },
                }
              : {
                  exceptionDetails: {
                    text: "Uncaught",
                    exception: {
                      description: "BROWSER_INPUT_UNSUPPORTED:native-surface",
                    },
                  },
                };
          },
        },
        browserInputProbeScript({ kind: "click", x: 5, y: 5 }),
      ),
      (error) =>
        known
          ? error instanceof BrowserInputUnsupportedError &&
            error.reason === "native-surface"
          : !(error instanceof BrowserInputUnsupportedError) &&
            /evaluation failed/.test(String(error)),
    );
    assert.ok(!commands.some((method) => method.startsWith("Input.")));
  }
});
