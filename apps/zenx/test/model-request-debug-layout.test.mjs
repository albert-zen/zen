import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { JSDOM } from "jsdom";

test("capture switch centers its thumb when the coarse-pointer hit target grows", async () => {
  const styles = await readFile(
    new URL("../src/renderer/src/styles.css", import.meta.url),
    "utf8",
  );
  const switchRule = styles.match(/\.model-debug-switch\s*\{([^}]+)\}/u)?.[1];
  assert.ok(switchRule);
  // The track expands from a 30px button to a 44px touch target. The thumb
  // must center in the actual button, rather than retain its 8px top inset.
  assert.match(switchRule, /display:\s*flex;/u);
  assert.match(switchRule, /align-items:\s*center;/u);
  assert.match(switchRule, /height:\s*30px;/u);
  const coarse = styles.slice(
    styles.indexOf(
      "@media (pointer: coarse)",
      styles.indexOf(".model-debug-panel"),
    ),
  );
  assert.match(coarse, /min-height:\s*44px;/u);
  assert.match(
    coarse,
    /\.model-debug-switch::before\s*\{\s*inset-block:\s*13px;/u,
  );
});

test("selected request metadata and hovered warnings remain readable in every theme", async () => {
  const [styles, theme] = await Promise.all([
    readFile(
      new URL("../src/renderer/src/styles.css", import.meta.url),
      "utf8",
    ),
    readFile(new URL("../src/renderer/src/theme.css", import.meta.url), "utf8"),
  ]);
  assert.match(
    styles,
    /\.model-debug-request\.selected \.model-debug-request-meta,\s*\.model-debug-request\.selected \.model-debug-request-heading time,\s*\.model-debug-request:is\(:hover, \.selected\)\s+\.model-debug-request-integrity\[data-warning="true"\]\s*\{\s*color:\s*var\(--color-text-primary\);/u,
  );
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
