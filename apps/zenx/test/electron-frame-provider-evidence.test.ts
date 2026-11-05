import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import {
  assertNativeFramePlacement,
  assertNativeInputRoute,
  assertNativeFramePresentation,
  nativeFrameCommandReceipt,
  nativeViewOwnerIndices,
  type NativeChildRoute,
  type NativeInputAttempt,
  type NativeFramePresentation,
} from "./fixtures/electron-frame-provider-evidence.js";

const urls = [
  "http://127.0.0.1:3001/root",
  "http://localhost:3002/child",
  "http://localhost:3001/leaf",
];
const outer: NativeChildRoute = {
  sessionId: "outer-session",
  parentSessionId: "",
  targetId: "outer-target",
  url: urls[1]!,
};
const leaf: NativeChildRoute = {
  sessionId: "leaf-session",
  parentSessionId: outer.sessionId,
  targetId: "leaf-target",
  url: urls[2]!,
};
const frames = [
  { url: urls[0]!, processId: 10, osProcessId: 100, routingId: 1 },
  { url: urls[1]!, processId: 20, osProcessId: 200, routingId: 2 },
  { url: urls[2]!, processId: 20, osProcessId: 200, routingId: 3 },
];
function mouse(sessionId: string, x: number, y: number): NativeInputAttempt[] {
  return ["mousePressed", "mouseReleased"].map((type) => ({
    method: "Input.dispatchMouseEvent",
    type,
    sessionId,
    x,
    y,
  }));
}

test("native placement requires observed process identity and exact URL chain", () => {
  assertNativeFramePlacement(frames, "nested-same-process", urls);
  assert.throws(() => assertNativeFramePlacement(frames, "nested-oopif", urls));
  assertNativeFramePlacement(
    [
      frames[0]!,
      frames[1]!,
      { ...frames[2]!, processId: 30, osProcessId: 300 },
    ],
    "nested-oopif",
    urls,
  );
  assert.throws(() =>
    assertNativeFramePlacement(
      [{ ...frames[0]!, processId: 20 }, frames[1]!, frames[2]!],
      "nested-same-process",
      urls,
    ),
  );
  assert.throws(() =>
    assertNativeFramePlacement(frames, "nested-same-process", [
      ...urls.slice(0, 2),
      "http://foreign/leaf",
    ]),
  );
});

test("mixed native input remains in owning renderer coordinates and keys on root", () => {
  assertNativeInputRoute(
    mouse(outer.sessionId, 145, 85),
    [outer],
    "nested-same-process",
    urls,
    "click",
  );
  assert.throws(() =>
    assertNativeInputRoute(
      mouse("", 145, 85),
      [outer],
      "nested-same-process",
      urls,
      "click",
    ),
  );
  assert.throws(() =>
    assertNativeInputRoute(
      mouse(outer.sessionId, 100, 30),
      [outer],
      "nested-same-process",
      urls,
      "click",
    ),
  );
  assert.throws(() =>
    assertNativeInputRoute(
      mouse(outer.sessionId, 145, 85),
      [outer, leaf],
      "nested-same-process",
      urls,
      "click",
    ),
  );
  const keys = ["keyDown", "keyUp"].map((type) => ({
    method: "Input.dispatchKeyEvent",
    type,
    sessionId: "",
  }));
  assertNativeInputRoute(keys, [outer], "nested-same-process", urls, "key");
  assert.throws(() =>
    assertNativeInputRoute(
      keys.map((input) => ({ ...input, sessionId: outer.sessionId })),
      [outer],
      "nested-same-process",
      urls,
      "key",
    ),
  );
});

test("nested native input requires exact child session parentage, never an ancestor route", () => {
  assertNativeInputRoute(
    mouse(leaf.sessionId, 100, 30),
    [outer, leaf],
    "nested-oopif",
    urls,
    "click",
  );
  assert.throws(() =>
    assertNativeInputRoute(
      mouse(outer.sessionId, 100, 30),
      [outer, leaf],
      "nested-oopif",
      urls,
      "click",
    ),
  );
  assert.throws(() =>
    assertNativeInputRoute(
      mouse(leaf.sessionId, 100, 30),
      [outer, { ...leaf, parentSessionId: "" }],
      "nested-oopif",
      urls,
      "click",
    ),
  );
});

test("native harness is gated, build-only is supported, pure fixture never imports raw smoke", async () => {
  const script = await readFile(
    new URL("../scripts/smoke-electron-frame-providers.mjs", import.meta.url),
    "utf8",
  );
  assert.match(script, /--build-only/u);
  assert.ok(
    script.indexOf("process.env.GITHUB_ACTIONS,") <
      script.search(/spawn\(\s*electron/u),
  );
  const fixture = await readFile(
    new URL(
      "../src/main/browser-remote-frame-smoke-fixture.ts",
      import.meta.url,
    ),
    "utf8",
  );
  assert.doesNotMatch(
    fixture,
    /browser-parallel-input-smoke|child_process|\bmain\(/u,
  );
});

test("native command diagnostics retain exact bounded exception/world evidence without expressions or PNG data", () => {
  const detail = nativeFrameCommandReceipt(
    "Runtime.callFunctionOn",
    {
      objectId: "root-wrapper",
      functionDeclaration:
        "function() { const ownerEntry = state.documents.get(document); }",
    },
    {
      exceptionDetails: {
        text: "Uncaught",
        exception: {
          description:
            "Error: Browser iframe owner or document changed\n    at <anonymous>:5:12",
        },
      },
    },
  );
  assert.equal(detail?.label, "ancestor-chain");
  assert.deepEqual(detail?.exception, {
    text: "Uncaught",
    description:
      "Error: Browser iframe owner or document changed\n    at <anonymous>:5:12",
  });
  assert.equal(
    nativeFrameCommandReceipt(
      "Runtime.callFunctionOn",
      { functionDeclaration: "Browser iframe parent viewport" },
      {},
    )?.label,
    "owner-witness",
  );
  assert.equal(
    nativeFrameCommandReceipt(
      "Runtime.callFunctionOn",
      { functionDeclaration: "closed shadow candidate" },
      {},
    )?.label,
    "closed-shadow-registration",
  );
  assert.deepEqual(
    nativeFrameCommandReceipt(
      "DOM.resolveNode",
      { executionContextId: 7 },
      {
        object: {
          objectId: "isolated-wrapper",
          description: "iframe#contract-frame",
        },
      },
    ),
    {
      method: "DOM.resolveNode",
      label: "DOM.resolveNode",
      executionContextId: 7,
      resolvedObjectId: "isolated-wrapper",
      nodeDescription: "iframe#contract-frame",
    },
  );
  assert.equal(
    nativeFrameCommandReceipt(
      "Page.captureScreenshot",
      {},
      { data: "must-not-retain-png" },
    ),
    undefined,
  );
  const bounded = nativeFrameCommandReceipt(
    "Runtime.evaluate",
    {
      expression: "must-not-retain-expression",
      uniqueContextId: "unique-root",
    },
    {
      exceptionDetails: {
        text: "Uncaught",
        exception: { description: "x".repeat(10000) },
      },
    },
  );
  assert.ok(JSON.stringify(bounded).length < 2400);
  assert.ok(!JSON.stringify(bounded).includes("must-not-retain-expression"));
});

test("native Workspace presentation proves invisible unmounted state and nonactivating offscreen lease", () => {
  const idle: NativeFramePresentation = {
    provider: "workspace-browser",
    webContentsId: 2,
    viewWebContentsId: 2,
    sentinelWindowId: 1,
    focusedWindowId: 1,
    backgroundThrottling: false,
    viewVisible: false,
    displays: [{ x: 0, y: 0, width: 1440, height: 900 }],
    owners: [],
  };
  assertNativeFramePresentation(idle, "idle");
  assert.throws(() =>
    assertNativeFramePresentation({ ...idle, viewVisible: true }, "idle"),
  );
  assert.throws(() =>
    assertNativeFramePresentation({ ...idle, viewWebContentsId: 3 }, "idle"),
  );
  const dispatch: NativeFramePresentation = {
    ...idle,
    viewVisible: true,
    owners: [
      {
        id: 3,
        ownsTargetContents: false,
        visible: true,
        focused: false,
        focusable: false,
        opacity: 0,
        bounds: { x: -10000, y: -10000, width: 1280, height: 800 },
      },
    ],
  };
  assertNativeFramePresentation(dispatch, "dispatch");
  assert.throws(() => assertNativeFramePresentation(dispatch, "idle"));
  for (const patch of [
    { focused: true },
    { focusable: true },
    { opacity: 1 },
    { ownsTargetContents: true },
    { bounds: { x: 0, y: 0, width: 1280, height: 800 } },
  ])
    assert.throws(() =>
      assertNativeFramePresentation(
        { ...dispatch, owners: [{ ...dispatch.owners[0]!, ...patch }] },
        "dispatch",
      ),
    );
  assert.throws(() =>
    assertNativeFramePresentation(
      { ...dispatch, owners: [...dispatch.owners, dispatch.owners[0]!] },
      "dispatch",
    ),
  );
  assert.throws(() =>
    assertNativeFramePresentation(
      { ...dispatch, focusedWindowId: 3 },
      "dispatch",
    ),
  );
});

test("native Electron target must stay the exact hidden nonfocusable window despite Page Visibility", () => {
  const value: NativeFramePresentation = {
    provider: "electron-browser",
    webContentsId: 2,
    sentinelWindowId: 1,
    focusedWindowId: 1,
    backgroundThrottling: false,
    displays: [{ x: 0, y: 0, width: 1440, height: 900 }],
    owners: [
      {
        id: 2,
        ownsTargetContents: true,
        visible: false,
        focused: false,
        focusable: false,
        opacity: 1,
        bounds: { x: 0, y: 0, width: 1100, height: 760 },
      },
    ],
  };
  for (const phase of ["idle", "dispatch"] as const) {
    assertNativeFramePresentation(value, phase);
    for (const patch of [
      { visible: true },
      { focused: true },
      { focusable: true },
      { ownsTargetContents: false },
    ])
      assert.throws(() =>
        assertNativeFramePresentation(
          { ...value, owners: [{ ...value.owners[0]!, ...patch }] },
          phase,
        ),
      );
  }
});

test("native view ownership includes nested foreign parents and refuses incomplete trees", () => {
  interface View {
    children: View[];
  }
  const target: View = { children: [] };
  const unrelated: View = { children: [] };
  const foreign: View = { children: [{ children: [target] }] };
  assert.deepEqual(nativeViewOwnerIndices([unrelated], target), []);
  assert.deepEqual(nativeViewOwnerIndices([unrelated, foreign], target), [1]);
  const presentation: NativeFramePresentation = {
    provider: "workspace-browser",
    webContentsId: 2,
    viewWebContentsId: 2,
    sentinelWindowId: 1,
    focusedWindowId: 1,
    backgroundThrottling: false,
    viewVisible: false,
    displays: [{ x: 0, y: 0, width: 1440, height: 900 }],
    owners: nativeViewOwnerIndices([unrelated, foreign], target).map(
      (index) => ({
        id: index + 3,
        ownsTargetContents: false,
        visible: true,
        focused: false,
        focusable: true,
        opacity: 1,
        bounds: { x: 0, y: 0, width: 1100, height: 760 },
      }),
    ),
  };
  assert.throws(() => assertNativeFramePresentation(presentation, "idle"));
  assert.throws(
    () => nativeViewOwnerIndices([foreign, { children: [target] }], target),
    /cycle or duplicate/,
  );
  const cycle: View = { children: [] };
  cycle.children.push(cycle);
  assert.throws(
    () => nativeViewOwnerIndices([cycle], target),
    /cycle or duplicate/,
  );
  assert.throws(
    () =>
      nativeViewOwnerIndices(
        Array.from({ length: 17 }, () => ({ children: [] })),
        target,
      ),
    /window tree count/,
  );
  assert.throws(
    () =>
      nativeViewOwnerIndices(
        [{ children: Array.from({ length: 128 }, () => ({ children: [] })) }],
        target,
      ),
    /tree size/,
  );
  assert.throws(
    () =>
      nativeViewOwnerIndices(
        [{ children: Array.from({ length: 129 }, () => ({ children: [] })) }],
        target,
      ),
    /child count/,
  );
  let deep: View = { children: [] };
  for (let index = 0; index < 17; index++) deep = { children: [deep] };
  assert.throws(() => nativeViewOwnerIndices([deep], target), /tree depth/);
});
