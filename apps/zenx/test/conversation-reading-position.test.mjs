import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
const css = readFileSync(
  new URL(
    "../src/renderer/src/conversation-reading-position.css",
    import.meta.url,
  ),
  "utf8",
);
test("desktop history return floats outside the editor and leaves smaller windows unchanged", () => {
  assert.match(css, /\.conversation-reading-position\s*\{\s*display: none;/u);
  assert.match(css, /@media \(min-width: 961px\)/u);
  assert.match(css, /\.thread-view > \.back-live\s*\{\s*display: none;/u);
  assert.match(
    css,
    /\.conversation-reading-position\s*\{\s*position: absolute;/u,
  );
  assert.match(
    css,
    /bottom: calc\(var\(--bottom-zone-height, 0px\) \+ 6px\);/u,
  );
  assert.doesNotMatch(css, /\.composer(?:-|[ .{])/u);
});

test("held reading adds scroll clearance without shrinking the transcript viewport", () => {
  assert.match(
    css,
    /\.thread-view\[data-reading-earlier="true"\]\s*\{\s*--history-return-clearance: 48px;/u,
  );
  const viewport = css.match(/> \.messages\s*\{([^}]+)\}/u)?.[1];
  assert(viewport);
  assert.match(viewport, /padding-bottom: calc\(/u);
  assert.match(viewport, /scroll-padding-bottom: calc\(/u);
  assert.doesNotMatch(
    viewport,
    /(?:^|;)\s*(?:height|max-height|bottom|inset):/u,
  );
  assert.match(
    css,
    /\.virtual-transcript-footer:empty\s*\{\s*padding-bottom: calc\(/u,
  );
});

test("round return uses semantic surfaces, coarse-pointer targets and the shared focus ring", () => {
  const control = css.match(
    /\.conversation-reading-position button\s*\{([^}]+)\}/u,
  )?.[1];
  assert(control);
  for (const declaration of [
    "width: 36px",
    "height: 36px",
    "border-radius: 50%",
    "background: var(--color-surface-elevated)",
    "color: var(--color-text-secondary)",
  ])
    assert(control.includes(declaration), declaration);
  assert.match(css, /any-pointer: coarse/u);
  assert.match(css, /width: 44px;/u);
  assert.match(css, /height: 44px;/u);
  assert.doesNotMatch(
    css,
    /!important|#[\da-f]{3,8}\b|outline:\s*none|forced-color-adjust/iu,
  );
  const globalCss = readFileSync(
    new URL("../src/renderer/src/styles.css", import.meta.url),
    "utf8",
  );
  assert.match(
    globalCss,
    /:where\(button, textarea, input, select, summary, a, \[tabindex\]\):focus-visible\s*\{\s*outline: 1px solid var\(--color-focus-ring\);/u,
  );
});

test("the nested return stylesheet is explicitly receipted and selected by both fast-preview filters", () => {
  const paths = [
    "apps/zenx/src/renderer/src/conversation-reading-position.css",
    "apps/zenx/test/conversation-reading-position.test.mjs",
  ];
  const build = readFileSync(
    new URL("../scripts/build-main-ui-preview.mjs", import.meta.url),
    "utf8",
  );
  const capture = readFileSync(
    new URL("../scripts/reading-main-ui-preview.mjs", import.meta.url),
    "utf8",
  );
  const workflow = readFileSync(
    new URL(
      "../../../.github/workflows/desktop-reading-ui.yml",
      import.meta.url,
    ),
    "utf8",
  );
  for (const path of paths) {
    assert(
      build
        .slice(
          build.indexOf("const sources = new Set(["),
          build.indexOf("const scenes = {};"),
        )
        .includes(JSON.stringify(path)),
    );
    assert(
      capture
        .slice(
          capture.indexOf("export const readingPaths = ["),
          capture.indexOf("export const readingPathsChanged"),
        )
        .includes(JSON.stringify(path)),
    );
    assert(
      workflow
        .slice(
          workflow.indexOf("    paths:"),
          workflow.indexOf("  workflow_dispatch:"),
        )
        .includes(`      - ${path}\n`),
    );
  }
  assert.match(
    workflow,
    /run: node --import tsx --test[^\n]*apps\/zenx\/test\/conversation-reading-position\.test\.mjs/u,
  );
});
