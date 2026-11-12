import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("context hover corridor does not extend the panel's scrollable content", async () => {
  const styles = await readFile(
    new URL("../src/renderer/src/styles.css", import.meta.url),
    "utf8",
  );
  // The real sibling hover bridge covers the pointer gap. An absolutely
  // positioned ::after below this scroll container creates overflow even
  // when every visible control fits, so it must not be used as a corridor.
  assert.doesNotMatch(styles, /\.context-usage-popover::after\s*\{/u);
  const panel = styles.match(/\.context-usage-popover\s*\{([^}]+)\}/u)?.[1];
  assert.ok(panel);
  assert.match(panel, /max-height: min\(360px, calc\(100vh - 16px\)\);/u);
  assert.match(panel, /overflow: auto;/u);
  assert.doesNotMatch(panel, /(?:^|;)\s*height:/u);
});
