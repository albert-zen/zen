/** Build a local synthetic document with production current-command and Terminal UI. */
import { build } from "vite";
import { mkdir, writeFile, copyFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const out = path.resolve(
  process.argv[2] ?? path.join(root, ".background-shell-preview"),
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
        "apps/zenx/test/fixtures/background-shell-visual.tsx",
      ),
      name: "BackgroundShellPreview",
      formats: ["iife"],
    },
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
});
const output = (Array.isArray(result) ? result[0] : result).output;
const js = output
  .filter((entry) => entry.type === "chunk")
  .map((entry) => entry.code)
  .join("\n");
const css = output
  .filter((entry) => entry.type === "asset" && entry.fileName.endsWith(".css"))
  .map((entry) => String(entry.source))
  .join("\n");
await mkdir(out, { recursive: true });
await writeFile(
  path.join(out, "background-shell-preview.html"),
  `<!doctype html><html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Background commands · synthetic production-component fixture</title><style>${css}</style><body style="margin:0"><div id="root"></div><script>${js.replaceAll("</script", "<\\/script")}</script></body></html>`,
);
await copyFile(
  path.join(root, "apps/zenx/src/renderer/public/terminal-frame.html"),
  path.join(out, "terminal-frame.html"),
);
console.log(out);
