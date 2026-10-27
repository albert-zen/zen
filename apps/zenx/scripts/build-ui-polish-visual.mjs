import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const appRoot = fileURLToPath(new URL("../", import.meta.url));
const repoRoot = path.resolve(appRoot, "../..");
const fixtureRoot = path.join(appRoot, "test/fixtures");
const outputDirectory = path.resolve(process.argv[2] ?? ".ui-polish-visual");
await mkdir(outputDirectory, { recursive: true });

const result = await build({
  configFile: false,
  root: repoRoot,
  logLevel: "warn",
  define: { "process.env.NODE_ENV": '"production"' },
  build: {
    write: false,
    minify: true,
    cssCodeSplit: false,
    lib: {
      entry: path.join(fixtureRoot, "ui-polish-visual.tsx"),
      name: "ZenXUiPolishVisual",
      formats: ["iife"],
    },
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
});
const output = (Array.isArray(result) ? result[0] : result).output;
const javascript = output
  .filter((file) => file.type === "chunk")
  .map((file) => file.code)
  .join("\n");
const css = output
  .filter((file) => file.type === "asset" && file.fileName.endsWith(".css"))
  .map((file) => String(file.source))
  .join("\n");
assert.ok(javascript && css, "Bundle the actual production components/styles");
assert.ok(
  !output.some(
    (file) => file.type === "asset" && !file.fileName.endsWith(".css"),
  ),
  "The fixture must be self-contained; no external asset requests",
);

const template = await readFile(
  path.join(fixtureRoot, "ui-polish-visual.html"),
  "utf8",
);
assert.equal(template.split("__ZENX_PREVIEW_CSS__").length, 2);
assert.equal(template.split("__ZENX_PREVIEW_SCRIPT__").length, 2);
const html = template
  // Replacement callbacks preserve CSS/JS `$&`, `$'` and `$`` byte-for-byte.
  .replace("__ZENX_PREVIEW_CSS__", () => css)
  .replace("__ZENX_PREVIEW_SCRIPT__", () =>
    javascript.replace(/<\/script/giu, "<\\/script"),
  );
await writeFile(path.join(outputDirectory, "ui-polish-visual.html"), html);

const sources = [
  "scripts/build-ui-polish-visual.mjs",
  "scripts/capture-ui-polish-visual.mjs",
  "scripts/preview-browser.mjs",
  "scripts/preview-browser-lifecycle.mjs",
  "src/renderer/src/App.tsx",
  "src/renderer/src/auxiliary-panel.tsx",
  "src/renderer/src/FleetComposerSurface.tsx",
  "src/renderer/src/ThreadView.tsx",
  "src/renderer/src/Sidebar.tsx",
  "src/renderer/src/auxiliary-tab-reorder.css",
  "src/renderer/src/fleet-ui.css",
  "src/renderer/src/icons.tsx",
  "src/renderer/src/styles.css",
  "src/renderer/src/theme.css",
  "test/fixtures/ui-polish-visual.tsx",
  "test/fixtures/ui-polish-visual.html",
];
const sourceHashes = Object.fromEntries(
  await Promise.all(
    sources.map(async (source) => [
      source,
      createHash("sha256")
        .update(await readFile(path.join(appRoot, source)))
        .digest("hex"),
    ]),
  ),
);
await writeFile(
  path.join(outputDirectory, "source.json"),
  JSON.stringify(
    {
      commit: execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: repoRoot,
        encoding: "utf8",
      }).trim(),
      dirtyFiles: execFileSync("git", ["status", "--porcelain"], {
        cwd: repoRoot,
        encoding: "utf8",
      })
        .trim()
        .split("\n")
        .filter(Boolean),
      scope:
        "Production App welcome/Project selector/Fleet machine selector and AuxiliaryPanel. All app bridge facts and tab contents are synthetic. CSP blocks all network connections. No user profile, real Host, filesystem, model or native desktop action.",
      artifact: {
        html: "ui-polish-visual.html",
        htmlSha256: createHash("sha256").update(html).digest("hex"),
      },
      sources: sourceHashes,
    },
    null,
    2,
  ) + "\n",
);
console.log(
  `Built synthetic UI polish preview at ${path.join(outputDirectory, "ui-polish-visual.html")}`,
);
