import assert from "node:assert/strict";
import test from "node:test";
import type { EditorView } from "@codemirror/view";
import {
  WorkspaceFileDrafts,
  fileDraftKey,
} from "../src/renderer/src/workspace-file-drafts.js";
function fixture(text: string, top = 0, left = 0) {
  const target = new EventTarget();
  const scrollDOM = Object.assign(target, {
    scrollTop: top,
    scrollLeft: left,
    scrollHeight: 2000,
    clientHeight: 200,
    scrollWidth: 1200,
    clientWidth: 200,
  });
  const snapshot = {};
  let measure: any;
  const view = {
    state: { doc: { toString: () => text } },
    scrollDOM,
    scrollSnapshot: () => snapshot,
    requestMeasure: (request: any) => {
      measure = request;
    },
  } as unknown as EditorView;
  return {
    view,
    scrollDOM,
    snapshot,
    measure: () => measure.write(measure.read()),
  };
}
test("reading positions are owner/path isolated, captured on unmount, and discarded on explicit close", () => {
  const drafts = new WorkspaceFileDrafts();
  const a = fileDraftKey("A", "README.md"),
    b = fileDraftKey("B", "README.md");
  const position = drafts.viewport(a),
    f = fixture("text", 400, 200);
  position.bind(f.view)();
  assert.equal(drafts.viewport(a).initial("text"), f.snapshot);
  assert.equal(drafts.viewport(b).initial("text"), undefined);
  assert.equal(position.initial("changed"), undefined);
  drafts.remove(a);
  assert.equal(drafts.viewport(a).initial("text"), undefined);
  assert.notEqual(drafts.viewport(a), position);
});
test("changed/shorter file offsets are clamped; a retired editor cannot restore or save into another owner", () => {
  const drafts = new WorkspaceFileDrafts();
  const a = drafts.viewport(fileDraftKey("A", "file.ts"));
  const old = fixture("long", 900, 700);
  a.bind(old.view)();
  const short = fixture("short");
  short.scrollDOM.scrollHeight = 250;
  short.scrollDOM.scrollWidth = 220;
  const release = a.bind(short.view);
  short.measure();
  assert.equal(short.scrollDOM.scrollTop, 50);
  assert.equal(short.scrollDOM.scrollLeft, 20);
  release();
  const retired = fixture("changed");
  const stop = a.bind(retired.view);
  stop();
  retired.scrollDOM.scrollTop = 17;
  retired.measure();
  assert.equal(retired.scrollDOM.scrollTop, 17);
  retired.scrollDOM.dispatchEvent(new Event("scroll"));
  assert.equal(a.initial("short"), undefined);
  assert.equal(
    drafts.viewport(fileDraftKey("B", "file.ts")).initial("changed"),
    undefined,
  );
});
