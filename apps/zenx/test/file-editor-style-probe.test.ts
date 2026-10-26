import assert from "node:assert/strict";
import test from "node:test";
import type { EditorView } from "@codemirror/view";
import { JSDOM } from "jsdom";
import {
  matchingFileEditorStyles,
  probeFileEditorStylesAfterFailure,
} from "../scripts/file-editor-style-probe.js";

function fixture() {
  const dom = new JSDOM(
    '<style>.cm-gap { min-height: 0; } .other { height: 3px }</style><div class="cm-editor"><div class="cm-scroller"><div class="cm-content"><div class="cm-gap" style="height: 40000px"></div><div class="cm-line">last line</div></div></div></div>',
    { pretendToBeVisual: true },
  );
  const document = dom.window.document;
  const editor = document.querySelector<HTMLElement>(".cm-editor")!;
  const scrollDOM = document.querySelector<HTMLElement>(".cm-scroller")!;
  const contentDOM = document.querySelector<HTMLElement>(".cm-content")!;
  scrollDOM.scrollTop = 984;
  const forbidden = () => {
    throw new Error("Probe must not write or measure CodeMirror");
  };
  const view = {
    dom: editor,
    scrollDOM,
    contentDOM,
    state: { selection: { main: { head: 54626 } } },
    viewport: { from: 13, to: 1633 },
    dispatch: forbidden,
    coordsAtPos: forbidden,
    requestMeasure: forbidden,
  } as unknown as EditorView;
  return { dom, view, editor, scrollDOM, contentDOM };
}

test("after-failure probe writes only independent isolated divs and removes them", async () => {
  const { dom, view, editor, scrollDOM, contentDOM } = fixture();
  const before = editor.outerHTML;
  const mutations: MutationRecord[] = [];
  const observer = new dom.window.MutationObserver((records) =>
    mutations.push(...records),
  );
  observer.observe(editor, {
    subtree: true,
    attributes: true,
    childList: true,
    characterData: true,
  });
  const receipt = await probeFileEditorStylesAfterFailure(view);
  await new Promise<void>((resolve) => dom.window.queueMicrotask(resolve));
  assert.equal(mutations.length, 0);
  assert.equal(editor.outerHTML, before);
  assert.equal(scrollDOM.scrollTop, 984);
  assert.equal(
    contentDOM.firstElementChild?.getAttribute("style"),
    "height: 40000px",
  );
  assert.equal(receipt.removed, true);
  assert.equal(
    dom.window.document.querySelector(
      "[data-synthetic-after-failure-style-probe]",
    ),
    null,
  );
  assert.equal(receipt.probes.length, 3);
  for (const probe of receipt.probes) {
    assert.equal(probe.initial.inlineHeight, "50px");
    assert.equal(probe.immediate.inlineHeight, "40000px");
    assert.equal(probe.afterFrame.height, "40000px");
    assert.equal(probe.fresh.height, "40000px");
    assert.ok(probe.nextFrame >= probe.initial.time);
  }
  assert.deepEqual(receipt.after, receipt.original.state);
  observer.disconnect();
  dom.window.close();
});

test("matching rules preserve selector and source without treating irrelevant selectors as applied", () => {
  const { dom, contentDOM } = fixture();
  const receipt = matchingFileEditorStyles([contentDOM.firstElementChild!]);
  assert.equal(receipt?.matches.length, 1);
  assert.equal(
    (receipt?.matches[0] as { selector: string }).selector,
    ".cm-gap",
  );
  assert.equal(receipt?.errors.length, 0);
  assert.equal(receipt?.truncated, false);
  dom.window.close();
});

test("a missing animation frame rejects the diagnostic and removes its isolated subtree", async () => {
  const { dom, view, editor } = fixture();
  const before = editor.outerHTML;
  dom.window.requestAnimationFrame = () => 1;
  await assert.rejects(
    probeFileEditorStylesAfterFailure(view, 1),
    /probe frame exceeded/,
  );
  assert.equal(editor.outerHTML, before);
  assert.equal(
    dom.window.document.querySelector(
      "[data-synthetic-after-failure-style-probe]",
    ),
    null,
  );
  dom.window.close();
});
