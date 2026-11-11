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

test("settings decision guidance uses the shared readable semantic tier", () => {
  const rule = css.match(
    /\.settings-panel \.settings-guidance\s*\{([^}]*)\}/u,
  )?.[1];
  assert.ok(rule);
  assert.match(rule, /color:\s*var\(--color-text-secondary\)/u);
  assert.match(rule, /font-size:\s*var\(--font-size-label\)/u);
  assert.match(rule, /line-height:\s*1\.5/u);
  assert.match(theme, /--font-size-label:\s*13px/u);
  assert.doesNotMatch(rule, /(?:opacity|filter|background|!important)/u);
});
