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

test("the v0 shell slice consumes canonical semantic color roles", async () => {
  const styles = await readFile(path.join(rendererRoot, "styles.css"), "utf8");
  for (const expectation of [
    /\.app-shell\s*\{[^}]*background:\s*var\(--color-surface-main\)/su,
    /\.window-titlebar-product\s*\{[^}]*background:\s*var\(--color-surface-sidebar\)/su,
    /\.window-titlebar-session\s*\{[^}]*background:\s*var\(--color-surface-main\)/su,
    /\.sidebar\s*\{[^}]*background:\s*var\(--color-surface-sidebar\)/su,
    /\.workspace\s*\{[^}]*var\(--color-surface-main\)/su,
    /\.user-bubble\s*\{[^}]*background:\s*var\(--color-surface-elevated\)/su,
    /\.agent-copy\s*\{[^}]*color:\s*var\(--color-text-primary\)/su,
    /\.composer\s*\{[^}]*background:\s*var\(--color-surface\)/su,
    /\.primary-button\s*\{[^}]*background:\s*var\(--color-accent\)/su,
    /\.field input,[\s\S]*?background:\s*var\(--color-surface-code\)/u,
    /\.service-status-dot\.ready\s*\{[^}]*var\(--color-status-success\)/su,
  ]) {
    assert.match(styles, expectation);
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
