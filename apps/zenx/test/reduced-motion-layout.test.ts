import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const styles = await readFile(
  new URL("../src/renderer/src/styles.css", import.meta.url),
  "utf8",
);
const universalReducedRules = (css: string) => [
  ...css.matchAll(
    /@media \(prefers-reduced-motion: reduce\)\s*\{\s*(?::root\s*\{[^}]*\}\s*)?\*,\s*\*::before,\s*\*::after\s*\{([^}]*)\}/gu,
  ),
];
function assertSynchronousReducedLayout(css: string) {
  const rules = universalReducedRules(css);
  assert.equal(
    rules.length,
    2,
    "check both existing universal reduced-motion rules",
  );
  for (const rule of rules) {
    // Nonzero duration activates the default transition-property: all, even on
    // virtual layout spacers that never opted into animation. CodeMirror then
    // measures the old height synchronously and consumes the scroll request.
    assert.match(rule[1]!, /transition-duration:\s*0(?:ms|s)\s*!important;/u);
    assert.match(rule[1]!, /animation-duration:\s*0\.01ms\s*!important;/u);
    assert.match(rule[1]!, /scroll-behavior:\s*auto\s*!important;/u);
  }
}

test("reduced motion never introduces an asynchronous transition on layout spacers", () => {
  assertSynchronousReducedLayout(styles);
});

test("either duplicate tiny nonzero transition rule is a regression", () => {
  for (const rule of universalReducedRules(styles)) {
    const start = rule.index!;
    const regression =
      styles.slice(0, start) +
      rule[0].replace(
        /transition-duration:\s*0(?:ms|s)/u,
        "transition-duration: 0.01ms",
      ) +
      styles.slice(start + rule[0].length);
    assert.throws(() => assertSynchronousReducedLayout(regression));
  }
});
