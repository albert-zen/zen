import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const directory = path.resolve(process.argv[2] ?? ".imzenx-status-preview");
await mkdir(directory, { recursive: true });
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
      entry: path.join(root, "apps/zenx/scripts/imzenx-status-preview.tsx"),
      name: "ImConnectionPreview",
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
assert.ok(js && css);
assert.ok(
  !output.some(
    (file) => file.type === "asset" && !file.fileName.endsWith(".css"),
  ),
  "Self-contained component preview",
);
await writeFile(
  path.join(directory, "imzenx.html"),
  `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'"><title>IMZenX 合成状态验收</title><style>${css}</style></head><body><div id="root"></div><script>${js.replaceAll("</script", "<\\/script")}</script></body></html>`,
);
const sources = [
  "apps/zenx/src/renderer/src/imzenx-ui.tsx",
  "apps/zenx/src/renderer/src/i18n/panels.ts",
  "apps/zenx/src/renderer/src/styles.css",
  "apps/zenx/src/renderer/src/theme.css",
  "apps/zenx/scripts/imzenx-status-preview.tsx",
  "apps/zenx/scripts/build-imzenx-status-preview.mjs",
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
        "Actual production ImZenXPage, shared controls, translations and CSS; synthetic SDK status/command responses only. No Host, private profile, credentials or real channel connection. Browser UI capture does not prove real QQ delivery.",
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
console.log(`Built ${path.join(directory, "imzenx.html")}`);
