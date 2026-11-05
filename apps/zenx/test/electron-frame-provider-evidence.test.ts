import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import {
  assertNativeFramePlacement,
  assertNativeInputRoute,
  type NativeChildRoute,
  type NativeInputAttempt,
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
