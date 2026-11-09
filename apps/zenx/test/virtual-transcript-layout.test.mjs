import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
const css = readFileSync(
  new URL("../src/renderer/src/styles.css", import.meta.url),
  "utf8",
);
const theme = readFileSync(
  new URL("../src/renderer/src/theme.css", import.meta.url),
  "utf8",
);
const virtual = css.slice(css.indexOf("/* WIP virtual viewport:"));
const [wide, narrow] = virtual.split("@media (max-width: 640px)");
test("virtual rows and pending footer retain the desktop 24px rhythm", () => {
  assert.match(wide, /\.virtual-transcript-row\s*\{\s*padding-bottom:\s*24px;/);
  assert.match(wide, /\.virtual-transcript-footer\s*\{[^}]*gap:\s*24px;/);
});
test("virtual rows and pending footer inherit the existing narrow 20px contract", () => {
  assert.ok(
    narrow,
    "the virtual viewport needs its own matching ≤640px override",
  );
  assert.match(
    narrow,
    /\.virtual-transcript-row\s*\{\s*padding-bottom:\s*20px;/,
  );
  assert.match(
    narrow,
    /\.virtual-transcript-header\s*\{\s*padding-top:\s*20px;/,
  );
  assert.match(
    narrow,
    /\.virtual-transcript-footer\s*\{\s*gap:\s*20px;\s*padding-bottom:\s*max\(28px,/,
  );
});
test("default virtual transcript has no experimental warning UI", () => {
  assert.equal(css.includes(".virtual-transcript-warning"), false);
  const component = readFileSync(
    new URL(
      "../src/renderer/src/ExperimentalTranscriptViewport.tsx",
      import.meta.url,
    ),
    "utf8",
  );
  assert.equal(
    component.includes('className="virtual-transcript-warning"'),
    false,
  );
  assert.equal(component.includes("Experimental virtual transcript."), false);
});

test("empty virtual footer compensates only the final row gap at each breakpoint", () => {
  assert.match(
    wide,
    /\.virtual-transcript-footer:empty\s*\{\s*padding-bottom:\s*calc\(\s*max\(38px, calc\(var\(--bottom-zone-height, 0px\) \+ 24px\)\) - 24px\s*\);/,
  );
  assert.match(
    narrow,
    /\.virtual-transcript-footer:empty\s*\{\s*padding-bottom:\s*calc\(\s*max\(28px, calc\(var\(--bottom-zone-height, 0px\) \+ 24px\)\) - 20px\s*\);/,
  );
  // The rendered DOM decides emptiness, including a Fragment whose pending
  // component returns []; pending/progress footer children keep their own gap.
  assert.doesNotMatch(wide + narrow, /:has\(/);
  for (const [gap, minimum] of [
    [24, 38],
    [20, 28],
  ]) {
    for (const composerHeight of [0, 108, 280]) {
      const standardClearance = Math.max(minimum, composerHeight + 24);
      const emptyFooterClearance = standardClearance - gap;
      assert.equal(gap + emptyFooterClearance, standardClearance);
      assert.ok(emptyFooterClearance >= 0);
    }
  }
});

// The pinned Legend web component adds inline minWidth to its vertical row
// container. This narrow CSS override permits cross-axis shrink without
// changing height/offset authority; real Chromium geometry is checked separately.
test("vertical row containers can shrink below Legend's previous measured width", () => {
  assert.match(
    css,
    /\.experimental-transcript-viewport > \.virtual-transcript-content > div\s*\{\s*min-width: 0 !important;\s*max-width: 100%;/,
  );
});

// The native scroll range must not collapse while a fullscreen resource covers
// the conversation. DOM identity alone is not enough to preserve a paused reader.
test("fullscreen tab changes retain hidden conversation geometry", () => {
  const fullscreen = css.slice(
    css.indexOf("/* Keep fullscreen conversation geometry"),
  );
  const geometry = fullscreen.match(
    /\.workspace:has\(> \.auxiliary-panel\[data-open="true"\]\[data-expanded="true"\]\)\s*> :is\(\.agent-surface, \.plugin-product-page\)\s*\{([^}]+)\}/,
  )?.[1];
  assert.ok(geometry, "geometry must apply to every fullscreen tab");
  assert.match(geometry, /display:\s*grid;/);
  assert.match(
    geometry,
    /width:\s*calc\(100% - var\(--information-dock-reserved-width, 0px\)\);/,
  );
  assert.match(
    geometry,
    /padding-top:\s*var\(--native-titlebar-height, 44px\);/,
  );
  assert.doesNotMatch(geometry, /visibility:\s*visible/);
  const selected = fullscreen.match(
    /\[data-primary-active="true"\][\s\S]*?> :is\(\.agent-surface, \.plugin-product-page\)\s*\{([^}]+)\}/,
  )?.[1];
  assert.ok(selected);
  assert.match(selected, /visibility:\s*visible;/);
  assert.doesNotMatch(selected, /display:|width:|padding-top:/);
});
