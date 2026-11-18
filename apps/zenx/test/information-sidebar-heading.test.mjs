import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const css = read("../src/renderer/src/styles.css");
const source = read("../src/renderer/src/subagents-ui.tsx");
const panels = read("../src/renderer/src/i18n/panels.ts");
const shell = read("../src/renderer/src/i18n/shell.ts");

test("only the desktop dock's existing Sidebar heading is restored visually", () => {
  const section = css.slice(css.indexOf("/* Preserve standalone rows;"));
  assert.match(section, /@media \(min-width: 961px\)\s*\{/u);
  const rule = section.match(
    /\.information-dock \.subagent-sidebar-heading\.sr-only\s*\{([^}]+)\}/u,
  )?.[1];
  assert.ok(rule);
  for (const declaration of [
    "position: static;",
    "width: auto;",
    "height: auto;",
    "padding: 0 6px 4px;",
    "margin: 0;",
    "overflow: visible;",
    "clip: auto;",
    "white-space: normal;",
  ])
    assert(rule.includes(declaration));
  assert.equal(
    (css.match(/\.subagent-sidebar-heading\.sr-only/g) ?? []).length,
    1,
  );
  assert.match(
    css,
    /\.sr-only\s*\{\s*position: absolute;\s*width: 1px;\s*height: 1px;/u,
  );
  assert.doesNotMatch(rule, /font-size|color:|display:\s*none|pointer-events/u);
});

test("one existing localized heading retains its row/control guard and switches retain semantics", () => {
  assert.match(source, /\{tree && sidebar \? \(/u);
  assert.equal(
    (source.match(/panels:subagentSidebarHeading/g) ?? []).length,
    1,
  );
  assert.match(source, /information\?\.embedded \? " sr-only" : ""/u);
  assert.match(source, /role="switch"/u);
  assert.match(source, /aria-label=\{i18n\.t\("shell:showSubagentInSidebar"/u);
  assert.match(source, /aria-checked=\{visible\}/u);
  assert.match(source, /aria-disabled=\{busy\}/u);
  assert.match(source, /aria-busy=\{busy\}/u);
  assert.match(source, /shell:sidebarShown.*shell:sidebarHidden/u);
  assert.match(
    source,
    /await sidebar\.setVisible\(thread\.threadId, !visible\)/u,
  );
});

test("the heading names the left destination without renaming switch states or card Hide", () => {
  const values = (dictionary, key) =>
    [...dictionary.matchAll(new RegExp(`^  ${key}: "([^"]*)",$`, "gmu"))].map(
      (match) => match[1],
    );
  assert.deepEqual(values(panels, "subagentSidebarHeading"), [
    "Left sidebar",
    "左侧栏",
  ]);
  assert.deepEqual(values(panels, "informationHide"), ["Hide", "隐藏"]);
  assert.deepEqual(values(shell, "sidebarShown"), ["Shown", "已显示"]);
  assert.deepEqual(values(shell, "sidebarHidden"), ["Hidden", "已隐藏"]);
  assert.deepEqual(values(shell, "showSubagentInSidebar"), [
    "Show in sidebar: {{title}}",
    "在侧栏显示：{{title}}",
  ]);
  assert.deepEqual(values(shell, "showInSidebar"), [
    "Show in sidebar",
    "在侧栏显示",
  ]);
  assert.deepEqual(values(shell, "hideFromSidebar"), [
    "Hide from sidebar",
    "从侧栏隐藏",
  ]);
});
