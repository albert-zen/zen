import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
const read = (name) => readFileSync(new URL(name, import.meta.url), "utf8");
const source = read("../src/renderer/src/Sidebar.tsx");
const css = read("../src/renderer/src/styles.css");
const locale = read("../src/renderer/src/i18n/shell.ts");
test("only expanded empty groups add decorative localized header context", () => {
  assert.match(
    source,
    /group\.threads\.length === 0 && open && !projectReorder\?\.dragging \? \(/u,
  );
  assert.match(
    source,
    /className="project-empty-inline"\s+aria-hidden="true"\s+title=\{i18n.t\("shell:noThreadsYet"\)\}/u,
  );
  assert.match(
    source,
    /<p className="project-empty">\{i18n.t\("shell:noThreadsYet"\)\}<\/p>/u,
  );
  assert.match(
    source,
    /aria-expanded=\{open && !projectReorder\?\.dragging\}/u,
  );
  assert.match(source, /onClick=\{toggleOpen\}/u);
  assert.match(source, /onKeyDown=\{projectReorder\?\.onKeyDown\}/u);
  assert.match(locale, /emptyProjectStatus: "No threads"/u);
  assert.match(locale, /emptyProjectStatus: "无会话"/u);
});
test("desktop scope removes only empty-row geometry and keeps smaller-window labels", () => {
  const section = css.slice(css.indexOf("/* Empty projects stay present"));
  assert.match(section, /\.project-empty-inline\s*\{\s*display: none;/u);
  assert.match(section, /@media \(min-width: 961px\)/u);
  assert.match(
    section,
    /\.sidebar \.project-toggle \.project-empty-inline\s*\{\s*display: inline;\s*flex: 0 0 auto;/u,
  );
  assert.match(
    section,
    /\.sidebar \.project-disclosure \.project-empty\s*\{\s*position: absolute;/u,
  );
  assert.doesNotMatch(
    section,
    /\.thread-row|\.recent|\.project-actions|\.project-toggle\s*\{|pointer-events|visibility:\s*hidden/u,
  );
});
