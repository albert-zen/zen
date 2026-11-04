import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import {
  browserFrameInputSnapshotScript,
  browserInputSnapshotScript,
  browserInputProbeScript,
  requireBrowserInputSnapshot,
} from "../src/main/capabilities/browser-targeted-input.js";

function fixture() {
  const dom = new JSDOM('<body><iframe id="frame"></iframe></body>', {
    runScripts: "outside-only",
    url: "https://same.test/",
  });
  const frame = dom.window.document.querySelector("iframe")!;
  const child = frame.contentDocument!;
  child.body.innerHTML = '<input id="input"><div id="hit">child</div>';
  dom.window.document.elementFromPoint = () => frame;
  child.elementFromPoint = () => child.getElementById("hit");
  Object.defineProperties(child.defaultView!, {
    innerWidth: { value: 200 },
    innerHeight: { value: 120 },
  });
  frame.getBoundingClientRect = () => ({
    x: 10,
    y: 20,
    width: 204,
    height: 124,
    left: 10,
    top: 20,
    right: 214,
    bottom: 144,
    toJSON() {},
  });
  frame.style.cssText = "width:200px;height:120px;border:2px solid";
  return { dom, frame, child };
}

test("local snapshots expose the exact iframe owner without walking its document", () => {
  const f = fixture();
  try {
    (f.child.getElementById("input") as HTMLElement).focus();
    const local = requireBrowserInputSnapshot(
      f.dom.window.eval(browserFrameInputSnapshotScript),
    );
    assert.equal(local.localFrame, true);
    assert.equal(local.focusFrameOwner, true);
    assert.equal(local.frameDocuments?.length, 0);
    const state = f.dom.window.eval(
      'globalThis[Symbol.for("zenx-browser-targeted-input-v2")]',
    ) as {
      documents: Map<Document, unknown>;
      focusNode: Element;
      hitNode: Element;
    };
    assert.equal(state.documents.size, 1);
    assert.ok(state.focusNode === f.frame);
    const hit = requireBrowserInputSnapshot(
      f.dom.window.eval(
        browserInputProbeScript({ kind: "click", x: 20, y: 30 }, true),
      ),
    );
    assert.equal(hit.pointerFrameOwner, true);
    assert.ok(state.hitNode === f.frame);
  } finally {
    f.dom.window.close();
  }
});

test("local document observers have disjoint identity and mutation counters", async () => {
  const f = fixture();
  try {
    const parentBefore = requireBrowserInputSnapshot(
      f.dom.window.eval(browserFrameInputSnapshotScript),
    );
    const childBefore = requireBrowserInputSnapshot(
      f.child.defaultView!.eval(browserFrameInputSnapshotScript),
    );
    assert.notEqual(parentBefore.documentKey, childBefore.documentKey);
    f.child.getElementById("hit")!.textContent = "changed";
    await Promise.resolve();
    const parentAfter = requireBrowserInputSnapshot(
      f.dom.window.eval(browserFrameInputSnapshotScript),
    );
    const childAfter = requireBrowserInputSnapshot(
      f.child.defaultView!.eval(browserFrameInputSnapshotScript),
    );
    assert.equal(parentAfter.layoutRevision, parentBefore.layoutRevision);
    assert.ok(childAfter.layoutRevision > childBefore.layoutRevision);
    assert.equal(childAfter.frameDocuments?.length, 0);
  } finally {
    f.dom.window.close();
  }
});

test("changing snapshot mode retires old observer identities rather than mixing counters", () => {
  const f = fixture();
  try {
    const recursive = requireBrowserInputSnapshot(
      f.dom.window.eval(browserInputSnapshotScript),
    );
    assert.equal(recursive.frameDocuments?.length, 1);
    const local = requireBrowserInputSnapshot(
      f.dom.window.eval(browserFrameInputSnapshotScript),
    );
    assert.notEqual(local.documentKey, recursive.documentKey);
    const same = requireBrowserInputSnapshot(
      f.dom.window.eval(browserFrameInputSnapshotScript),
    );
    assert.equal(same.documentKey, local.documentKey);
    const state = f.dom.window.eval(
      'globalThis[Symbol.for("zenx-browser-targeted-input-v2")]',
    ) as {
      documents: Map<Document, unknown>;
      focusNode: Element;
      hitNode: Element;
    };
    assert.equal(state.documents.size, 1);
  } finally {
    f.dom.window.close();
  }
});
