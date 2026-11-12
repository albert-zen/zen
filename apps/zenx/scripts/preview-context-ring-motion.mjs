import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const entry = resolve(root, "test/fixtures/context-ring-motion.tsx");
const motionFile = resolve(root, "src/renderer/src/ContextUsageIndicator.css");
const assetInputs = new Set();
// esbuild IIFE output has no import.meta.url. Preserve real static image assets
// as data URLs rather than booting imported production modules with invalid URLs.
const inlineAssetUrls = {
  name: "inline-static-production-image-urls",
  setup(builder) {
    builder.onLoad(
      { filter: /(?:ProviderLogo|ZenXBrand)\.tsx$/ },
      async ({ path }) => {
        let contents = await readFile(path, "utf8");
        const pattern =
          /new URL\(\s*(["'])(\.\/assets\/[^"']+)\1,\s*import\.meta\.url,?\s*\)\s*\.href/g;
        for (const match of [...contents.matchAll(pattern)]) {
          const asset = resolve(path, "..", match[2]);
          const mime = asset.endsWith(".svg")
            ? "image/svg+xml"
            : asset.endsWith(".png")
              ? "image/png"
              : "image/x-icon";
          assetInputs.add(asset);
          const data = (await readFile(asset)).toString("base64");
          contents = contents.replace(
            match[0],
            JSON.stringify(`data:${mime};base64,${data}`),
          );
        }
        return { contents, loader: "tsx" };
      },
    );
  },
};
const after = await build({
  entryPoints: [entry],
  outfile: "context-ring-motion.js",
  bundle: true,
  write: false,
  format: "iife",
  target: "es2022",
  jsx: "automatic",
  minify: true,
  define: { "process.env.NODE_ENV": '"production"' },
  metafile: true,
  plugins: [inlineAssetUrls],
});
const before = await build({
  entryPoints: [entry],
  outfile: "context-ring-motion.js",
  bundle: true,
  write: false,
  format: "iife",
  target: "es2022",
  jsx: "automatic",
  minify: true,
  define: { "process.env.NODE_ENV": '"production"' },
  plugins: [
    inlineAssetUrls,
    {
      name: "omit-only-context-motion-for-baseline",
      setup(builder) {
        builder.onLoad({ filter: /ContextUsageIndicator\.css$/ }, () => ({
          contents: "",
          loader: "css",
        }));
      },
    },
  ],
});
const inputs = await Promise.all(
  [...Object.keys(after.metafile.inputs), ...assetInputs]
    .sort()
    .map(async (file) => [file, await readFile(file)]),
);
const sha256 = createHash("sha256");
for (const [file, bytes] of inputs) sha256.update(file).update(bytes);
const sourceHash = sha256.digest("hex");
const frameCss = `
html,body,#root { margin:0; width:100%; height:100%; overflow:hidden }
.motion-preview-page { display:flex; flex-direction:column; height:100%; padding:20px; box-sizing:border-box; background:var(--color-surface-main); color:var(--color-text-primary) }
.motion-preview-page header,.motion-preview-page footer { flex:none }
.motion-preview-page h2 { margin:0 0 8px;font-size:20px }
.motion-preview-page p { font-size:12px;line-height:1.5;color:var(--color-text-secondary) }
.motion-preview-options { display:flex; flex-wrap:wrap;gap:6px }
.motion-preview-options button { border:1px solid var(--color-border);border-radius:6px;padding:6px;background:var(--color-surface);color:inherit;font-size:12px }
.motion-preview-stage { min-height:360px; flex:1;display:flex;align-items:flex-end;padding:16px 0 }
.motion-preview-stage[data-placement="below"] { position:absolute;left:20px;right:20px;top:0;min-height:0;align-items:flex-start;padding-top:8px }
.motion-preview-page:has(.motion-preview-stage[data-placement="below"]) header { padding-top:116px }
.motion-preview-controls.composer { width:100%; margin:0;display:flex;justify-content:space-between;padding:12px;overflow:visible }
.motion-preview-controls > div { display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px }
.motion-preview-controls > div > span { font-size:11px;color:var(--color-text-muted) }
.motion-preview-page output { font-size:12px;color:var(--color-text-accent) }
`;
function frame(result, variant) {
  const script = result.outputFiles
    .find((file) => file.path.endsWith(".js"))
    .text.replaceAll("</script", "<\\/script");
  const css = result.outputFiles.find((file) =>
    file.path.endsWith(".css"),
  ).text;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}\n${frameCss}</style></head><body data-variant="${variant}"><div id="root"></div><script>${script}</script></body></html>`;
}
// srcdoc keeps both frames independent (including portal styles and focus),
// while bundling every dependency lets the HTML open without a dev server.
const frames = JSON.stringify([
  frame(before, "before"),
  frame(after, "after"),
]).replaceAll("<", "\\u003c");
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="zenx-preview-source-sha256" content="${sourceHash}">
<title>ZenX context ring motion comparison</title><style>
body{margin:0;padding:24px;font-family:system-ui;background:#edf0f5;color:#182235}h1{margin:0 0 8px;font-size:22px}p{font-size:13px;line-height:1.5}main{display:grid;grid-template-columns:1fr 1fr;gap:16px}iframe{box-sizing:border-box;width:100%;height:680px;border:1px solid #c9d0dd;border-radius:16px;background:white}small{display:block;margin:16px 0;font-size:11px;color:#526078;overflow-wrap:anywhere}@media(max-width:780px){body{padding:12px}main{grid-template-columns:1fr}}
</style></head><body><h1>Context ring vs. Send</h1><p>Both sides run the actual production controls. Before omits only the new context motion stylesheet; Send is identical. No account or host actions are connected.</p><main><iframe title="Before context motion"></iframe><iframe title="After context motion"></iframe></main><small>Source SHA-256: ${sourceHash}</small><script>const frames=${frames};document.querySelectorAll("iframe").forEach((frame,index)=>frame.srcdoc=frames[index]);</script></body></html>`;
const destination = resolve(
  process.argv[2] ?? "context-ring-motion-preview.html",
);
await writeFile(destination, html);
console.log(
  JSON.stringify({
    destination,
    sourceHash,
    motionFile,
    bytes: Buffer.byteLength(html),
    inputs: inputs.length,
  }),
);
