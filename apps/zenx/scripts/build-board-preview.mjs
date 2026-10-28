import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const root = fileURLToPath(new URL("../", import.meta.url));
const directory = path.resolve(process.argv[2] ?? ".board-preview");
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
      entry: path.join(root, "scripts/board-preview.tsx"),
      name: "SidebarStatePreview",
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
  path.join(directory, "board.html"),
  `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; frame-src 'self'"><title>ZenX interactive information Board · synthetic component preview</title><style>${css}</style></head><body><div id="root"></div><script>${js.replaceAll("</script", "<\\/script")}</script></body></html>`,
);
const sources = [
  "src/renderer/src/board-ui.tsx",
  "src/renderer/src/board-ui-state.ts",
  "src/renderer/src/plugin-information-host.tsx",
  "src/renderer/src/plugin-ui-host.tsx",
  "src/renderer/src/styles.css",
  "scripts/board-preview.tsx",
  "scripts/build-board-preview.mjs",
  "scripts/capture-board-preview.mjs",
];
await writeFile(
  path.join(directory, "plugin-frame.html"),
  await readFile(path.join(root, "src/renderer/public/plugin-frame.html")),
);

await writeFile(
  path.join(directory, "source.json"),
  JSON.stringify(
    {
      commit: execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: root,
        encoding: "utf8",
      }).trim(),
      scope:
        "Actual production Board/information/isolated-frame components with synthetic state/effect ports and outer chat scaffold. No native Electron, private data, model calls or API calls. Source hashes bind screenshots to code.",
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
console.log(`Built synthetic Board component preview at ${directory}`);
