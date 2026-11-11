import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
const css = readFileSync(
  new URL(
    "../src/renderer/src/conversation-reading-position.css",
    import.meta.url,
  ),
  "utf8",
);
test("desktop history return replaces floating action with a normal-flow reading strip", () => {
  assert.match(css, /\.composer-reading-position\s*\{\s*display: none;/u);
  assert.match(css, /@media \(min-width: 961px\)/u);
  assert.match(css, /\.thread-view > \.back-live\s*\{\s*display: none;/u);
  assert.match(css, /\.composer-reading-position\s*\{\s*display: flex;/u);
  assert.doesNotMatch(css, /position:\s*(absolute|fixed|sticky)/u);
});
