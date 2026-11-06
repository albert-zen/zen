import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import {
  nativeViewOverlapsOverlay,
  registerNativeViewOverlay,
  subscribeNativeViewOverlays,
} from "../src/renderer/src/native-view-overlays.js";

test("overlay geometry only hides overlapping views until the last layer closes", () => {
  const dom = new JSDOM("<body></body>");
  const rect = (x: number, y: number, width: number, height: number) =>
    new dom.window.DOMRect(x, y, width, height);
  const viewport = rect(500, 0, 500, 700);
  const one = dom.window.document.createElement("div");
  const two = dom.window.document.createElement("div");
  dom.window.document.body.append(one, two);
  one.getBoundingClientRect = () => rect(0, 0, 500, 700);
  two.getBoundingClientRect = () => rect(0, 0, 1000, 700);
  let notifications = 0;
  const stop = subscribeNativeViewOverlays(() => notifications++);
  const closeOne = registerNativeViewOverlay(one);
  assert.equal(
    nativeViewOverlapsOverlay(viewport),
    false,
    "touching edges are not overlapping",
  );
  one.getBoundingClientRect = () => rect(0, 0, 1000, 700);
  assert.equal(nativeViewOverlapsOverlay(viewport), true);
  const closeTwo = registerNativeViewOverlay(two);
  closeOne();
  assert.equal(nativeViewOverlapsOverlay(viewport), true);
  two.remove();
  assert.equal(
    nativeViewOverlapsOverlay(viewport),
    false,
    "disconnected overlays cannot keep the view hidden",
  );
  closeTwo();
  assert.equal(nativeViewOverlapsOverlay(viewport), false);
  assert.equal(notifications, 4);
  stop();
  dom.window.close();
});
