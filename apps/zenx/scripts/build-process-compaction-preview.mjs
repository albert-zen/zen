import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const root = fileURLToPath(new URL("../", import.meta.url));
const directory = path.resolve(
  process.argv[2] ?? ".process-compaction-preview",
);
await mkdir(directory, { recursive: true });
const result = await build({
  configFile: false,
  root: path.resolve(root, "../.."),
  logLevel: "warn",
  define: { "process.env.NODE_ENV": '"production"' },
  build: {
    write: false,
    minify: true,
    cssCodeSplit: false,
    lib: {
      entry: path.join(root, "test/fixtures/process-compaction-visual.tsx"),
      name: "ProcessCompactionPreview",
      formats: ["iife"],
    },
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
});
const output = (Array.isArray(result) ? result[0] : result).output;
const js = output
  .filter((file) => file.type === "chunk")
  .map((file) => file.code)
  .join("\n");
const css = output
  .filter((file) => file.type === "asset" && file.fileName.endsWith(".css"))
  .map((file) => String(file.source))
  .join("\n");
assert.ok(js && css, "Complete production component and stylesheet output");
assert.ok(
  !output.some(
    (file) => file.type === "asset" && !file.fileName.endsWith(".css"),
  ),
  "Preview must be a self-contained HTML file",
);
await writeFile(
  path.join(directory, "process-compaction.html"),
  `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'"><title>ZenX compaction capsules · synthetic production components</title><style>${css}</style></head><body><div id="root"></div><script>${js.replaceAll("</script", "<\\/script")}</script></body></html>`,
);
const sources = [
  "src/renderer/src/ThreadView.tsx",
  "src/renderer/src/ContextCompactionEvent.tsx",
  "src/renderer/src/OriginalHistory.tsx",
  "src/renderer/src/trace-action-summary.ts",
  "src/renderer/src/tool-presentation.ts",
  "src/renderer/src/turn-projection.ts",
  "src/renderer/src/i18n/shell.ts",
  "test/fixtures/agent-runtime-data.ts",
  "src/renderer/src/styles.css",
  "src/renderer/src/theme.css",
  "src/renderer/src/context-compaction-projection.ts",
  "test/fixtures/process-compaction-visual.tsx",
  "scripts/build-process-compaction-preview.mjs",
  "scripts/capture-process-compaction-preview.mjs",
];
await writeFile(
  path.join(directory, "source.json"),
  JSON.stringify(
    {
      commit: execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: root,
        encoding: "utf8",
      }).trim(),
      artifactSha256: createHash("sha256")
        .update(await readFile(path.join(directory, "process-compaction.html")))
        .digest("hex"),
      trackedDirty: execFileSync("git", ["diff", "--name-only", "HEAD"], {
        cwd: root,
        encoding: "utf8",
      }).trim(),
      scope:
        "Production ThreadView and styles; synthetic process actions and compaction records plus exact-scope original-history port. No Host, user profile, network, or native Electron acceptance.",
      sources: Object.fromEntries(
        await Promise.all(
          sources.map(async (source) => [
            source,
            createHash("sha256")
              .update(await readFile(path.join(root, source)))
              .digest("hex"),
          ]),
        ),
      ),
    },
    null,
    2,
  ) + "\n",
);
