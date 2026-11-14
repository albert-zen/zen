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
test("desktop history return replaces floating action with a normal-flow reading strip", () => {
  assert.match(css, /\.composer-reading-position\s*\{\s*display: none;/u);
  assert.match(css, /@media \(min-width: 961px\)/u);
  assert.match(css, /\.thread-view > \.back-live\s*\{\s*display: none;/u);
  assert.match(css, /\.composer-reading-position\s*\{\s*display: flex;/u);
  assert.doesNotMatch(css, /position:\s*(absolute|fixed|sticky)/u);
});

test("desktop return preserves quiet styling, typography, geometry and focus", () => {
  const control = css.match(
    /\.composer-reading-position \.quiet-button\s*\{([^}]+)\}/u,
  )?.[1];
  assert(control);
  for (const declaration of [
    "min-height: 32px",
    "gap: 6px",
    "color: var(--color-text-secondary)",
  ])
    assert(control.includes(declaration), declaration);
  assert.doesNotMatch(css, /(?:border-color|background)\s*:/u);
  assert.doesNotMatch(
    control,
    /(?:^|;)\s*(?:width|height|max-width|padding|margin|font-size|font-weight|outline|border-width|pointer-events|transform|position)\s*:/u,
  );
  assert.doesNotMatch(
    css,
    /!important|#[\da-f]{3,8}\b|--color-(?:accent|status-danger)|forced-color-adjust|:focus(?:-visible)?/iu,
  );
  const globalCss = readFileSync(
    new URL("../src/renderer/src/styles.css", import.meta.url),
    "utf8",
  );
  assert.match(
    globalCss,
    /:where\(button, textarea, input, select, summary, a, \[tabindex\]\):focus-visible\s*\{\s*outline: 1px solid var\(--color-focus-ring\);\s*outline-offset: 2px;/u,
  );
  assert.match(
    globalCss,
    /\.composer-actions\s*\{\s*flex: 0 0 auto;\s*gap: 5px;/u,
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
