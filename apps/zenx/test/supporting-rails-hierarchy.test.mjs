import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
const css = readFileSync(
  new URL("../src/renderer/src/styles.css", import.meta.url),
  "utf8",
);
const section = css.slice(css.indexOf("/* Desktop supporting rails:"));
test("supporting rails distinguish information hierarchy without changing navigation or hiding controls", () => {
  assert.match(section, /@media \(min-width: 961px\)/u);
  assert.match(
    section,
    /\.sidebar \.thread-row.selected \.thread-title\s*\{\s*font-weight: 600;/u,
  );
  assert.match(
    section,
    /\.information-dock\s*\{\s*background: var\(--color-surface-sidebar\);/u,
  );
  assert.match(
    section,
    /\.information-dock \.information-widget\s*\{[^}]*background: var\(--color-surface\);/u,
  );
  assert.doesNotMatch(
    section,
    /display:\s*none|visibility:\s*hidden|opacity:|position:\s*absolute|pointer-events:\s*none/u,
  );
});
test("supporting rail changes preserve native colors and primary reading geometry", () => {
  assert.doesNotMatch(
    section,
    /#[0-9a-f]{3,8}\b|--conversation-width|\.bottom-zone|\.messages/u,
  );
  assert.match(
    section,
    /\.information-settings-toolbar > span\s*\{[^}]*font-size: 14px;[^}]*font-weight: 600;/u,
  );
  assert.match(
    section,
    /\.information-widget-disclosure h3\s*\{[^}]*font-size: 13px;/u,
  );
});
