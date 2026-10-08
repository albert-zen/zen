import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import {
  browserActionScript,
  browserDomCapture,
  browserInspectScript,
  browserScrollScript,
  evaluateBrowserDocument,
  type BrowserDomInspection,
  type BrowserTargetFingerprint,
} from "../src/main/capabilities/browser-provider.js";

function fixture(html: string) {
  const dom = new JSDOM(`<style>* { opacity: 1 }</style>${html}`, {
    runScripts: "outside-only",
    url: "https://example.test/",
  });
  dom.window.HTMLElement.prototype.getBoundingClientRect = () => ({
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    width: 100,
    height: 20,
    right: 100,
    bottom: 20,
    toJSON() {
      return {};
    },
  });
  const inspect = () =>
    dom.window.eval(browserInspectScript) as BrowserDomInspection;
  const act = (target: BrowserTargetFingerprint) =>
    dom.window.eval(browserActionScript(target, "click")) as {
      ok: boolean;
      reason?: string;
    };
  return { dom, inspect, act };
}

test("DOM identities survive reorder, rename and control state changes while action fingerprints stay strict", () => {
  const { dom, inspect, act } = fixture(
    '<button id="a">Alpha</button><button id="b">Beta</button><input id="field" value="old">',
  );
  try {
    const before = inspect();
    const [alpha, beta, field] = before.targets;
    const a = dom.window.document.getElementById("a")!;
    const b = dom.window.document.getElementById("b")!;
    b.before(a);
    a.before(b);
    a.textContent = "Renamed";
    (dom.window.document.getElementById("field") as HTMLInputElement).value =
      "new";
    assert.equal(
      act(alpha!).reason,
      "identity-changed",
      "reused DOM nodes cannot authorize changed semantics",
    );
    const after = inspect();
    assert.equal(after.documentIdentity, before.documentIdentity);
    assert.equal(after.targets[0]!.nodeIdentity, beta!.nodeIdentity);
    assert.equal(after.targets[1]!.nodeIdentity, alpha!.nodeIdentity);
    assert.equal(after.targets[2]!.nodeIdentity, field!.nodeIdentity);
    assert.equal(after.targets[2]!.value, "new");
    assert.equal(act(after.targets[1]!).ok, true);
  } finally {
    dom.window.close();
  }
});

test("identical DOM clones never inherit node identity or old action authority", () => {
  const { dom, inspect, act } = fixture('<button id="same">Same</button>');
  try {
    const old = inspect().targets[0]!;
    const element = dom.window.document.getElementById("same")!;
    const clone = element.cloneNode(true);
    let clicks = 0;
    clone.addEventListener("click", () => clicks++);
    element.replaceWith(clone);
    assert.equal(act(old).reason, "node-changed");
    const next = inspect().targets[0]!;
    assert.notEqual(next.nodeIdentity, old.nodeIdentity);
    assert.equal(act(old).ok, false);
    assert.equal(clicks, 0);
    assert.equal(act(next).ok, true);
    assert.equal(clicks, 1);
  } finally {
    dom.window.close();
  }
});

test("same-node actions reject changed observed value, checkbox and selected state until reinspection", () => {
  const { dom, inspect, act } = fixture(
    '<input id="field" value="record-a"><input id="check" type="checkbox"><button id="tab" aria-selected="false">Tab</button>',
  );
  try {
    const before = inspect();
    (dom.window.document.getElementById("field") as HTMLInputElement).value =
      "record-b";
    (dom.window.document.getElementById("check") as HTMLInputElement).checked =
      true;
    dom.window.document
      .getElementById("tab")!
      .setAttribute("aria-selected", "true");
    for (const target of before.targets)
      assert.equal(act(target).reason, "state-changed");
    const after = inspect();
    assert.deepEqual(
      after.targets.map((target) => target.nodeIdentity),
      before.targets.map((target) => target.nodeIdentity),
    );
    assert.equal(act(after.targets[0]!).ok, true);
    assert.equal(act(after.targets[1]!).ok, true);
    assert.equal(act(after.targets[2]!).ok, true);
  } finally {
    dom.window.close();
  }
});

test("DOM state freshness preserves bounded projection and never captures password values", () => {
  const { dom, inspect, act } = fixture(
    `<input id="long" value="${"x".repeat(600)}"><input id="secret" type="password" value="fixture-before">`,
  );
  try {
    const before = inspect();
    assert.equal(before.targets[0]!.value!.length, 512);
    assert.equal(act(before.targets[0]!).ok, true);
    assert.equal(before.targets[1]!.value, undefined);
    (dom.window.document.getElementById("secret") as HTMLInputElement).value =
      "fixture-after";
    assert.equal(act(before.targets[1]!).ok, true);
    assert.doesNotMatch(
      JSON.stringify(inspect()),
      /fixture-before|fixture-after/,
    );
  } finally {
    dom.window.close();
  }
});

test("DOM actions reject newly introduced checked or selected semantics", () => {
  const { dom, inspect, act } = fixture(
    '<button id="check">Toggle</button><button id="select">Select</button>',
  );
  try {
    const before = inspect();
    dom.window.document
      .getElementById("check")!
      .setAttribute("aria-checked", "true");
    dom.window.document
      .getElementById("select")!
      .setAttribute("aria-selected", "true");
    for (const target of before.targets)
      assert.equal(act(target).reason, "state-changed");
  } finally {
    dom.window.close();
  }
});

test("DOM references follow exact objects despite duplicate selectors and reordering", () => {
  const { dom, inspect, act } = fixture(
    '<button id="duplicate">Same</button><button id="duplicate">Same</button>',
  );
  try {
    const [first, second] = inspect().targets;
    const elements = dom.window.document.querySelectorAll("button");
    const clicks: number[] = [];
    elements.forEach((element, index) =>
      element.addEventListener("click", () => clicks.push(index)),
    );
    elements[0]!.before(elements[1]!);
    assert.equal(act(first!).ok, true);
    assert.equal(act(second!).ok, true);
    assert.deepEqual(clicks, [0, 1]);
  } finally {
    dom.window.close();
  }
});

test("same-URL documents get distinct randomized incarnations and route changes reject old actions", () => {
  const a = fixture('<button id="same">Same</button>');
  const b = fixture('<button id="same">Same</button>');
  try {
    const old = a.inspect();
    const other = b.inspect();
    assert.notEqual(other.documentIdentity, old.documentIdentity);
    assert.notEqual(
      other.targets[0]!.nodeIdentity,
      old.targets[0]!.nodeIdentity,
    );
    assert.equal(b.act(old.targets[0]!).reason, "document-changed");
    a.dom.window.history.pushState({}, "", "/next");
    assert.equal(a.act(old.targets[0]!).reason, "document-changed");
    assert.notEqual(a.inspect().documentIdentity, old.documentIdentity);
  } finally {
    a.dom.window.close();
    b.dom.window.close();
  }
});

test("hidden DOM capture retains later targets and text with exact native omissions", () => {
  const { dom, inspect, act } = fixture(
    Array.from(
      { length: 520 },
      (_, index) => `<button id="b${index}">Button ${index}</button>`,
    ).join(""),
  );
  try {
    Object.defineProperty(dom.window.document.body, "innerText", {
      value: "x".repeat(130_000),
      configurable: true,
    });
    const raw = inspect();
    assert.equal(raw.targets.length, 512);
    assert.equal(raw.itemTotal, 520);
    assert.equal(raw.visibleText.length, 128_000);
    assert.equal(raw.textTotal, 130_000);
    assert.equal(raw.targets[100]!.name, "Button 100");
    assert.equal(act(raw.targets[100]!).ok, true);
    const projected = raw.targets.map((target, index) => ({
      targetId: String(index),
      role: target.role,
      name: target.name,
      actions: target.actions,
    }));
    const capture = browserDomCapture(raw, projected, "session/tab");
    assert.equal(capture.entries.length, 512);
    assert.equal(
      capture.entries[100]!.identity,
      raw.targets[100]!.nodeIdentity,
    );
    assert.equal(capture.text!.length, 128_000);
    assert.equal(capture.coverage.sourceComplete, false);
    assert.deepEqual(capture.coverage.reasons, [
      "iframe-and-shadow-root-content-excluded",
      "native-target-limit",
      "native-text-limit",
    ]);
    assert.equal(capture.coverage.itemTotal, 520);
    assert.equal(capture.coverage.textTotal, 130_000);
    const unknown = browserDomCapture(
      { targets: raw.targets, visibleText: "legacy" },
      projected,
      "legacy",
    );
    assert.equal(unknown.coverage.sourceComplete, null);
    assert.equal(unknown.entries[0]!.identity, undefined);
  } finally {
    dom.window.close();
  }
});

test("Electron DOM evaluation always selects an isolated world and never falls back to main world", async () => {
  const commands: Array<{ method: string; params?: Record<string, unknown> }> =
    [];
  const debuggerApi = {
    async sendCommand(method: string, params?: Record<string, unknown>) {
      commands.push({ method, params });
      if (method === "Page.getFrameTree")
        return { frameTree: { frame: { id: "frame" } } };
      if (method === "Page.createIsolatedWorld")
        return { executionContextId: 52 };
      return { result: { value: "observed" } };
    },
  };
  assert.equal(
    await evaluateBrowserDocument(debuggerApi, browserInspectScript),
    "observed",
  );
  assert.equal(commands[1]!.params!.worldName, "zenx-browser-observation-v1");
  assert.equal(commands[1]!.params!.grantUniveralAccess, false);
  assert.equal(commands[2]!.params!.contextId, 52);
  const rejected: string[] = [];
  await assert.rejects(
    evaluateBrowserDocument(
      {
        async sendCommand(method) {
          rejected.push(method);
          return method === "Page.getFrameTree"
            ? { frameTree: { frame: { id: "frame" } } }
            : {};
        },
      },
      "dangerous()",
    ),
    /isolated execution context/,
  );
  assert.deepEqual(rejected, ["Page.getFrameTree", "Page.createIsolatedWorld"]);
});

test("observed DOM scroll rejects a changed document inside the mutation callback", () => {
  const a = fixture("<button>Scroll</button>");
  const b = fixture("<button>Scroll</button>");
  try {
    const prior = a.inspect();
    b.inspect();
    let aScrolls = 0;
    let bScrolls = 0;
    a.dom.window.scrollBy = () => {
      aScrolls++;
    };
    b.dom.window.scrollBy = () => {
      bScrolls++;
    };
    const script = browserScrollScript("down", 100, prior.documentIdentity!);
    assert.throws(() => b.dom.window.eval(script), /document changed/);
    assert.equal(bScrolls, 0);
    a.dom.window.eval(script);
    assert.equal(aScrolls, 1);
    a.dom.window.history.pushState({}, "", "/changed-before-scroll-dispatch");
    assert.throws(() => a.dom.window.eval(script), /document changed/);
    assert.equal(aScrolls, 1);
  } finally {
    a.dom.window.close();
    b.dom.window.close();
  }
});
