import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const css = readFileSync(
  new URL("../src/renderer/src/styles.css", import.meta.url),
  "utf8",
);
const splitCss = readFileSync(
  new URL("../src/renderer/src/subagents.css", import.meta.url),
  "utf8",
);
function rule(source, selector) {
  return (
    [...source.matchAll(/([^{}]+)\{([^{}]*)\}/gu)].find(
      (match) => match[1].trim() === selector,
    )?.[2] ?? ""
  );
}

test("narrow composer allocation bounds the model button, not just its wrapper", () => {
  // Structural CSS regression, not a browser layout assertion. The original
  // 416px split pane shrank the wrapper while the button painted over usage.
  assert.match(rule(css, ".composer-tools"), /flex: 1 1 auto/u);
  assert.match(rule(css, ".composer-tools"), /min-width: 0/u);
  assert.match(rule(css, ".composer-model-menu"), /flex: 1 1 64px/u);
  assert.match(rule(css, ".composer-model-menu"), /min-width: 64px/u);
  assert.match(rule(css, ".composer-model-menu"), /max-width: 220px/u);
  assert.match(
    rule(css, ".composer-model-menu > .composer-model-trigger"),
    /max-width: 100%/u,
  );
  const label = rule(css, ".composer-model-trigger > span:first-child");
  for (const declaration of [
    "min-width: 0",
    "overflow: hidden",
    "text-overflow: ellipsis",
    "white-space: nowrap",
  ])
    assert.ok(label.includes(declaration));
  assert.match(rule(css, ".composer-model-trigger > svg"), /flex-shrink: 0/u);
  assert.match(
    rule(splitCss, ".thread-conversation-viewport .composer-model-menu"),
    /max-width: 180px/u,
  );
  assert.equal(
    rule(splitCss, ".thread-conversation-viewport .composer-model-trigger"),
    "",
    "split panes must not override the parent-relative trigger bound",
  );
});

test("utility and send controls keep their hit areas with a wrapping fallback", () => {
  assert.match(
    rule(css, ".composer-tools > :not(.composer-model-menu)"),
    /flex: 0 0 auto/u,
  );
  assert.match(rule(css, ".composer-actions"), /flex: 0 0 auto/u);
  assert.match(rule(css, ".composer-tools"), /flex-wrap: wrap/u);
  assert.match(rule(css, ".composer-tools"), /overflow: visible/u);
  const threadView = readFileSync(
    new URL("../src/renderer/src/ThreadView.tsx", import.meta.url),
    "utf8",
  );
  const toolbar = threadView.slice(
    threadView.indexOf('<div className="composer-rail">'),
  );
  const controls = [
    'className="composer-tool icon-only"',
    "<AppShotButton",
    "<ComposerModelMenu",
    "<ContextUsageIndicator",
    "<PermissionSelect",
    "<ComposerSendControl",
  ];
  const positions = controls.map((control) => toolbar.indexOf(control));
  assert.ok(positions.every((position) => position >= 0));
  assert.deepEqual(
    positions,
    [...positions].sort((a, b) => a - b),
  );
});
