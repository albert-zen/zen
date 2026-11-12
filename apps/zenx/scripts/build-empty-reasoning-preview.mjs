import { build } from "vite";
import { writeFile, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../../../", import.meta.url));
const out = path.resolve(process.argv[2] ?? ".empty-reasoning-preview");
await (await import("node:fs/promises")).mkdir(out, { recursive: true });
const result = await build({
  configFile: false,
  root,
  logLevel: "warn",
  define: { "process.env.NODE_ENV": '"production"' },
  build: {
    write: false,
    minify: true,
    cssCodeSplit: false,
    target: "esnext",
    lib: {
      entry: path.join(
        root,
        "apps/zenx/test/fixtures/empty-reasoning-visual.tsx",
      ),
      name: "EmptyReasoningPreview",
      formats: ["es"],
    },
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
});
const files = (Array.isArray(result) ? result[0] : result).output;
const js = files
  .filter((x) => x.type === "chunk")
  .map((x) => x.code)
  .join("\n");
const css = files
  .filter((x) => x.type === "asset" && x.fileName.endsWith(".css"))
  .map((x) => x.source)
  .join("\n");
await writeFile(
  out + "/empty-reasoning.html",
  `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ZenX empty public reasoning synthetic QA</title><style>${css}</style></head><body><div id="root"></div><script type="module">${js.replaceAll("</script", "<\\/script")}</script></body></html>`,
);
const sources = [
  "apps/zenx/src/renderer/src/ThreadView.tsx",
  "apps/zenx/src/renderer/src/turn-projection.ts",
  "apps/zenx/src/renderer/src/thread-view-state.ts",
  "apps/zenx/src/renderer/src/styles.css",
  "apps/zenx/test/fixtures/empty-reasoning-visual.tsx",
  "apps/zenx/test/fixtures/empty-reasoning-scenario.ts",
  "apps/zenx/scripts/capture-empty-reasoning-preview.mjs",
];
await writeFile(
  out + "/source-manifest.json",
  JSON.stringify(
    {
      commit: execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: root,
        encoding: "utf8",
      }).trim(),
      syntheticData: true,
      privateInputsIncluded: false,
      scope:
        "Production ThreadView and native event projection in Chromium, not native Electron or live provider acceptance",
      sources: Object.fromEntries(
        await Promise.all(
          sources.map(async (p) => [
            p,
            createHash("sha256")
              .update(await readFile(root + "/" + p))
              .digest("hex"),
          ]),
        ),
      ),
    },
    null,
    2,
  ),
);
