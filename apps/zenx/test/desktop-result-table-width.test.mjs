import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const css = readFileSync(
  new URL("../src/renderer/src/styles.css", import.meta.url),
  "utf8",
);
const section = css.slice(
  css.indexOf("/* Desktop conversation reading hierarchy:"),
  css.indexOf("/* Native transcript gutters"),
);
test("desktop assistant table cells reserve content width without selecting column identities", () => {
  assert.match(section, /@media \(min-width: 961px\)/u);
  const rule = section.match(
    /\.thread-view \.agent-copy \.markdown-body th,\s*\.thread-view \.agent-copy \.markdown-body td\s*\{([^}]+)\}/u,
  )?.[1];
  assert.ok(rule);
  assert.match(rule, /min-inline-size: calc\(6ch \+ 26px\);/u);
  assert.match(rule, /padding: 10px 12px;/u);
  assert.doesNotMatch(
    rule,
    /white-space|word-break|overflow-wrap|vertical-align|nth-child|font-size|line-height|table-layout/u,
  );
  assert.equal(
    (css.match(/min-inline-size: calc\(6ch \+ 26px\);/gu) ?? []).length,
    1,
  );
});
test("table overflow and reading typography remain unchanged", () => {
  assert.match(
    css,
    /\.markdown-table-wrap\s*\{\s*max-width: 100%;\s*overflow-x: auto;/u,
  );
  assert.match(
    section,
    /\.thread-view \.agent-copy\s*\{\s*font-size: 15px;\s*line-height: 1.8;/u,
  );
  assert.match(
    section,
    /\.thread-view \.agent-copy \.markdown-body table\s*\{\s*font-size: 13px;\s*line-height: 1.6;/u,
  );
  assert.doesNotMatch(section, /table-layout:\s*fixed/u);
});
