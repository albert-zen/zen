import assert from "node:assert/strict";
import test from "node:test";

import { revealTabScroll } from "../src/renderer/src/workspace-tab-scroll.js";

const tabs = [
  { start: 0, end: 120 },
  { start: 124, end: 244 },
  { start: 248, end: 368 },
  { start: 372, end: 560 },
  { start: 564, end: 732 },
];

test("an active tab already in view does not scroll the rail", () => {
  assert.equal(
    revealTabScroll({
      tabs,
      active: 1,
      clientWidth: 400,
      scrollLeft: 0,
      scrollWidth: 732,
    }),
    0,
  );
});

test("every tab visible keeps the rail at its origin", () => {
  assert.equal(
    revealTabScroll({
      tabs,
      active: 4,
      clientWidth: 800,
      scrollLeft: 240,
      scrollWidth: 732,
    }),
    0,
  );
});

test("a partially visible tab is kept whole when the active tab still fits", () => {
  // Right-aligning tab 3 would cut tab 2 at 260 and hide its icon. Moving the
  // leading edge to tab 2's end hides it entirely and keeps tab 3 in view.
  assert.equal(
    revealTabScroll({
      tabs,
      active: 3,
      clientWidth: 300,
      scrollLeft: 0,
      scrollWidth: 732,
    }),
    368,
  );
});

test("revealing the last tab stops at the end of the rail", () => {
  // The final scroll position is the end of the content, so one leading tab
  // stays clipped there; the rail mask communicates that instead of an icon.
  const end = 732 - 400;
  assert.equal(
    revealTabScroll({
      tabs,
      active: 4,
      clientWidth: 400,
      scrollLeft: 0,
      scrollWidth: 732,
    }),
    end,
  );
});

test("a tab wider than the viewport aligns to its own start", () => {
  const wide = [
    { start: 0, end: 210 },
    { start: 214, end: 424 },
  ];
  assert.equal(
    revealTabScroll({
      tabs: wide,
      active: 1,
      clientWidth: 200,
      scrollLeft: 0,
      scrollWidth: 424,
    }),
    214,
  );
});

test("the result stays inside the scrollable range", () => {
  const position = revealTabScroll({
    tabs,
    active: 4,
    clientWidth: 400,
    scrollLeft: 10_000,
    scrollWidth: 732,
  });
  assert.equal(position, 332);
  assert.ok(position >= 0 && position <= 332);
});

test("a whole tab at the leading edge does not cause extra scrolling", () => {
  const separated = [
    { start: 0, end: 100 },
    { start: 350, end: 450 },
  ];
  assert.equal(
    revealTabScroll({
      tabs: separated,
      active: 1,
      clientWidth: 200,
      scrollLeft: 0,
      scrollWidth: 500,
    }),
    250,
  );
});
