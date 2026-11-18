import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { InformationOverflowCue } from "../src/renderer/src/InformationOverflowCue.js";

test("split overlay cue follows actual remaining overflow without moving focus or scroll", async () => {
  const dom = new JSDOM(
    "<button id=composer>Composer</button><div id=root></div>",
  );
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    HTMLElement: globalThis.HTMLElement,
    MutationObserver: globalThis.MutationObserver,
    ResizeObserver: globalThis.ResizeObserver,
  };
  const metrics = { height: 676, total: 1760, top: 0 };
  const resizeObservers: FakeResizeObserver[] = [];
  class FakeResizeObserver {
    targets = new Set<Element>();
    constructor(readonly callback: () => void) {
      resizeObservers.push(this);
    }
    observe(target: Element) {
      this.targets.add(target);
    }
    disconnect() {
      this.targets.clear();
    }
  }
  for (const [property, read] of Object.entries({
    clientHeight: () => metrics.height,
    scrollHeight: () => metrics.total,
    scrollTop: () => metrics.top,
  }))
    Object.defineProperty(dom.window.HTMLElement.prototype, property, {
      configurable: true,
      get: read,
      set() {
        throw new Error(`Cue must not write ${property}`);
      },
    });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    MutationObserver: dom.window.MutationObserver,
    ResizeObserver: FakeResizeObserver,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const root = createRoot(document.getElementById("root")!);
  let decisions = 0;
  const render = (label = "More below", split = true) => (
    <div className="information-popover">
      <div className="information-dismiss-toolbar">
        {split && <InformationOverflowCue label={label} />}
        <button id="close">Close information</button>
      </div>
      <div className="information-content">
        <div id="questions">
          <button onClick={() => decisions++}>Send answers</button>
        </div>
      </div>
    </div>
  );
  const cue = () =>
    document.querySelector<HTMLElement>(".information-overflow-cue")!;
  const scroll = () =>
    act(async () => {
      document
        .querySelector(".information-content")!
        .dispatchEvent(new dom.window.Event("scroll"));
    });
  const resize = () =>
    act(async () => {
      for (const observer of resizeObservers) observer.callback();
    });
  try {
    document.getElementById("composer")!.focus();
    await act(async () => root.render(render()));
    assert.equal(
      cue().hidden,
      false,
      "initial real overflow is discoverable before any wheel input",
    );
    assert.equal(cue().getAttribute("aria-hidden"), "true");
    assert.equal(cue().tabIndex, -1);
    assert.equal(cue().querySelector("button,a,input,[tabindex]"), null);
    assert.equal(document.activeElement?.id, "composer");
    assert.equal(metrics.top, 0);
    assert.deepEqual(
      [...resizeObservers[0]!.targets].map((e) => e.id || e.className),
      ["information-content", "questions"],
    );

    metrics.top = 360;
    await scroll();
    assert.equal(
      cue().hidden,
      false,
      "more remains after a native wheel-sized change",
    );
    metrics.top = 1084;
    await scroll();
    assert.equal(cue().hidden, true, "end of scroll hides the cue");
    metrics.top = 1083.5;
    await scroll();
    assert.equal(
      cue().hidden,
      true,
      "fractional rounding does not flicker at the end",
    );
    metrics.top = 0;
    metrics.total = 676;
    await resize();
    assert.equal(cue().hidden, true, "fitting content never claims more below");
    metrics.total = 900;
    await resize();
    assert.equal(
      cue().hidden,
      false,
      "provider/content growth is observed without a parent rerender",
    );
    metrics.height = 950;
    await resize();
    assert.equal(cue().hidden, true, "a larger viewport clears the cue");
    metrics.height = 0;
    await resize();
    assert.equal(
      cue().hidden,
      true,
      "a hidden or unlaid-out scroller is not overflow evidence",
    );
    metrics.height = 676;
    metrics.total = 1100;
    await act(async () => {
      const content = document.querySelector(".information-content")!;
      const next = document.createElement("section");
      next.id = "replacement-provider";
      content.replaceChildren(next);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(cue().hidden, false);
    assert.deepEqual(
      [...resizeObservers[0]!.targets].map((e) => e.id || e.className),
      ["information-content", "replacement-provider"],
    );
    await act(async () => root.render(render("下方还有内容")));
    assert.match(cue().textContent ?? "", /下方还有内容/u);
    assert.equal(document.activeElement?.id, "composer");
    assert.equal(decisions, 0, "the cue cannot submit or cancel a question");

    await act(async () => root.render(render("More below", false)));
    assert.equal(document.querySelector(".information-overflow-cue"), null);
    assert.equal(
      resizeObservers[0]!.targets.size,
      0,
      "unmount removes observers",
    );
    await scroll();
    await act(async () => root.render(render()));
    assert.equal(
      cue().hidden,
      false,
      "reopening measures afresh without retained cue state",
    );
  } finally {
    await act(async () => root.unmount());
    Object.assign(globalThis, previous, {
      IS_REACT_ACT_ENVIRONMENT: undefined,
    });
    dom.window.close();
  }
});

test("integration stays split-overlay-only and preserves native input and scrollbar policy", () => {
  const host = readFileSync(
    new URL("../src/renderer/src/plugin-information-host.tsx", import.meta.url),
    "utf8",
  );
  const cue = readFileSync(
    new URL("../src/renderer/src/InformationOverflowCue.tsx", import.meta.url),
    "utf8",
  );
  const css = readFileSync(
    new URL("../src/renderer/src/styles.css", import.meta.url),
    "utf8",
  );
  const translations = readFileSync(
    new URL("../src/renderer/src/i18n/panels.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    host,
    /layout\.right > 12 && \(\s*<InformationOverflowCue label=\{t\("informationMoreBelow"\)\}/u,
  );
  assert.doesNotMatch(
    cue,
    /\b(?:onClick|onWheel|onKeyDown|preventDefault|stopPropagation|scrollIntoView|tabIndex|aria-live)\b|\.focus\(/u,
  );
  assert.match(
    cue,
    /addEventListener\("scroll", measure, \{ passive: true \}\)/u,
  );
  assert.match(cue, /removeEventListener\("scroll", measure\)/u);
  assert.match(
    css,
    /\.information-overflow-cue\s*\{[^}]*pointer-events: none;/u,
  );
  assert.match(
    css,
    /\.information-overflow-cue\[hidden\]\s*\{\s*display: none;/u,
  );
  assert.match(
    css,
    /@media \(forced-colors: active\)[\s\S]*scrollbar-color: auto;/u,
  );
  assert.match(translations, /informationMoreBelow: "More below"/u);
  assert.match(translations, /informationMoreBelow: "下方还有内容"/u);
});
