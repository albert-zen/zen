import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
const css = readFileSync(
  new URL("../src/renderer/src/styles.css", import.meta.url),
  "utf8",
);
const candidate = css.slice(
  css.indexOf("/* Preserve factual question attention"),
);

test("attention action allocation uses the menu width from the same row scope", () => {
  assert.match(
    css,
    /\.thread-row-shell\s*\{\s*--thread-state-space: 0px;\s*--thread-shortcut-space: 0px;\s*--thread-menu-action-width: 28px;/u,
  );
  assert.match(
    css,
    /\.thread-row-shell:is\(:hover, :focus-within, \[data-menu-open="true"\]\)\s*\.thread-status-rail\s*\.thread-menu-trigger\s*\{\s*width: var\(--thread-menu-action-width\);/u,
  );
  assert.match(
    candidate,
    /padding-inline-end: calc\(\s*10px \+ var\(--thread-state-space, 0px\) \+ var\(--thread-shortcut-space\) \+\s*var\(--thread-menu-action-width\)/u,
  );
  assert.equal((css.match(/--thread-menu-action-width: /gu) ?? []).length, 1);
});

test("only desktop interacting question rows lose the unnecessary covering fade", () => {
  assert.match(
    candidate,
    /@media \(min-width: 961px\) and \(hover: hover\) and \(pointer: fine\)/u,
  );
  const guarded =
    /\.thread-row-shell:has\(> \.thread-row \.thread-asking-badge\):is\(\s*:hover,\s*:focus-within,\s*\[data-menu-open="true"\]\s*\)/gu;
  assert.equal([...candidate.matchAll(guarded)].length, 3);
  assert.match(
    candidate,
    /> \.thread-status-rail\s*\{\s*padding-inline-start: 0;\s*background: transparent;/u,
  );
  assert.doesNotMatch(
    candidate,
    /z-index|font-size|opacity|visibility|display|pointer-events|overflow|transform/u,
  );
  // The default overlay and touch hit targets remain; no global fade removal.
  assert.match(
    css,
    /padding-inline-start: 32px;\s*background: linear-gradient/u,
  );
  assert.match(css, /@media \(hover: none\), \(pointer: coarse\)/u);
  assert.match(css, /width: 44px;\s*height: 44px;\s*min-height: 44px;/u);
});

test("allocation preserves prior status and shortcut budgets and drops with the badge", () => {
  // Arithmetic contract only, not rendered geometry or a visual acceptance test.
  const width = Number(css.match(/--thread-menu-action-width: (\d+)px/u)?.[1]);
  assert.equal(width, 28);
  for (const statuses of [0, 28, 56, 84]) {
    for (const shortcut of [0, 44, 56]) {
      const original = 10 + statuses + shortcut;
      const allocation = (hasQuestion, interacting) =>
        original + (hasQuestion && interacting ? width : 0);
      assert.equal(allocation(true, true) - original, width);
      assert.equal(allocation(true, false), original);
      assert.equal(allocation(false, true), original);
    }
  }
});

test("forced colors retain the Canvas action surface at candidate specificity", () => {
  const forced = candidate.slice(
    candidate.indexOf("@media (forced-colors: active)"),
  );
  assert.match(forced, /@media \(forced-colors: active\)/u);
  assert.match(
    forced,
    /\.thread-row-shell:has\(> \.thread-row \.thread-asking-badge\):is\(\s*:hover,\s*:focus-within,\s*\[data-menu-open="true"\]\s*\)\s*> \.thread-status-rail\s*\{\s*background: Canvas;/u,
  );
  assert.doesNotMatch(forced, /padding|width|transparent/u);
  assert(
    candidate.indexOf("background: Canvas") >
      candidate.indexOf("background: transparent"),
  );
});
