import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { browserInspectScript } from "../src/main/capabilities/browser-provider.js";

// Reference the same expression with only object reuse removed. The native
// operations, their property reads and the rest of the inspection stay intact.
function uncachedExpression(): string {
  const start = browserInspectScript.indexOf(
    "  // Reuse only the live style object during this inspection, never its values.",
  );
  if (start < 0) return browserInspectScript;
  const end = browserInspectScript.indexOf("  const visible =", start);
  assert(end > start);
  return (
    browserInspectScript.slice(0, start) + browserInspectScript.slice(end)
  ).replaceAll("styleFor(element)", "getComputedStyle(element)");
}

const threeTargets =
  '<canvas id="canvas" tabindex="0"></canvas><input id="input" aria-label="Agent input"><button>Submit</button>';

function fixture(html: string, onText?: (window: JSDOM["window"]) => void) {
  const dom = new JSDOM(html, {
    runScripts: "outside-only",
    url: "https://fixture.example/owned",
  });
  const { window } = dom;
  const counts = { styles: 0, rects: 0, text: 0, pointerReads: 0 };
  let random = 0;
  Object.defineProperty(window.crypto, "getRandomValues", {
    value: (values: Uint32Array) => {
      for (let index = 0; index < values.length; index++)
        values[index] = ++random;
      return values;
    },
  });
  window.CSS = { escape: (value: string) => value } as typeof window.CSS;
  window.getComputedStyle = (element) => {
    counts.styles++;
    // Model a live CSSStyleDeclaration, not a snapshot of property values.
    // Native CSSOM behavior is also exercised by the ordinary headed CI smoke.
    const style = (element as HTMLElement).style;
    return {
      get visibility() {
        return style.visibility || "visible";
      },
      get display() {
        return style.display || "block";
      },
      get opacity() {
        return style.opacity || "1";
      },
      get pointerEvents() {
        counts.pointerReads++;
        return style.pointerEvents || "auto";
      },
    } as CSSStyleDeclaration;
  };
  window.HTMLElement.prototype.getBoundingClientRect = () => {
    counts.rects++;
    return {
      x: 1,
      y: 1,
      width: 100,
      height: 20,
      top: 1,
      left: 1,
      right: 101,
      bottom: 21,
      toJSON: () => ({}),
    };
  };
  Object.defineProperty(window.HTMLElement.prototype, "innerText", {
    get() {
      counts.text++;
      onText?.(window);
      // JSDOM has no rendered innerText. Do not substitute textContent in the
      // production expression: this fixture deliberately contains hidden text.
      return "Visible rendered text";
    },
  });
  const inspect = (expression = browserInspectScript) =>
    JSON.parse(JSON.stringify(window.eval(expression))) as {
      visibleText: string;
      targets: { id: string; actions: string[] }[];
      inputSnapshot: Record<string, unknown>;
    };
  return { dom, counts, inspect };
}

for (const [name, html] of [
  ["smoke controls", threeTargets],
  [
    "rendered visibility and disabled controls",
    '<button hidden>hidden secret</button><button style="display:none">display secret</button><button style="visibility:hidden">visibility secret</button><button style="opacity:0">opacity secret</button><button disabled>disabled</button><input readonly><input style="pointer-events:none"><textarea>note</textarea>',
  ],
  [
    "labels and bounded control state",
    '<label for="email">Email</label><input id="email" value="original"><input type="password" value="private"><input type="checkbox" checked><select><option value="a">A</option><option selected value="b">B</option></select><div contenteditable="true" aria-label="note">Text</div>',
  ],
  [
    "unsupported native and iframe surfaces",
    '<iframe></iframe><input type="file"><input type="color"><button aria-disabled="true">disabled</button>',
  ],
] as const) {
  test(`live style reuse preserves the full inspection: ${name}`, () => {
    const before = fixture(html);
    const after = fixture(html);
    try {
      assert.deepEqual(after.inspect(), before.inspect(uncachedExpression()));
      assert.equal(after.counts.rects, before.counts.rects);
      assert.equal(after.counts.text, 1);
      assert.equal(after.counts.pointerReads, before.counts.pointerReads);
    } finally {
      before.dom.window.close();
      after.dom.window.close();
    }
  });
}

test("three visible clickable controls reuse 3 live objects instead of obtaining 9", () => {
  const before = fixture(threeTargets);
  const after = fixture(threeTargets);
  try {
    assert.deepEqual(after.inspect(), before.inspect(uncachedExpression()));
    assert.deepEqual(before.counts, {
      styles: 9,
      rects: 3,
      text: 1,
      pointerReads: 6,
    });
    assert.deepEqual(after.counts, {
      styles: 3,
      rects: 3,
      text: 1,
      pointerReads: 6,
    });
  } finally {
    before.dom.window.close();
    after.dom.window.close();
  }
});

test("live properties are read again between target filtering and action projection", () => {
  const change = (window: JSDOM["window"]) => {
    for (const element of window.document.querySelectorAll<HTMLElement>(
      "canvas,input,button",
    ))
      element.style.pointerEvents = "none";
  };
  const before = fixture(threeTargets, change);
  const after = fixture(threeTargets, change);
  try {
    const result = after.inspect();
    assert.deepEqual(result, before.inspect(uncachedExpression()));
    assert.deepEqual(
      result.targets.map((target) => target.actions),
      [[], ["type"], []],
    );
    assert.equal(after.counts.pointerReads, 6);
    assert.equal(after.counts.styles, 3);
  } finally {
    before.dom.window.close();
    after.dom.window.close();
  }
});

test("a new inspection gets new live objects and rechecks changed visibility", () => {
  const { dom, counts, inspect } = fixture(threeTargets);
  try {
    assert.equal(inspect().targets.length, 3);
    assert.equal(counts.styles, 3);
    const canvas = dom.window.document.querySelector<HTMLElement>("canvas")!;
    canvas.style.display = "none";
    assert.equal(inspect().targets.length, 2);
    assert.equal(counts.styles, 6);
    canvas.style.display = "block";
    assert.equal(inspect().targets.length, 3);
    assert.equal(counts.styles, 9);
  } finally {
    dom.window.close();
  }
});

test("style and geometry exceptions still propagate without fallback or replay", () => {
  for (const kind of ["style", "geometry"] as const) {
    for (const expression of [uncachedExpression(), browserInspectScript]) {
      const { dom, inspect } = fixture(threeTargets);
      const failure = new Error(`${kind} fixture failure`);
      let calls = 0;
      const fail = () => {
        calls++;
        throw failure;
      };
      try {
        if (kind === "style") dom.window.getComputedStyle = fail;
        else dom.window.HTMLElement.prototype.getBoundingClientRect = fail;
        assert.throws(
          () => inspect(expression),
          (error) => error === failure,
        );
        assert.equal(calls, 1);
      } finally {
        dom.window.close();
      }
    }
  }
});

for (const surface of [
  "iframe",
  "file",
  "open-shadow",
  "closed-shadow",
] as const) {
  test(`input snapshot protection stays equivalent for focused ${surface}`, () => {
    const make = () => {
      const value = fixture(
        '<iframe id="frame"></iframe><input id="file" type="file"><div id="host" tabindex="0"></div><button>Submit</button>',
      );
      const { window } = value.dom;
      if (surface === "iframe" || surface === "file") {
        window.document
          .getElementById(surface === "iframe" ? "frame" : "file")!
          .focus();
      } else {
        const root = window.document.getElementById("host")!.attachShadow({
          mode: surface === "open-shadow" ? "open" : "closed",
        });
        root.innerHTML = '<input aria-label="shadow input">';
        root.querySelector("input")!.focus();
      }
      return value;
    };
    const before = make();
    const after = make();
    try {
      const result = after.inspect();
      assert.deepEqual(result, before.inspect(uncachedExpression()));
      if (surface === "iframe" || surface === "file")
        assert.equal(result.inputSnapshot.focusUnsupported, "native-surface");
      else if (surface === "closed-shadow")
        assert.equal(result.inputSnapshot.focusNeedsShadowEvidence, true);
      else assert.equal(typeof result.inputSnapshot.focusId, "string");
    } finally {
      before.dom.window.close();
      after.dom.window.close();
    }
  });
}
