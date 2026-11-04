import assert from "node:assert/strict";
import test from "node:test";
import { BrowserFrameEvidence } from "../src/main/capabilities/browser-frame-evidence.js";

const attach = (sessionId: string, targetId = `target-${sessionId}`) => ({
  sessionId,
  targetInfo: { type: "iframe", targetId },
  waitingForDebugger: false,
});
const context = (
  id: number,
  frameId: string,
  uniqueId = `unique-${id}`,
  isDefault = false,
) => ({
  context: {
    id,
    uniqueId,
    name: isDefault ? "" : "observation",
    auxData: { frameId, isDefault },
  },
});
const tree = (id = "main", loaderId = "loader-main") => ({
  frameTree: { frame: { id, loaderId, url: `https://${id}.test/` } },
});

test("only a known parent route can admit a bounded iframe child", () => {
  const evidence = new BrowserFrameEvidence("root");
  assert.equal(
    evidence.acceptEvent(
      "foreign",
      "Target.attachedToTarget",
      attach("foreign-child"),
    ),
    false,
  );
  assert.equal(evidence.hasSession("foreign-child"), false);
  const before = evidence.capture();
  assert.equal(
    evidence.acceptEvent("root", "Target.attachedToTarget", attach("child")),
    true,
  );
  assert.equal(evidence.parentSession("child"), "root");
  assert.throws(() => evidence.assertCapture(before), /changed/);
  evidence.acceptEvent(
    "child",
    "Target.attachedToTarget",
    attach("grandchild"),
  );
  assert.equal(evidence.parentSession("grandchild"), "child");
  assert.equal(evidence.hasSession("root"), true);
});

test("child retirement removes only its subtree and rejects reused session identity", () => {
  const evidence = new BrowserFrameEvidence("root");
  evidence.acceptEvent("root", "Target.attachedToTarget", attach("child"));
  evidence.acceptEvent(
    "child",
    "Target.attachedToTarget",
    attach("grandchild"),
  );
  evidence.acceptEvent("root", "Target.attachedToTarget", attach("sibling"));
  assert.equal(
    evidence.acceptEvent("sibling", "Target.detachedFromTarget", {
      sessionId: "child",
    }),
    false,
  );
  assert.equal(evidence.hasSession("child"), true);
  evidence.acceptEvent("root", "Target.detachedFromTarget", {
    sessionId: "child",
  });
  assert.equal(evidence.hasSession("child"), false);
  assert.equal(evidence.hasSession("grandchild"), false);
  assert.equal(evidence.ownsSession("grandchild"), true);
  assert.equal(evidence.hasSession("root"), true);
  assert.equal(evidence.hasSession("sibling"), true);
  evidence.acceptEvent("root", "Target.attachedToTarget", attach("child"));
  assert.throws(() => evidence.capture(), /changed identity/);
});

test("equal numeric context IDs in separate renderers never alias", () => {
  const evidence = new BrowserFrameEvidence("root");
  evidence.acceptEvent("root", "Target.attachedToTarget", attach("child"));
  evidence.acceptEvent(
    "root",
    "Runtime.executionContextCreated",
    context(7, "main", "root-7"),
  );
  evidence.acceptEvent(
    "child",
    "Runtime.executionContextCreated",
    context(7, "frame", "child-7"),
  );
  const root = evidence.context("root", "main", 7)!;
  const child = evidence.context("child", "frame", 7)!;
  assert.equal(root.uniqueId, "root-7");
  assert.equal(child.uniqueId, "child-7");
  assert.equal(evidence.context("child", "main", 7), undefined);
  evidence.acceptEvent("child", "Runtime.executionContextDestroyed", {
    executionContextUniqueId: "child-7",
  });
  assert.throws(() => evidence.assertContext(child), /context changed/);
  evidence.assertContext(root);
  evidence.acceptEvent(
    "child",
    "Runtime.executionContextCreated",
    context(7, "frame", "replacement-7"),
  );
  assert.throws(() => evidence.assertContext(child), /context changed/);
});

test("observation world preparation does not invalidate a capture, but context replacement does", () => {
  const evidence = new BrowserFrameEvidence("root");
  const fence = evidence.capture();
  evidence.acceptEvent(
    "root",
    "Runtime.executionContextCreated",
    context(12, "main"),
  );
  evidence.assertCapture(fence);
  evidence.acceptEvent(
    "root",
    "Runtime.executionContextCreated",
    context(12, "main", "new-12"),
  );
  assert.throws(() => evidence.assertCapture(fence), /changed/);
});

test("same-process cross-origin frames remain frame/context evidence in one session", () => {
  const evidence = new BrowserFrameEvidence("root");
  const response = tree();
  Object.assign(response.frameTree, {
    childFrames: [
      {
        frame: {
          id: "foreign",
          parentId: "main",
          loaderId: "child-loader",
          url: "https://foreign.test/",
        },
      },
    ],
  });
  evidence.recordFrameTree("root", response, evidence.capture());
  evidence.acceptEvent(
    "root",
    "Runtime.executionContextCreated",
    context(13, "foreign"),
  );
  assert.equal(evidence.document("root", "foreign")?.parentFrameId, "main");
  assert.equal(evidence.context("root", "foreign", 13)?.sessionId, "root");
  assert.equal(evidence.hasSession("foreign"), false);
});

test("frame tree reads reject a lifecycle change before publication", () => {
  const evidence = new BrowserFrameEvidence("root");
  const fence = evidence.capture();
  evidence.acceptEvent("root", "Page.frameStartedNavigating", {
    frameId: "main",
  });
  assert.throws(
    () => evidence.recordFrameTree("root", tree(), fence),
    /changed/,
  );
  assert.equal(evidence.document("root", "main"), undefined);
});

test("frame trees validate their parent chain without trusting targetId equals frameId", () => {
  const evidence = new BrowserFrameEvidence("root");
  evidence.acceptEvent(
    "root",
    "Target.attachedToTarget",
    attach("child", "different-target-id"),
  );
  evidence.recordFrameTree("child", tree("frame"), evidence.capture());
  assert.equal(evidence.document("child", "frame")?.frameId, "frame");
  const malformed = tree();
  Object.assign(malformed.frameTree, {
    childFrames: [
      {
        frame: {
          id: "child",
          parentId: "other-parent",
          loaderId: "loader",
          url: "https://child.test/",
        },
      },
    ],
  });
  assert.throws(
    () => evidence.recordFrameTree("root", malformed, evidence.capture()),
    /identity/,
  );
});

test("all child navigation/context replacement evidence retires the capture", () => {
  for (const [method, params] of [
    ["Page.frameAttached", { frameId: "new", parentFrameId: "child-frame" }],
    ["Page.frameDetached", { frameId: "child-frame", reason: "swap" }],
    ["Page.frameStartedNavigating", { frameId: "child-frame" }],
    ["Page.frameStartedLoading", { frameId: "child-frame" }],
    ["Page.navigatedWithinDocument", { frameId: "child-frame" }],
    ["Page.documentOpened", { frame: tree("child-frame").frameTree.frame }],
    ["Page.frameNavigated", { frame: tree("child-frame").frameTree.frame }],
    ["Runtime.executionContextDestroyed", { executionContextId: 2 }],
    ["Runtime.executionContextsCleared", {}],
    [
      "Runtime.executionContextCreated",
      context(2, "child-frame", "default-context", true),
    ],
  ] as const) {
    const evidence = new BrowserFrameEvidence("root");
    evidence.acceptEvent("root", "Target.attachedToTarget", attach("child"));
    const fence = evidence.capture();
    evidence.acceptEvent("child", method, params);
    assert.throws(() => evidence.assertCapture(fence), /changed/, method);
  }
});

test("unsupported target types and paused attachments do not become frame routes", () => {
  for (const invalid of [
    { ...attach("child"), targetInfo: { targetId: "worker", type: "worker" } },
    { ...attach("child"), waitingForDebugger: true },
  ]) {
    const evidence = new BrowserFrameEvidence("root");
    evidence.acceptEvent("root", "Target.attachedToTarget", invalid);
    assert.equal(evidence.hasSession("child"), false);
    assert.throws(() => evidence.capture(), /unavailable/);
  }
});

test("session count and depth are bounded without truncating authorizing evidence", () => {
  const wide = new BrowserFrameEvidence("root");
  for (let i = 0; i < 64; i++)
    wide.acceptEvent("root", "Target.attachedToTarget", attach(`child-${i}`));
  wide.capture();
  wide.acceptEvent("root", "Target.attachedToTarget", attach("overflow"));
  assert.equal(wide.hasSession("overflow"), false);
  assert.throws(() => wide.capture(), /bound/);
  const deep = new BrowserFrameEvidence("root");
  let parent = "root";
  for (let i = 0; i < 8; i++) {
    const child = `child-${i}`;
    deep.acceptEvent(parent, "Target.attachedToTarget", attach(child));
    parent = child;
  }
  deep.capture();
  deep.acceptEvent(parent, "Target.attachedToTarget", attach("overflow"));
  assert.throws(() => deep.capture(), /bound/);
});

test("root replacement cannot reuse another root's capture fence", () => {
  const first = new BrowserFrameEvidence("same-native-id");
  const fence = first.capture();
  first.close();
  assert.throws(() => first.assertCapture(fence), /retired/);
  const next = new BrowserFrameEvidence("same-native-id");
  assert.throws(() => next.assertCapture(fence), /changed/);
  assert.equal(
    first.acceptEvent(
      "same-native-id",
      "Target.attachedToTarget",
      attach("late"),
    ),
    false,
  );
});

test("a native frame tree cannot reuse a frame identity in siblings or descendants", () => {
  for (const duplicate of ["main", "child"]) {
    const evidence = new BrowserFrameEvidence("root");
    const response = tree();
    Object.assign(response.frameTree, {
      childFrames: [
        {
          frame: {
            id: "child",
            parentId: "main",
            loaderId: "one",
            url: "https://child.test/",
          },
        },
        {
          frame: {
            id: duplicate,
            parentId: "main",
            loaderId: "two",
            url: "https://other.test/",
          },
        },
      ],
    });
    assert.throws(
      () => evidence.recordFrameTree("root", response, evidence.capture()),
      /identity/,
    );
    assert.equal(evidence.document("root", "main"), undefined);
  }
});

test("dialogs are exact-route evidence and another route cannot clear them", () => {
  const evidence = new BrowserFrameEvidence("root");
  evidence.acceptEvent("root", "Target.attachedToTarget", attach("child"));
  evidence.acceptEvent("child", "Page.javascriptDialogOpening", {});
  assert.equal(evidence.hasOpenDialog, true);
  evidence.acceptEvent("root", "Page.javascriptDialogClosed", {});
  assert.equal(evidence.hasOpenDialog, true);
  evidence.acceptEvent("foreign", "Page.javascriptDialogClosed", {});
  assert.equal(evidence.hasOpenDialog, true);
  evidence.acceptEvent("child", "Page.javascriptDialogClosed", {});
  assert.equal(evidence.hasOpenDialog, false);
});
