import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
const css = readFileSync(
  new URL("../src/renderer/src/styles.css", import.meta.url),
  "utf8",
);
const section = css
  .split("/* Desktop navigation density:")[1]
  .split("/* Desktop Composer reading state:")[0]
  .split("*/")[1];
test("desktop detailed rows retain mode distinction and exclude Inbox", () => {
  assert.match(section, /@media \(min-width: 961px\)/);
  assert.match(
    section,
    /\[data-thread-density="detailed"\] \.thread-row:not\(\.inbox\)/,
  );
  assert.match(section, /min-height: 50px/);
  assert.match(section, /padding-block: 5px/);
  assert.match(section, /row-gap: 3px/);
  assert.doesNotMatch(
    section,
    /display:|visibility:|overflow:|pointer-events:|font-size:/,
  );
});
test("empty project copy stays present and no disclosure selector is changed", () => {
  assert.match(
    section,
    /\.project-empty\s*\{\s*margin-block: 2px 4px;\s*padding-block: 0;/,
  );
  assert.doesNotMatch(
    section,
    /aria-expanded|thread-model|selected|focus|compact|\.inbox\s*\{/,
  );
});

test("every desktop density override is scoped to detailed mode", () => {
  const selectors = [...section.matchAll(/([^{}]+)\{/g)]
    .map((match) => match[1].trim())
    .filter((selector) => !selector.startsWith("@media"));
  assert.equal(selectors.length, 3);
  for (const selector of selectors) {
    assert.ok(
      selector.startsWith('.sidebar[data-thread-density="detailed"] '),
      selector,
    );
  }
});
