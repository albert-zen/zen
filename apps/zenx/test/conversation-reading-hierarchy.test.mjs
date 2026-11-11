import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
const css = readFileSync(
  new URL("../src/renderer/src/styles.css", import.meta.url),
  "utf8",
);
const section = css.slice(
  css.indexOf("/* Desktop conversation reading hierarchy:"),
  css.indexOf("/* Desktop supporting rails:"),
);
test("desktop reading hierarchy is scoped and retains shared history/Composer alignment", () => {
  assert.match(section, /@media \(min-width: 961px\)/u);
  assert.match(section, /--conversation-width: 800px;/u);
  assert.match(section, /background: var\(--color-surface\);/u);
  assert.match(section, /\.thread-view \.bottom-zone::before/u);
  assert.doesNotMatch(
    section,
    /\.sidebar|\.queue-row|display: none|overflow: hidden|tabindex/iu,
  );
});
test("prose hierarchy keeps endpoint rhythm and themed structured results", () => {
  assert.match(
    section,
    /\.agent-copy\s*\{\s*font-size: 15px;\s*line-height: 1.8;/u,
  );
  assert.match(section, /:first-child\s*\{\s*margin-top: 0;/u);
  assert.match(section, /:last-child\s*\{\s*margin-bottom: 0;/u);
  assert.match(section, /font-size: 24px;/u);
  assert.match(section, /font-size: 20px;/u);
  assert.match(section, /font-size: 17px;/u);
  assert.match(section, /border-color: var\(--color-border-subtle\);/u);
});

test("desktop approval and Composer share measured column alignment", () => {
  assert.match(
    css,
    /\.thread-view \.bottom-zone > \.composer,\s*\.thread-view \.bottom-zone > \.approval-request-card\s*\{\s*position: relative;\s*margin-inline: 0;\s*left: var\(--composer-column-left, 0px\);\s*width: var\(--composer-column-width, 100%\);/u,
  );
});
