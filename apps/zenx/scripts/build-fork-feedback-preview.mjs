/** Self-contained production-component fixture; build only, no browser or network. */
import { build } from "vite";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const out = path.resolve(
  process.argv[2] ?? path.join(root, ".fork-feedback-preview"),
);
const result = await build({
  configFile: false,
  root,
  logLevel: "warn",
  define: { "process.env.NODE_ENV": '"production"' },
  build: {
    write: false,
    minify: true,
    cssCodeSplit: false,
    lib: {
      entry: path.join(
        root,
        "apps/zenx/test/fixtures/fork-feedback-visual.tsx",
      ),
      name: "ForkFeedbackPreview",
      formats: ["iife"],
    },
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
});
const output = (Array.isArray(result) ? result[0] : result).output;
const js = output
  .filter((item) => item.type === "chunk")
  .map((item) => item.code)
  .join("\n");
const css = output
  .filter((item) => item.type === "asset" && item.fileName.endsWith(".css"))
  .map((item) => String(item.source))
  .join("\n");
if (!js || !css) throw Error("Missing production assets");
await mkdir(out, { recursive: true });
await writeFile(
  path.join(out, "fork-feedback-preview.html"),
  `<!doctype html><html lang="en" data-appearance="light"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ZenX fork feedback · synthetic</title><style>${css}</style><body><div id="root"></div><script>${js.replaceAll("</script", "<\\/script")}</script></body></html>`,
);
console.log(path.join(out, "fork-feedback-preview.html"));
