import { build } from "vite";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
const root = resolve(import.meta.dirname, "../../..");
const out = resolve(process.argv[2] ?? "/tmp/zen-app-shot-preview");
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
      entry: resolve(root, "apps/zenx/test/fixtures/app-shot-visual.tsx"),
      name: "AppShotPreview",
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
await mkdir(out, { recursive: true });
const license = await readFile(
  resolve(root, "apps/zenx/src/app-shot-key-chord.LICENSE"),
  "utf8",
);
await writeFile(
  resolve(out, "app-shot.html"),
  `<!doctype html><!--${license}--><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>App Shot · synthetic acceptance</title><style>${css}</style><body><div id="root"></div><script>${js.replaceAll("</script", "<\\/script")}</script></body></html>`,
);
console.log(out);
