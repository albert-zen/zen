/** Production components; instrumentation is confined to this synthetic bundle. */
import { build } from "vite";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  instrument,
  SCHEMA_VERSION,
} from "../evals/ux-performance/metrics.mjs";
const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
if (!process.argv[2])
  throw Error("Pass an output directory outside the source checkout");
const out = path.resolve(process.argv[2]);
const git = (...args) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const result = await build({
  configFile: false,
  root,
  logLevel: "warn",
  define: { "process.env.NODE_ENV": '"production"' },
  plugins: [
    { name: "synthetic-work-counters", enforce: "pre", transform: instrument },
  ],
  build: {
    write: false,
    minify: true,
    cssCodeSplit: false,
    lib: {
      entry: path.join(root, "apps/zenx/evals/ux-performance/fixture.tsx"),
      name: "UxPerformance",
      formats: ["iife"],
    },
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
});
const outputs = (Array.isArray(result) ? result[0] : result).output;
const js = outputs
  .filter((x) => x.type === "chunk")
  .map((x) => x.code)
  .join("\n");
const css = outputs
  .filter((x) => x.type === "asset" && x.fileName.endsWith(".css"))
  .map((x) => String(x.source))
  .join("\n");
if (!js || !css) throw Error("Missing production bundle");
const hook =
  "window.__uxCounts={markdown:0,thread:0,commits:0};window.__REACT_DEVTOOLS_GLOBAL_HOOK__={supportsFiber:true,inject:()=>1,onCommitFiberRoot:()=>window.__uxCounts.commits++,onCommitFiberUnmount:()=>{},onPostCommitFiberRoot:()=>{}};";
const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Synthetic UX CPU/paint-opportunity measurements</title><style>${css}</style><body><div id="root"></div><script>${hook}</script><script>${js.replaceAll("</script", "<\\/script")}</script></body></html>`;
await mkdir(out, { recursive: true });
await writeFile(path.join(out, "ux-performance.html"), html);
await writeFile(
  path.join(out, "build.json"),
  JSON.stringify(
    {
      schemaVersion: SCHEMA_VERSION,
      sourceSha: git("rev-parse", "HEAD"),
      sourceDirty:
        git(
          "status",
          "--porcelain",
          "--untracked-files=normal",
          "--",
          ".",
          ":(exclude)node_modules",
          ":(exclude)apps/zenx/node_modules",
        ) !== "",
      production: true,
      synthetic: true,
      instrumented: true,
      htmlSha256: createHash("sha256").update(html).digest("hex"),
      node: process.version,
    },
    null,
    2,
  ),
);
console.log(out);
