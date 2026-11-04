import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import {
  assertBrowserInputSnapshot,
  browserInputProbeScript,
  browserInputSnapshotScript,
  dispatchBrowserTargetedInput,
  requireBrowserInputSnapshot,
  resolveBrowserInputEvidence,
  type BrowserInputSnapshot,
} from "../src/main/capabilities/browser-targeted-input.js";

function fixture() {
  const dom = new JSDOM('<div id="host"></div>', {
    runScripts: "outside-only",
    url: "https://fixture.test",
  });
  const host = dom.window.document.getElementById("host")!;
  const root = host.attachShadow({ mode: "closed" });
  root.innerHTML = '<input id="a"><input id="b"><canvas id="canvas"></canvas>';
  dom.window.document.elementFromPoint = () => host;
  root.elementFromPoint = () => root.getElementById("canvas");
  const roots = new Map<Element, ShadowRoot>([[host, root]]);
  const objects = new Map<string, Node>();
  const backendNodes = new Map<number, Node>();
  const ids = new WeakMap<Node, number>();
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  let sequence = 0;
  let inputCount = 0;
  const hooks: {
    before?: (method: string, params: Record<string, unknown>) => void;
    resolvedRoot?: ShadowRoot;
    resolveFailure?: boolean;
  } = {};
  const id = (node: Node) => {
    let value = ids.get(node);
    if (!value) {
      value = ++sequence;
      ids.set(node, value);
      backendNodes.set(value, node);
    }
    return value;
  };
  const remote = (node: Node) => {
    const objectId = `owned:${++sequence}`;
    objects.set(objectId, node);
    return { subtype: "node", objectId };
  };
  const send = async (method: string, params: Record<string, unknown>) => {
    calls.push({ method, params });
    hooks.before?.(method, params);
    if (method === "Runtime.evaluate") {
      const value = dom.window.eval(String(params.expression));
      if (params.returnByValue !== false) return { result: { value } };
      return {
        result:
          value && typeof (value as Node).nodeType === "number"
            ? remote(value as Node)
            : { subtype: "null", value: null },
      };
    }
    if (method === "Runtime.releaseObject") {
      assert.ok(
        objects.delete(String(params.objectId)),
        "Release owned object once",
      );
      return {};
    }
    if (method === "DOM.resolveNode") {
      if (hooks.resolveFailure) throw new Error("Synthetic resolve failure");
      const node =
        hooks.resolvedRoot ?? backendNodes.get(Number(params.backendNodeId));
      assert.ok(node, "Resolve only a described node");
      return { object: remote(node) };
    }
    if (method === "Runtime.callFunctionOn") {
      const node = objects.get(String(params.objectId));
      assert.ok(node, "Invoke only an owned isolated-world wrapper");
      const args = (params.arguments as { value: unknown }[] | undefined) ?? [];
      const fn = dom.window.eval(`(${String(params.functionDeclaration)})`);
      assert.ok(
        typeof fn === "function",
        "Evaluate the trusted registration function",
      );
      try {
        const value = fn.call(node, ...args.map((arg) => arg.value));
        return {
          result:
            params.returnByValue === false && value?.nodeType
              ? remote(value as Node)
              : { value },
        };
      } catch (error) {
        return { exceptionDetails: { text: String(error) } };
      }
    }
    assert.equal(method, "DOM.describeNode");
    assert.equal(params.depth, 0);
    assert.equal(params.pierce, false);
    const node = params.objectId
      ? objects.get(String(params.objectId))
      : backendNodes.get(Number(params.backendNodeId));
    assert.ok(node?.nodeType === 1, "Describe exact owned candidate");
    const element = node as Element;
    const shadow = element.shadowRoot ?? roots.get(element);
    return {
      node: {
        nodeType: 1,
        localName: element.localName,
        attributes: [...element.attributes].flatMap((attr) => [
          attr.name,
          attr.value,
        ]),
        backendNodeId: id(element),
        ...(shadow
          ? {
              shadowRoots: [
                {
                  nodeType: 11,
                  backendNodeId: id(shadow),
                  shadowRootType: shadow.mode,
                },
              ],
            }
          : {}),
      },
    };
  };
  const raw = (click = false) =>
    dom.window.eval(
      click
        ? browserInputProbeScript({ kind: "click", x: 5, y: 5 })
        : browserInputSnapshotScript,
    );
  const read = async (click = false): Promise<BrowserInputSnapshot> =>
    requireBrowserInputSnapshot(
      await resolveBrowserInputEvidence(raw(click), send),
    );
  const inspect = async () =>
    (await resolveBrowserInputEvidence({ inputSnapshot: raw() }, send)) as {
      inputSnapshot?: BrowserInputSnapshot;
    };
  const click = async (observed: BrowserInputSnapshot) =>
    dispatchBrowserTargetedInput(
      {
        assertCurrent() {},
        snapshot: () => read(true),
        beforeDispatch() {},
        async dispatch(_method, _params, dispatched) {
          inputCount++;
          dispatched();
        },
        quarantine() {
          assert.fail("Known undispatched discovery must not quarantine");
        },
      },
      observed,
      { kind: "click", x: 5, y: 5 },
    );
  return {
    dom,
    host,
    root,
    roots,
    objects,
    calls,
    hooks,
    raw,
    read,
    inspect,
    click,
    get inputCount() {
      return inputCount;
    },
  };
}

test("closed-root discovery sends no input and requires a new observed screenshot", async () => {
  const f = fixture();
  try {
    const before = await f.read();
    await assert.rejects(f.click(before), /inspect again/i);
    assert.equal(f.inputCount, 0);
    assert.equal(f.objects.size, 0);
    const observed = await f.read();
    assert.ok(observed.layoutRevision > before.layoutRevision);
    await assert.rejects(f.click(before), /changed|inspect again/i);
    assert.equal(f.inputCount, 0);
    await f.click(observed);
    assert.equal(f.inputCount, 2);
    assert.equal(f.host.shadowRoot, null);
    assert.equal(
      f.calls.filter((call) => call.method === "DOM.resolveNode").length,
      1,
    );
    assert.equal(
      f.calls.filter((call) => call.method === "Runtime.callFunctionOn").length,
      1,
    );
  } finally {
    f.dom.window.close();
  }
});

test("closed inner focus, mutations and scroll remain observable after remote object release", async () => {
  const f = fixture();
  try {
    (f.root.getElementById("a") as HTMLElement).focus();
    assert.equal((await f.inspect()).inputSnapshot, undefined);
    assert.equal(f.objects.size, 0);
    const a = await f.read();
    assert.ok(a.focusId);
    (f.root.getElementById("b") as HTMLElement).focus();
    const b = await f.read();
    assert.notEqual(a.focusId, b.focusId);
    assert.throws(() => assertBrowserInputSnapshot(a, b), /changed/);
    f.root.getElementById("canvas")!.setAttribute("width", "320");
    const mutated = await f.read();
    assert.throws(() => assertBrowserInputSnapshot(b, mutated), /changed/);
    f.root
      .getElementById("canvas")!
      .dispatchEvent(new f.dom.window.Event("scroll"));
    assert.throws(
      () =>
        assertBrowserInputSnapshot(
          mutated,
          requireBrowserInputSnapshot(f.raw()),
        ),
      /changed/,
    );
    assert.equal(f.objects.size, 0);
  } finally {
    f.dom.window.close();
  }
});

test("nested closed roots are discovered individually and never reuse the discovery screenshot", async () => {
  const f = fixture();
  try {
    f.root.innerHTML = '<div id="nested"></div>';
    const nestedHost = f.root.getElementById("nested")!;
    const nested = nestedHost.attachShadow({ mode: "closed" });
    nested.innerHTML = "<canvas></canvas>";
    f.roots.set(nestedHost, nested);
    f.root.elementFromPoint = () => nestedHost;
    nested.elementFromPoint = () => nested.querySelector("canvas");
    await assert.rejects(f.click(await f.read()), /inspect again/i);
    await assert.rejects(f.click(await f.read()), /inspect again/i);
    assert.equal(f.inputCount, 0);
    await f.click(await f.read());
    assert.equal(f.inputCount, 2);
    assert.equal(f.objects.size, 0);
  } finally {
    f.dom.window.close();
  }
});

for (const boundary of ["DOM.resolveNode", "Runtime.callFunctionOn"] as const) {
  test(`detached host at ${boundary} rejects registration and releases owned wrappers`, async () => {
    const f = fixture();
    try {
      f.hooks.before = (method) => {
        if (method === boundary) f.host.remove();
      };
      await assert.rejects(f.click(await f.read()));
      assert.equal(f.inputCount, 0);
      assert.equal(f.objects.size, 0);
    } finally {
      f.dom.window.close();
    }
  });
}

test("wrong-host root wrappers cannot enter the registry", async () => {
  const f = fixture();
  try {
    const wrongHost = f.dom.window.document.createElement("div");
    f.dom.window.document.body.append(wrongHost);
    f.hooks.resolvedRoot = wrongHost.attachShadow({ mode: "closed" });
    await assert.rejects(f.click(await f.read()));
    assert.equal(f.inputCount, 0);
    assert.equal(f.objects.size, 0);
    f.hooks.resolvedRoot = undefined;
    await assert.rejects(f.click(await f.read()), /inspect again/i);
    await f.click(await f.read());
    assert.equal(f.inputCount, 2);
  } finally {
    f.dom.window.close();
  }
});

test("failed resolve remains an ordinary failure and inspection remains available", async () => {
  const f = fixture();
  try {
    f.hooks.resolveFailure = true;
    await assert.rejects(f.click(await f.read()), /Synthetic resolve failure/);
    assert.equal(f.inputCount, 0);
    assert.equal(f.objects.size, 0);
    (f.root.getElementById("a") as HTMLElement).focus();
    assert.equal((await f.inspect()).inputSnapshot, undefined);
    assert.equal(f.objects.size, 0);
  } finally {
    f.dom.window.close();
  }
});

test("closed root attached after capture cannot use the earlier screenshot", async () => {
  const f = fixture();
  try {
    const host = f.dom.window.document.createElement("div");
    f.dom.window.document.body.append(host);
    f.dom.window.document.elementFromPoint = () => host;
    const before = await f.read();
    const root = host.attachShadow({ mode: "closed" });
    root.innerHTML = "<canvas></canvas>";
    root.elementFromPoint = () => root.querySelector("canvas");
    f.roots.set(host, root);
    await assert.rejects(f.click(before), /inspect again/i);
    assert.equal(f.inputCount, 0);
    await assert.rejects(f.click(before), /changed|inspect again/i);
    await f.click(await f.read());
    assert.equal(f.inputCount, 2);
    assert.equal(f.objects.size, 0);
  } finally {
    f.dom.window.close();
  }
});

test("a resolved closed root from another document cannot enter this candidate registry", async () => {
  const f = fixture();
  const other = new JSDOM("<div></div>", { url: "https://fixture.test" });
  try {
    f.hooks.resolvedRoot = other.window.document
      .querySelector("div")!
      .attachShadow({ mode: "closed" });
    await assert.rejects(f.click(await f.read()));
    assert.equal(f.inputCount, 0);
    assert.equal(f.objects.size, 0);
  } finally {
    f.dom.window.close();
    other.window.close();
  }
});

test("closed roots in an observed same-origin child document use that document observer", async () => {
  const f = fixture();
  try {
    const frame = f.dom.window.document.createElement("iframe");
    frame.style.cssText = "border:0;padding:0;width:1024px;height:768px";
    frame.getBoundingClientRect = () => ({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 1024,
      bottom: 768,
      width: 1024,
      height: 768,
      toJSON() {
        return {};
      },
    });
    f.dom.window.document.body.append(frame);
    const doc = frame.contentDocument!;
    doc.body.innerHTML = '<div id="inner"></div>';
    const host = doc.getElementById("inner")!;
    const root = host.attachShadow({ mode: "closed" });
    root.innerHTML = "<canvas></canvas>";
    root.elementFromPoint = () => root.querySelector("canvas");
    doc.elementFromPoint = () => host;
    f.dom.window.document.elementFromPoint = () => frame;
    f.roots.set(host, root);
    await assert.rejects(f.click(await f.read()), /inspect again/i);
    const observed = await f.read();
    assert.equal(observed.frameDocuments?.length, 1);
    await f.click(observed);
    assert.equal(f.inputCount, 2);
    root.querySelector("canvas")!.setAttribute("width", "40");
    await assert.rejects(f.click(observed), /changed/);
    assert.equal(f.inputCount, 2);
  } finally {
    f.dom.window.close();
  }
});

test("closed-root registration respects the shared bounded root budget", async () => {
  const f = fixture();
  try {
    for (let index = 0; index < 128; index++) {
      const host = f.dom.window.document.createElement("div");
      f.dom.window.document.body.append(host);
      host.attachShadow({ mode: "open" });
    }
    await assert.rejects(
      f.click(await f.read()),
      /BROWSER_INPUT_UNSUPPORTED:shadow-surface/,
    );
    assert.equal(f.inputCount, 0);
    assert.equal(f.objects.size, 0);
  } finally {
    f.dom.window.close();
  }
});

test("fresh snapshots reinstall erased observation listeners without duplicate scroll counts", async () => {
  const f = fixture();
  try {
    await assert.rejects(f.click(await f.read()), /inspect again/i);
    await f.read();
    // JSDOM retains listeners on document.open(), unlike the browser. Simulate
    // that specific erasure while retaining the same Document and registry.
    f.dom.window.eval(`(() => {
      const state = globalThis[Symbol.for("zenx-browser-targeted-input-v2")];
      for (const entry of state.documents.values()) {
        for (const { target, type, listener } of entry.listeners) target.removeEventListener(type, listener, true);
      }
    })()`);
    await f.read();
    await f.read();
    const restored = await f.read();
    f.root
      .getElementById("canvas")!
      .dispatchEvent(new f.dom.window.Event("scroll"));
    const after = await f.read();
    assert.equal(after.layoutRevision, restored.layoutRevision + 1);
  } finally {
    f.dom.window.close();
  }
});
