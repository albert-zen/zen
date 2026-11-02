import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const root = fileURLToPath(new URL("../", import.meta.url));
const directory = path.resolve(
  process.argv[2] ?? ".canonical-input-title-preview",
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
      entry: path.join(root, "test/fixtures/canonical-input-title-visual.tsx"),
      name: "CanonicalInputTitlePreview",
      formats: ["es"],
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
assert(js && css, "Complete production Sidebar and styles");
await writeFile(
  path.join(directory, "naming.html"),
  `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'"><title>Canonical first input · synthetic Sidebar</title><style>${css}</style></head><body><div id="root"></div><script type="module">${js.replaceAll("</script", "<\\/script")}</script></body></html>`,
);
const sources = [
  "../../src/item.ts",
  "src/renderer/src/Sidebar.tsx",
  "src/renderer/src/thread-list.ts",
  "src/renderer/src/styles.css",
  "src/renderer/src/theme.css",
  "test/fixtures/canonical-input-title-visual.tsx",
  "scripts/build-canonical-input-title-preview.mjs",
  "scripts/capture-canonical-input-title-preview.mjs",
];
await writeFile(
  path.join(directory, "source.json"),
  JSON.stringify(
    {
      commit: execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: root,
        encoding: "utf8",
      }).trim(),
      scope:
        "Production Sidebar component visual verification with synthetic canonical inputs and seeded generated/manual title states. No Host, Provider, user profile or user device. This is not complete-App first-input end-to-end acceptance; real protocol/manager/naming tests are separate.",
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
