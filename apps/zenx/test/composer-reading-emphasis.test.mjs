import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
const css = readFileSync(
  new URL("../src/renderer/src/styles.css", import.meta.url),
  "utf8",
);
const section = css.slice(css.indexOf("/* Desktop Composer reading state:"));
test("reading emphasis is limited to desktop border and shadow", () => {
  assert.match(section, /@media \(min-width: 961px\)/u);
  assert.match(section, /border-color: var\(--color-border-subtle\);/u);
  assert.match(
    section,
    /box-shadow: inset 0 1px var\(--color-surface-wash\);/u,
  );
  assert.doesNotMatch(
    section,
    /\n\s*(?:width|height|padding|margin|display|opacity|pointer-events):/u,
  );
});
test("active input retains its explicit focus boundary", () => {
  assert.match(
    section,
    /\.composer:has\(> textarea:focus\)\s*\{\s*border-color: var\(--color-focus-ring\);/u,
  );
});
