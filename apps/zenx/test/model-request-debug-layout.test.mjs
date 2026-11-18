import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { JSDOM } from "jsdom";
import postcss from "postcss";

function assertTraceImport(styles) {
  const root = postcss.parse(styles);
  const imports = [];
  root.walkAtRules("import", (rule) => {
    if (
      /^(?:"\.\/TraceInspector\.css"|'\.\/TraceInspector\.css')(?:\s|$)/u.test(
        rule.params,
      )
    )
      imports.push(rule);
  });
  assert.equal(
    imports.length,
    1,
    "Trace stylesheet must be imported exactly once",
  );
  const rule = imports[0];
  assert.equal(rule.parent, root, "Trace import must be top-level");
  for (const previous of root.nodes.slice(0, root.nodes.indexOf(rule))) {
    assert.ok(
      previous.type === "comment" ||
        (previous.type === "atrule" &&
          ["charset", "import", "layer"].includes(previous.name) &&
          !previous.nodes),
      "Trace import must precede style rules and blocks",
    );
  }
}

test("read-only Trace controls retain coarse targets and scoped CSS", async () => {
  const css = await readFile(
    new URL("../src/renderer/src/TraceInspector.css", import.meta.url),
    "utf8",
  );
  assert.match(css, /min-height:\s*44px/u);
  assert.match(css, /trace-inspector\[data-narrow="true"\]/u);
  assert(!css.includes(".model-debug-switch"));
  const styles = await readFile(
    new URL("../src/renderer/src/styles.css", import.meta.url),
    "utf8",
  );
  assertTraceImport(styles);
  assert.match(styles, /transition-duration:\s*0s !important/u);
});

test("selected request metadata and hovered warnings remain readable in every theme", async () => {
  const [styles, theme] = await Promise.all([
    readFile(
      new URL("../src/renderer/src/styles.css", import.meta.url),
      "utf8",
    ),
    readFile(new URL("../src/renderer/src/theme.css", import.meta.url), "utf8"),
  ]);
  const traceCss = await readFile(
    new URL("../src/renderer/src/TraceInspector.css", import.meta.url),
    "utf8",
  );
  assert.match(traceCss, /color:\s*var\(--color-text-primary\)/u);
  const dom = new JSDOM("<!doctype html><html><head></head></html>");
  const style = dom.window.document.createElement("style");
  style.textContent = theme;
  dom.window.document.head.append(style);
  const root = dom.window.document.documentElement;
  try {
    for (const appearance of ["light", "dark"]) {
      for (const preset of ["graphite", "cobalt", "ember"]) {
        for (const accent of ["azure", "iris", "jade"]) {
          for (const contrast of ["standard", "high"]) {
            Object.assign(root.dataset, {
              appearance,
              themePreset: preset,
              accent,
              contrast,
            });
            const computed = dom.window.getComputedStyle(root);
            const luminance = (token) => {
              const hex = computed.getPropertyValue(`--color-${token}`).trim();
              assert.match(hex, /^#[0-9a-f]{6}$/iu);
              const [r, g, b] = [1, 3, 5].map((offset) => {
                const channel =
                  Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
                return channel <= 0.04045
                  ? channel / 12.92
                  : ((channel + 0.055) / 1.055) ** 2.4;
              });
              return 0.2126 * r + 0.7152 * g + 0.0722 * b;
            };
            for (const surface of ["surface-hover", "surface-active"]) {
              const foreground = luminance("text-primary");
              const background = luminance(surface);
              const ratio =
                (Math.max(foreground, background) + 0.05) /
                (Math.min(foreground, background) + 0.05);
              assert.ok(
                ratio >= 4.5,
                `${appearance}/${preset}/${accent}/${contrast} warning text on ${surface}: ${ratio}`,
              );
            }
          }
        }
      }
    }
  } finally {
    dom.window.close();
  }
});

test("Trace import permits preceding imports but rejects missing, duplicate, nested and late imports", () => {
  assert.doesNotThrow(() =>
    assertTraceImport(
      '@import "./conversation-reading-position.css"; /* scope */ @import "./TraceInspector.css"; .app {}',
    ),
  );
  assert.doesNotThrow(() =>
    assertTraceImport(
      '@charset "UTF-8"; @layer reset, app; @import "./TraceInspector.css";',
    ),
  );
  for (const css of [
    '/* @import "./TraceInspector.css"; */ .app {}',
    '@import "./TraceInspector.css"; @import "./TraceInspector.css";',
    '.app {} @import "./TraceInspector.css";',
    '@media screen { @import "./TraceInspector.css"; }',
    '@layer app {} @import "./TraceInspector.css";',
  ])
    assert.throws(() => assertTraceImport(css));
});
