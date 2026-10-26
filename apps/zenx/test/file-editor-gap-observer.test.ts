import assert from "node:assert/strict";
import test from "node:test";
import type { EditorView } from "@codemirror/view";
import { JSDOM } from "jsdom";
import { observeFileEditorGaps } from "../scripts/file-editor-gap-observer.js";

function fixture() {
  const dom = new JSDOM(
    '<div class="cm-editor"><div class="cm-scroller"><div class="cm-content"><div class="cm-gap" style="height: 40000px"></div><div class="cm-line">last line</div></div></div></div>',
    { pretendToBeVisual: true },
  );
  const document = dom.window.document;
  const editor = document.querySelector<HTMLElement>(".cm-editor")!;
  const scrollDOM = document.querySelector<HTMLElement>(".cm-scroller")!;
  const contentDOM = document.querySelector<HTMLElement>(".cm-content")!;
  scrollDOM.scrollTop = 984;
  const forbidden = () => {
    throw new Error("Observer must not dispatch, scroll, or flush CodeMirror");
  };
  const view = {
    dom: editor,
    scrollDOM,
    contentDOM,
    state: { selection: { main: { head: 54626 } }, doc: { length: 54626 } },
    viewport: { from: 52421, to: 54626 },
    contentHeight: 43155,
    dispatch: forbidden,
    coordsAtPos: forbidden,
    requestMeasure: forbidden,
  } as unknown as EditorView;
  return { dom, view, scrollDOM, contentDOM };
}

test("gap snapshots retain actual inline/computed height and DOM order without changing the editor", async () => {
  const { dom, view, scrollDOM, contentDOM } = fixture();
  const before = contentDOM.outerHTML;
  const receipts: any[] = [];
  const observer = observeFileEditorGaps(view, (receipt) =>
    receipts.push(receipt),
  );
  observer.record("default-scroll-request-geometry");
  assert.equal(receipts[0].geometry.contentHeight, 43155);
  assert.equal(receipts[0].geometry.scroll.scrollTop, 984);
  assert.equal(receipts[0].geometry.gaps[0].index, 0);
  assert.equal(receipts[0].geometry.gaps[0].computed.height, "40000px");
  assert.equal(receipts[0].geometry.gaps[0].next.className, "cm-line");
  assert.equal(contentDOM.outerHTML, before);
  assert.equal(scrollDOM.scrollTop, 984);
  await new Promise<void>((resolve) => dom.window.queueMicrotask(resolve));
  assert.equal(receipts.length, 1, "Reads themselves do not mutate the DOM");
  observer.destroy();
  dom.window.close();
});

test("observer captures actual scroll and height mutation receipts and cleans up", async () => {
  const { dom, view, scrollDOM, contentDOM } = fixture();
  const receipts: any[] = [];
  const observer = observeFileEditorGaps(view, (receipt) =>
    receipts.push(receipt),
  );
  scrollDOM.dispatchEvent(new dom.window.Event("scroll"));
  scrollDOM.dispatchEvent(new dom.window.Event("scrollend"));
  const gap = contentDOM.firstElementChild as HTMLElement;
  gap.style.height = "1000px";
  await new Promise<void>((resolve) => dom.window.queueMicrotask(resolve));
  assert.deepEqual(
    receipts.map((r) => r.kind),
    ["dom-scroll", "dom-scrollend", "content-mutation"],
  );
  assert.equal(receipts[2].geometry.gaps[0].computed.height, "1000px");
  assert.match(receipts[2].detail[0].oldValue, /40000px/);
  assert.deepEqual(
    receipts.map((r) => r.sequence),
    [1, 2, 3],
  );
  assert.equal(scrollDOM.scrollTop, 984);
  observer.afterScrollRequest();
  observer.destroy();
  gap.style.height = "2000px";
  scrollDOM.dispatchEvent(new dom.window.Event("scroll"));
  observer.record("after-destroy");
  await new Promise<void>((resolve) => dom.window.queueMicrotask(resolve));
  assert.equal(receipts.length, 3);
  dom.window.close();
});

test("post-request frame observations are bounded and do not request CodeMirror measurement", () => {
  const { dom, view } = fixture();
  let callback: FrameRequestCallback | undefined;
  dom.window.requestAnimationFrame = (next) => {
    callback = next;
    return 1;
  };
  dom.window.cancelAnimationFrame = () => {
    callback = undefined;
  };
  const receipts: any[] = [];
  const observer = observeFileEditorGaps(view, (receipt) =>
    receipts.push(receipt),
  );
  observer.afterScrollRequest();
  for (let i = 0; i < 12; i++) {
    const next = callback;
    assert.ok(next);
    callback = undefined;
    next(i * 16);
  }
  assert.equal(callback, undefined);
  assert.equal(receipts.length, 12);
  assert.ok(receipts.every((r) => r.kind === "after-scroll-request-frame"));
  observer.destroy();
  dom.window.close();
});
