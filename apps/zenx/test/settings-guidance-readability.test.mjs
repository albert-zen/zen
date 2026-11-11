import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const css = readFileSync(
  new URL("../src/renderer/src/styles.css", import.meta.url),
  "utf8",
);
const theme = readFileSync(
  new URL("../src/renderer/src/theme.css", import.meta.url),
  "utf8",
);

test("settings decision guidance uses the shared readable semantic tier", () => {
  const rule = css.match(
    /\.settings-panel \.settings-guidance\s*\{([^}]*)\}/u,
  )?.[1];
  assert.ok(rule);
  assert.match(rule, /color:\s*var\(--color-text-secondary\)/u);
  assert.match(rule, /font-size:\s*var\(--font-size-label\)/u);
  assert.match(rule, /line-height:\s*1\.5/u);
  assert.match(theme, /--font-size-label:\s*13px/u);
  assert.doesNotMatch(rule, /(?:opacity|filter|background|!important)/u);
});

test("General keyboard guidance wraps without fixed row heights or clipping", () => {
  const row = css.match(
    /\.settings-send-shortcuts dl > div\s*\{([^}]*)\}/u,
  )?.[1];
  const value = css.match(/\.settings-send-shortcuts dd\s*\{([^}]*)\}/u)?.[1];
  assert.ok(row);
  assert.ok(value);
  assert.match(row, /flex-wrap:\s*wrap/u);
  assert.match(value, /min-width:\s*0/u);
  assert.match(value, /overflow-wrap:\s*anywhere/u);
  assert.doesNotMatch(
    row + value,
    /(?:max-height|overflow:\s*hidden|white-space:\s*nowrap)/u,
  );
});

test("foreground control keeps its label and switch together across widths", () => {
  const row = css.match(
    /\.settings-view \.settings-foreground-control \.settings-row\s*\{([^}]*)\}/u,
  )?.[1];
  const body = css.match(
    /\.settings-foreground-control-body\s*\{([^}]*)\}/u,
  )?.[1];
  assert.ok(row);
  assert.ok(body);
  assert.match(row, /display:\s*grid/u);
  assert.match(row, /grid-template-columns:\s*minmax\(0, 1fr\) auto/u);
  assert.match(row, /align-items:\s*center/u);
  assert.match(body, /display:\s*grid/u);
  assert.doesNotMatch(
    row + body,
    /(?:max-height|overflow:\s*hidden|white-space:\s*nowrap)/u,
  );
});
