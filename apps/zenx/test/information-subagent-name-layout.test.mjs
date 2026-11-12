import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const css = readFileSync(
  new URL("../src/renderer/src/styles.css", import.meta.url),
  "utf8",
);
const rule = css.slice(css.indexOf("/* Docked subagent identities lead;"));

test("desktop dock gives the wrapping identity and status separate grid rows", () => {
  assert.match(rule, /@media \(min-width: 961px\)/);
  assert.match(rule, /grid-template-columns: 16px minmax\(0, 1fr\)/);
  assert.match(
    rule,
    /\.information-dock \.subagent-tree-title\s*\{[^}]*grid-column: 2;[^}]*grid-row: 1;/,
  );
  assert.match(
    rule,
    /\.information-dock \.subagent-tree-status\s*\{[^}]*grid-column: 2;[^}]*grid-row: 2;[^}]*overflow-wrap: anywhere;/,
  );
});

test("candidate scopes every selector to the dock and does not hide data or controls", () => {
  const selectors = [...rule.matchAll(/([^{}]+)\{/g)]
    .map((m) => m[1].trim())
    .filter((s) => !s.includes("@media"));
  assert.equal(selectors.length, 4);
  assert.ok(selectors.every((s) => s.startsWith(".information-dock ")));
  assert.doesNotMatch(
    rule,
    /display: none|visibility: hidden|overflow: hidden|opacity:|line-clamp|pointer-events:|position: absolute/,
  );
});
