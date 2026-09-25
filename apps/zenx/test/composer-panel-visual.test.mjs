import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const css = readFileSync(
  new URL("../src/renderer/src/styles.css", import.meta.url),
  "utf8",
);
const app = readFileSync(
  new URL("../src/renderer/src/App.tsx", import.meta.url),
  "utf8",
);
const panel = readFileSync(
  new URL("../src/renderer/src/auxiliary-panel.tsx", import.meta.url),
  "utf8",
);
const thread = readFileSync(
  new URL("../src/renderer/src/ThreadView.tsx", import.meta.url),
  "utf8",
);

function rule(selector, last = false) {
  const start = last
    ? css.lastIndexOf(`\n${selector} {`)
    : css.indexOf(`\n${selector} {`);
  assert.notEqual(start, -1, `${selector} rule missing`);
  return css.slice(start, css.indexOf("}", start));
}

test("side panel open and close affordances use the same glyph and footprint", () => {
  assert.match(
    app,
    /id="thread-browser-toggle"[\s\S]*?<Icon name="panel-right" \/>/u,
  );
  assert.match(
    panel,
    /className="icon-button auxiliary-close-button"[\s\S]*?<Icon name="panel-right" \/>/u,
  );
  assert.match(rule(".thread-panel-toggle"), /width: 36px;/u);
  assert.match(rule(".thread-panel-toggle"), /height: 36px;/u);
  assert.match(rule(".thread-panel-toggle"), /top: 4px;/u);
  // 4 + 36 < the native 44px titlebar height; hover paint cannot cover its bottom border.
  assert.match(css, /--native-titlebar-height: 44px;/u);
  assert.match(
    rule(".auxiliary-heading .auxiliary-close-button", true),
    /width: 36px;/u,
  );
  assert.match(
    rule(".auxiliary-heading .auxiliary-close-button", true),
    /height: 36px;/u,
  );
});

test("composer scrollbar stays inset from the rounded shell, including when focused", () => {
  assert.match(rule(".composer"), /border-radius: 22px;/u);
  assert.match(rule(".composer > textarea"), /margin: 22px 8px 0;/u);
  assert.match(rule(".composer > textarea"), /width: calc\(100% - 16px\);/u);
  assert.match(rule(".composer > textarea"), /outline: 0;/u);
  assert.match(css, /\.composer:focus-within\s*\{[^}]*box-shadow:/u);
});

test("composer icon controls retain a matching hit area in narrow layouts", () => {
  assert.match(rule(".composer-tool.icon-only"), /min-width: 36px;/u);
  assert.match(
    rule(".composer .context-usage-indicator"),
    /flex-basis: 36px;/u,
  );
  assert.match(
    rule(".context-usage-trigger:focus-visible"),
    /color-focus-ring/u,
  );
  assert.match(rule(".context-usage-trigger"), /width: 36px;/u);
  assert.match(thread, /<button\s+className="context-usage-trigger"/u);
});

test("overflow track begins on straight edge while the total editor height remains bounded", () => {
  assert.match(rule(".composer > textarea"), /min-height: 54px;/u);
  assert.match(
    rule(".composer > textarea"),
    /max-height: max\(54px, min\(136px, calc\(35vh - 14px\)\)\);/u,
  );
  assert.match(thread, /const style = window\.getComputedStyle\(textarea\);/u);
  assert.match(thread, /Number\.parseFloat\(style\.minHeight\)/u);
  assert.match(rule(".composer-rail"), /min-height: 50px;/u);
  assert.match(rule(".composer", false), /border-radius: 22px;/u);
  assert.match(css, /  \.composer \{\s*border-radius: 20px;/u);
});
