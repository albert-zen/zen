import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const rendererRoot = fileURLToPath(
  new URL("../src/renderer/src/", import.meta.url),
);
const themePath = path.join(rendererRoot, "theme.css");
const rawColor = /#[0-9a-f]{3,8}\b|\b(?:rgb|rgba|hsl|hsla)\(/giu;
const definition = /(--[a-z0-9_-]+)\s*:/giu;
const consumption = /var\((--[a-z0-9_-]+)/giu;
const dynamicProductTokens = new Set(["--zenx-brand-asset"]);

test("renderer product styles keep raw colors in the single theme source", async () => {
  const files = await rendererProductFiles(rendererRoot);
  const violations: string[] = [];
  for (const file of files) {
    if (file === themePath) continue;
    const source = await readFile(file, "utf8");
    const matches = [...source.matchAll(rawColor)];
    if (matches.length > 0) {
      violations.push(
        `${path.relative(rendererRoot, file)}: ${matches.map((match) => match[0]).join(", ")}`,
      );
    }
  }
  assert.deepEqual(
    violations,
    [],
    "raw colors belong in theme.css; assets, plugin iframe documents, and fixtures are outside this product-style scan",
  );
});

test("every renderer product token is defined or an explicit component-owned seam", async () => {
  const files = await rendererProductFiles(rendererRoot);
  const sources = await Promise.all(
    files.map((file) => readFile(file, "utf8")),
  );
  const defined = new Set(
    sources.flatMap((source) =>
      [...source.matchAll(definition)].map((match) => match[1] ?? ""),
    ),
  );
  const used = new Set(
    sources.flatMap((source) =>
      [...source.matchAll(consumption)].map((match) => match[1] ?? ""),
    ),
  );
  const missing = [...used]
    .filter((token) => !defined.has(token) && !dynamicProductTokens.has(token))
    .sort();
  assert.deepEqual(missing, []);
});

test("Appearance v1 drives shell, sidebar, content, preview, and controls through canonical semantic roles", async () => {
  const styles = await readFile(path.join(rendererRoot, "styles.css"), "utf8");
  for (const expectation of [
    /\.app-shell\s*\{[^}]*background:\s*var\(--color-surface-main\)/su,
    /\.window-titlebar-product\s*\{[^}]*background:\s*var\(--color-surface-sidebar-active\)/su,
    /\.window-titlebar-session\s*\{[^}]*background:\s*var\(--color-surface-main\)/su,
    /\.sidebar\s*\{[^}]*background:\s*var\(--color-surface-sidebar-active\)/su,
    /\.workspace\s*\{[^}]*var\(--color-surface-main\)/su,
    /\.user-bubble\s*\{[^}]*background:\s*var\(--color-surface-elevated\)/su,
    /\.agent-copy\s*\{[^}]*color:\s*var\(--color-text-primary\)/su,
    /\.composer\s*\{[^}]*background:\s*var\(--color-surface\)/su,
    /\.primary-button\s*\{[^}]*background:\s*var\(--color-accent\)/su,
    /\.field input,[\s\S]*?background:\s*var\(--color-surface-code\)/u,
    /\.service-status-dot\.ready\s*\{[^}]*var\(--color-status-success\)/su,
    /\.appearance-preview-sidebar\s*\{[^}]*background:\s*var\(--color-surface-sidebar-active\)/su,
    /\.appearance-preview-content\s*\{[^}]*background:\s*var\(--color-surface-main\)/su,
  ]) {
    assert.match(styles, expectation);
  }
});

test("Appearance v1 has three presets per mode and root seams for every live control", async () => {
  const [theme, appearance, index] = await Promise.all([
    readFile(themePath, "utf8"),
    readFile(path.join(rendererRoot, "appearance.ts"), "utf8"),
    readFile(path.join(rendererRoot, "../index.html"), "utf8"),
  ]);
  for (const mode of ["light", "dark"]) {
    for (const preset of ["graphite", "cobalt", "ember"]) {
      assert.match(
        theme,
        new RegExp(
          `data-appearance="${mode}"[^}]*data-theme-preset="${preset}"|data-theme-preset="${preset}"[^}]*data-appearance="${mode}"`,
          "u",
        ),
        `${mode} ${preset} must have a production token mapping`,
      );
    }
  }
  for (const dataset of [
    "appearance",
    "themePreset",
    "accent",
    "contrast",
    "sidebarTranslucency",
  ]) {
    assert.match(appearance, new RegExp(`dataset\\.${dataset}\\s*=`, "u"));
  }
  for (const attribute of [
    "data-appearance",
    "data-theme-preset",
    "data-accent",
    "data-contrast",
    "data-sidebar-translucency",
  ]) {
    assert.match(index, new RegExp(attribute, "u"));
  }
});

test("the plugin marketplace visual harness loads theme tokens before product styles", async () => {
  const fixture = await readFile(
    new URL("./fixtures/plugin-marketplace-visual.tsx", import.meta.url),
    "utf8",
  );
  const themeImport = fixture.indexOf(
    'import "../../src/renderer/src/theme.css";',
  );
  const stylesImport = fixture.indexOf(
    'import "../../src/renderer/src/styles.css";',
  );
  assert.ok(themeImport >= 0, "visual harness must load theme.css");
  assert.ok(
    stylesImport > themeImport,
    "visual harness must match the production theme.css then styles.css order",
  );
});

async function rendererProductFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const location = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        return entry.name === "assets"
          ? []
          : await rendererProductFiles(location);
      }
      return /\.(?:css|tsx?)$/u.test(entry.name) ? [location] : [];
    }),
  );
  return files.flat().sort();
}
