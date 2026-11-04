import { build as viteBuild } from "vite";
import { build as esbuild } from "esbuild";
import { mkdir, writeFile, copyFile, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const out = path.resolve(process.argv[2]);
await mkdir(out, { recursive: true });
const built = await viteBuild({
  configFile: false,
  root,
  logLevel: "warn",
  define: { "process.env.NODE_ENV": '"production"' },
  build: {
    write: false,
    minify: true,
    cssCodeSplit: false,
    lib: {
      entry: path.join(here, "fixture.tsx"),
      name: "OverlapEvidence",
      formats: ["iife"],
    },
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
});
for (const output of (Array.isArray(built) ? built[0] : built).output) {
  if (output.type === "chunk")
    await writeFile(path.join(out, "fixture.js"), output.code);
  else if (output.fileName.endsWith(".css"))
    await writeFile(path.join(out, "fixture.css"), output.source);
}
await writeFile(
  path.join(out, "index.html"),
  '<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'self\'; style-src \'self\'; img-src data:; font-src data:"><link rel="stylesheet" href="fixture.css"></head><body><div id="root"></div><script src="fixture.js"></script></body></html>',
);
await esbuild({
  entryPoints: [path.resolve(root, "src/main/workspace-browser-electron.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  packages: "external",
  outfile: path.join(out, "browser.cjs"),
});
for (const name of ["preload.cjs", "run.cjs", "run-host.cjs"])
  await copyFile(path.join(here, name), path.join(out, name));
const sources = [
  "src/main/workspace-browser.ts",
  "src/main/workspace-browser-renderer.ts",
  "src/main/workspace-browser-electron.ts",
  "src/renderer/src/ImagePresentation.tsx",
  "src/renderer/src/native-view-overlays.ts",
  "src/renderer/src/workspace-browser-panel.tsx",
  "src/renderer/src/styles.css",
  "src/renderer/src/theme.css",
];
await writeFile(
  path.join(out, "source.json"),
  JSON.stringify(
    {
      head: execFileSync("git", ["rev-parse", "HEAD"], {
        encoding: "utf8",
      }).trim(),
      productHead: "50e62a86c7067865b024bb79a7afb4e69abb2713",
      sources: Object.fromEntries(
        await Promise.all(
          sources.map(async (p) => [
            p,
            createHash("sha256")
              .update(await readFile(path.join(root, p)))
              .digest("hex"),
          ]),
        ),
      ),
    },
    null,
    2,
  ),
);
