import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("capture switch centers its thumb when the coarse-pointer hit target grows", async () => {
  const styles = await readFile(
    new URL("../src/renderer/src/styles.css", import.meta.url),
    "utf8",
  );
  const switchRule = styles.match(/\.model-debug-switch\s*\{([^}]+)\}/u)?.[1];
  assert.ok(switchRule);
  // The track expands from a 30px button to a 44px touch target. The thumb
  // must center in the actual button, rather than retain its 8px top inset.
  assert.match(switchRule, /display:\s*flex;/u);
  assert.match(switchRule, /align-items:\s*center;/u);
  assert.match(switchRule, /height:\s*30px;/u);
  const coarse = styles.slice(
    styles.indexOf(
      "@media (pointer: coarse)",
      styles.indexOf(".model-debug-panel"),
    ),
  );
  assert.match(coarse, /min-height:\s*44px;/u);
  assert.match(
    coarse,
    /\.model-debug-switch::before\s*\{\s*inset-block:\s*13px;/u,
  );
});
