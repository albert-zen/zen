/** Build-only fixture: production ThreadView/CSS, no browser or network launch. */
import assert from "node:assert/strict";
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
assert.equal(
  git(["diff", "--name-only", "HEAD", "--", "apps/zenx/src"]),
  "",
  "Production source must match the checked-out HEAD",
);
await mkdir(directory, { recursive: true });
const result = await build({
  configFile: false,
  root,
  logLevel: "warn",
  define: {
    "process.env.NODE_ENV": '"production"',
    __IMAGE_PREPARATION_SOURCE__: JSON.stringify({
      commit: sourceCommit,
      tree: sourceTree,
    }),
  },
  build: {
    write: false,
    minify: true,
    cssCodeSplit: false,
    lib: {
      entry: path.join(
        root,
        "apps/zenx/test/fixtures/image-preparation-visual.tsx",
      ),
      name: "ImagePreparationPreview",
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
const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'"><title>ZenX image preparation · synthetic production ThreadView</title><style>${css}</style></head><body><div id="root"></div><script>${js.replaceAll("</script", "<\\/script")}</script></body></html>`;
await writeFile(path.join(directory, "image-preparation.html"), html);
for (const [name, width, height, lang, theme] of [
  ["desktop-en-light", 1100, 820, "en", "light"],
  ["narrow-zh-dark", 390, 600, "zh-CN", "dark"],
  ["desktop-zh-dark", 1100, 820, "zh-CN", "dark"],
  ["narrow-en-light", 390, 600, "en", "light"],
]) {
  await writeFile(
    path.join(directory, `${name}.html`),
    `<!doctype html><html><head><meta charset="utf-8"><title>Synthetic ThreadView · ${name}</title><style>body{margin:0;padding:12px;background:#ddd;color:#222;font:12px system-ui}iframe{display:block;border:1px solid #999}p{margin:0 0 8px}</style></head><body><p>Actual production ThreadView in ${width} × ${height} CSS viewport. Synthetic ItemList only. Not the full App or a native platform acceptance.</p><iframe title="Synthetic production ThreadView" src="./image-preparation.html?lang=${lang}&theme=${theme}" width="${width}" height="${height}"></iframe></body></html>`,
  );
}
const sources = [
  "apps/zenx/src/renderer/src/ThreadView.tsx",
  "apps/zenx/src/renderer/src/ImagePreparationNotice.tsx",
  "apps/zenx/src/renderer/src/image-preparation-projection.ts",
  "apps/zenx/src/renderer/src/styles.css",
  "apps/zenx/src/renderer/src/theme.css",
  "apps/zenx/src/renderer/src/i18n/shell.ts",
  "apps/zenx/test/fixtures/image-preparation-visual.tsx",
  "apps/zenx/scripts/build-image-preparation-preview.mjs",
  "apps/zenx/scripts/capture-image-preparation-preview.mjs",
  "apps/zenx/test/image-preparation-preview.test.mjs",
  ".github/workflows/ci.yml",
];
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
await writeFile(
  path.join(directory, "source.json"),
  JSON.stringify(
    {
      sourceCommit,
      sourceTree,
      synthetic: true,
      scope:
        "Production ThreadView, ImagePreparationNotice/projection and CSS in browser. Synthetic ItemList snapshots and fixture navigation only. Not full App, native Host, packaged, physical macOS or Windows acceptance. No user data or image payloads.",
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
