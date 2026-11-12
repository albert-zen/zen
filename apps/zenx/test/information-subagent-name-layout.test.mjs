import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
const css = readFileSync(
  new URL("../src/renderer/src/styles.css", import.meta.url),
  "utf8",
);
const ui = readFileSync(
  new URL("../src/renderer/src/subagents-ui.tsx", import.meta.url),
  "utf8",
);
const rule = css.slice(css.indexOf("/* Preserve standalone rows;"));
test("identity wrapper preserves original title/status and standalone layout", () => {
  assert.match(
    ui,
    /className="subagent-tree-identity">\s*<span className="subagent-tree-title">/,
  );
  assert.match(
    rule,
    /^\/\*[^]*?\.subagent-tree-identity\s*\{\s*display: contents;/,
  );
  assert.match(ui, /className="subagent-tree-status">/);
});
test("desktop dock lets full-width long titles wrap before status without fixed thresholds", () => {
  assert.match(rule, /@media \(min-width: 961px\)/);
  assert.match(
    rule,
    /\.information-dock \.subagent-tree-identity\s*\{[^}]*display: flex;[^}]*flex-wrap: wrap;/,
  );
  assert.match(
    rule,
    /\.information-dock \.subagent-tree-title\s*\{[^}]*flex: 0 1 auto;[^}]*width: max-content;[^}]*max-width: 100%;/,
  );
  assert.doesNotMatch(
    rule,
    /display: none|visibility: hidden|overflow: hidden|line-clamp|position: absolute/,
  );
  assert.match(
    rule,
    /\.information-dock \.subagent-tree-status\s*\{[^}]*overflow-wrap: anywhere;[^}]*max-width: 100%;/,
  );
});
