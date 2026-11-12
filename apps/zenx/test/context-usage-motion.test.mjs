import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = new URL("../src/renderer/src/", import.meta.url);
const styles = readFileSync(new URL("styles.css", source), "utf8");
const motion = () =>
  readFileSync(new URL("ContextUsageIndicator.css", source), "utf8");

test("context details keep the send panel's timing without moving the popup away from its hover bridge", () => {
  assert.match(styles, /@import "\.\/ContextUsageIndicator\.css";/u);
  assert.match(
    motion(),
    /animation: context-usage-enter var\(--motion-enter\) var\(--ease-standard\);/u,
  );
  // Above and below placement share a stationary outer hitbox. Reusing
  // ui-enter would translate the below panel away from its fixed gap corridor.
  assert.match(
    motion(),
    /@keyframes context-usage-enter\s*\{\s*from\s*\{\s*opacity: 0;\s*\}\s*to\s*\{\s*opacity: 1;\s*\}\s*\}/u,
  );
  assert.doesNotMatch(
    motion(),
    /(?:^|\n)\s*(?:transform|translate|top|left|right|bottom):/u,
  );
});

test("ring feedback keeps its hit target and token arc still while hover, focus, and press feel responsive", () => {
  const css = motion();
  assert.match(css, /\.context-usage-trigger\[aria-expanded="true"\]/u);
  assert.match(css, /\.context-usage-trigger:focus-visible/u);
  assert.match(css, /\.context-usage-trigger:active > svg/u);
  assert.match(css, /scale: 1\.12;/u);
  assert.match(css, /scale: 0\.96;/u);
  assert.match(css, /scale var\(--motion-enter\) var\(--ease-standard\)/u);
  // Only paint scales: no changed geometry, fabricated usage, spin or bounce.
  // The same stylesheet also owns the popover's segmented meter and legend.
  // Geometry must remain fixed for the ring, not for unrelated help icons.
  const ringRules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/gu)]
    .filter((rule) => /\.context-usage-(?:indicator|trigger)\b/u.test(rule[1]))
    .map((rule) => rule[2])
    .join("\n");
  assert.ok(ringRules.length > 0);
  assert.doesNotMatch(
    ringRules,
    /stroke-dash|rotate|infinite|(?:^|\n)\s*(?:width|height|position):/u,
  );
});

test("reduced motion disables ring scaling and panel entrance, not placement or open feedback", () => {
  const reduced = motion().split("@media (prefers-reduced-motion: reduce)")[1];
  assert.ok(reduced);
  assert.match(reduced, /scale: none !important;/u);
  assert.match(reduced, /transition: none !important;/u);
  assert.match(reduced, /animation: none !important;/u);
  assert.doesNotMatch(reduced, /transform:|display: none|visibility:/u);
});
