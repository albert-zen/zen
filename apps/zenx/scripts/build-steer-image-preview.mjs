/** Build-only fixture: production ThreadView/CSS, no browser or network launch. */
import assert from "node:assert/strict";
import { instrumentSteerReader } from "./steer-scroll-diagnostic.mjs";
const diagnostic = process.argv.includes("--diagnostic");
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
const root = fileURLToPath(new URL("../../../", import.meta.url));
const directory = path.resolve(process.argv[2]);
const git = (args) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const sourceCommit = git(["rev-parse", "HEAD"]);
const sourceTree = git(["rev-parse", "HEAD^{tree}"]);
await mkdir(directory, { recursive: true });
const result = await build({
  configFile: false,
  plugins: diagnostic
    ? [
        {
          name: "synthetic-steer-reader-observation",
          enforce: "pre",
          transform(source, id) {
            if (id.endsWith("/ThreadView.tsx"))
              return instrumentSteerReader(source);
          },
        },
      ]
    : [],
  root,
  logLevel: "warn",
  define: {
    "process.env.NODE_ENV": '"production"',
    __PENDING_IMAGE_SOURCE__: JSON.stringify({
      commit: sourceCommit,
      tree: sourceTree,
    }),
  },
  build: {
    write: false,
    minify: !diagnostic,
    cssCodeSplit: false,
    lib: {
      entry: path.join(root, "apps/zenx/test/fixtures/steer-image-visual.tsx"),
      name: "SteerImagePreview",
      formats: ["iife"],
    },
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
});
const output = (Array.isArray(result) ? result[0] : result).output;
const js = output
  .filter((f) => f.type === "chunk")
  .map((f) => f.code)
  .join("\n");
const css = output
  .filter((f) => f.type === "asset" && f.fileName.endsWith(".css"))
  .map((f) => String(f.source))
  .join("\n");
assert.ok(js && css);
const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'"><title>ZenX pending steer preview · synthetic production ThreadView</title><style>${css}</style></head><body><div id="root"></div><script>${js.replaceAll("</script", "<\\/script")}</script></body></html>`;
await writeFile(path.join(directory, "steer-image.html"), html);
const sources = [
  "apps/zenx/src/renderer/src/ThreadView.tsx",
  "apps/zenx/src/renderer/src/ExperimentalTranscriptViewport.tsx",
  "apps/zenx/src/renderer/src/transcript-viewport-pins.ts",
  "apps/zenx/patches/legend-list-3.3.5-react.patch",
  "apps/zenx/scripts/prepare-legend-list.mjs",
  "apps/zenx/src/renderer/src/PendingSteerPanel.tsx",
  "apps/zenx/src/renderer/src/steer-preview-column.ts",
  "apps/zenx/src/renderer/src/queued-messages.css",
  "apps/zenx/src/renderer/src/ImagePresentation.tsx",
  "apps/zenx/src/renderer/src/styles.css",
  "apps/zenx/src/renderer/src/theme.css",
  "apps/zenx/test/fixtures/steer-image-visual.tsx",
  "apps/zenx/scripts/build-steer-image-preview.mjs",
  "apps/zenx/scripts/capture-steer-image-preview.mjs",
  "apps/zenx/scripts/steer-image-visibility.mjs",
  "apps/zenx/scripts/steer-image-geometry.mjs",
  "apps/zenx/scripts/steer-scroll-diagnostic.mjs",
];
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
await writeFile(
  path.join(directory, "source.json"),
  JSON.stringify(
    {
      sourceCommit,
      sourceTree,
      diagnostic,
      workingTreeDiffSha256: sha(git(["diff", "HEAD", "--", "apps/zenx/src"])),
      synthetic: true,
      scope:
        "Production ThreadView and PendingSteerPanel with generated synthetic PNGs and synthetic canonical/pending facts. Not full App, native Host, provider, packaged or platform acceptance. Working tree source hashes are authoritative, not HEAD alone.",
      bundleSha256: sha(html),
      javascriptSha256: sha(js),
      cssSha256: sha(css),
      sources: Object.fromEntries(
        await Promise.all(
          sources.map(async (file) => [
            file,
            sha(await readFile(path.join(root, file))),
          ]),
        ),
      ),
    },
    null,
    2,
  ) + "\n",
);
console.log(path.join(directory, "source.json"));
