import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const css = readFileSync(
  new URL("../src/renderer/src/ComposerSendControl.css", import.meta.url),
  "utf8",
);

function rules(selector) {
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/gu)]
    .filter((match) => match[1].trim().split(/,\s*/u).includes(selector))
    .map((match) => match[2])
    .join("\n");
}

function firstRule(selector) {
  return rules(selector).split("\n\n")[0];
}

test("send choices use readable semantic type for labels, consequences, and real shortcuts", () => {
  assert.match(
    rules(".composer-send-options strong"),
    /font-size:\s*var\(--font-size-label\)/u,
  );
  for (const selector of [
    ".composer-send-heading > span",
    ".composer-send-description",
    ".composer-send-options small",
    ".composer-send-options kbd",
    ".composer-send-heading kbd",
    ".composer-send-default",
    ".composer-send-default .ui-select",
  ]) {
    assert.match(
      rules(selector),
      /font-size:\s*var\(--font-size-caption\)/u,
      `${selector} must not shrink below the shared auxiliary-text size`,
    );
  }
  assert.match(
    rules(".composer-send-options small"),
    /color:\s*var\(--color-text-secondary\)/u,
  );
  assert.doesNotMatch(css, /font-size:\s*1[01]px/u);
  assert.match(rules(".composer-send-options button"), /min-height:\s*44px/u);
  assert.match(
    firstRule(".composer-send-default .ui-select"),
    /min-height:\s*44px/u,
  );
});

test("the send panel contains larger type within available viewport height without a fixed body floor", () => {
  const panel = rules(".ui-popover.composer-send-popover");
  assert.match(panel, /display:\s*flex/u);
  assert.match(panel, /flex-direction:\s*column/u);
  assert.match(panel, /max-width:\s*calc\(100vw - 24px\)/u);
  assert.match(
    panel,
    /max-height:\s*min\([\s\S]*var\(--radix-popover-content-available-height,[\s\S]*100dvh/u,
  );
  // Keep the existing outside hover bridge; only the body owns menu scrolling.
  assert.match(panel, /overflow:\s*visible/u);
  assert.match(rules(".composer-send-summary"), /flex:\s*0 0 auto/u);
  const body = rules(".composer-send-body");
  assert.match(body, /min-height:\s*0/u);
  assert.match(body, /overflow-y:\s*auto/u);
  assert.doesNotMatch(body, /max-height:\s*max\(/u);
  assert.match(rules(".composer-send-heading"), /flex-wrap:\s*wrap/u);
  assert.match(
    rules(".composer-send-options kbd"),
    /grid-column:\s*2/u,
    "Narrow panels place the shortcut under its own action instead of squeezing the description",
  );
});
