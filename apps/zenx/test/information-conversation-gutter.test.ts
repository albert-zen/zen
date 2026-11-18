import assert from "node:assert/strict";
import test from "node:test";
import { informationConversationGutter } from "../src/renderer/src/information-conversation-gutter.js";

test("native 920 dock preserves the actual 480 editor floor on both OSes", () => {
  for (const [clientWidth, expected] of [
    [545, 23.5],
    [546, 24],
  ] as const) {
    const gutter = informationConversationGutter(clientWidth, true)!;
    assert.equal(gutter, expected);
    assert.equal(clientWidth - gutter * 2 - 18, 480);
  }
});
test("wide and overlay-scrollbar docks retain existing 24px rails", () => {
  for (const width of [547, 556, 726, 806, 1200])
    assert.equal(informationConversationGutter(width, true), 24);
});
test("overlay, closed dock, mobile and undocked fullscreen leave CSS untouched", () => {
  for (const width of [319, 545, 546, 919, 1200])
    assert.equal(informationConversationGutter(width, false), null);
});
test("fractional and larger native gutters retain a symmetric usable rail", () => {
  for (const width of [530, 535, 540, 544.5, 545.25]) {
    const gutter = informationConversationGutter(width, true)!;
    assert.equal(width - gutter * 2 - 18, 480);
    assert.ok(gutter >= 16 && gutter <= 24);
  }
  assert.equal(informationConversationGutter(500, true), 16);
});
test("missing or invalid measurements do not pin an inline gutter", () => {
  for (const width of [0, -1, NaN, Infinity])
    assert.equal(informationConversationGutter(width, true), null);
});
