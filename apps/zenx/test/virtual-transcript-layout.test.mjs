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
