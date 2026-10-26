import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const root = fileURLToPath(new URL("../", import.meta.url));
const directory = path.resolve(process.argv[2] ?? ".sidebar-state-preview");
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
      entry: path.join(root, "scripts/sidebar-state-preview.tsx"),
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
  path.join(directory, "sidebar-state.html"),
  `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'"><title>ZenX Thread and Room sidebar state · synthetic component preview</title><style>${css}</style></head><body><div id="root"></div><script>${js.replaceAll("</script", "<\\/script")}</script></body></html>`,
);
const sources = [
  "src/renderer/src/SourceEditor.tsx",
  "src/renderer/src/InlineMarkdownEditor.tsx",
  "src/renderer/src/workspace-file-viewport.ts",
  "src/renderer/src/workspace-file-drafts.ts",
  "src/thread-sidebar-state.ts",
  "src/renderer/src/auxiliary-panel.tsx",
  "src/renderer/src/use-thread-sidebar.ts",
  "src/renderer/src/thread-sidebar-controller.ts",
  "src/renderer/src/workspace-files-panel.tsx",
  "src/renderer/src/styles.css",
  "scripts/sidebar-state-preview.tsx",
  "scripts/build-sidebar-state-preview.mjs",
  "scripts/capture-sidebar-state-preview.mjs",
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
        "Actual AuxiliaryPanel and shared renderer state controller with production styles. Synthetic state port and files only; no production Host, local computer, private files or profile. Full App and trusted-tool routing are separately covered by tests; screenshots are component evidence, not native Electron acceptance.",
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
await writeFile(
  path.join(directory, "README.txt"),
  `ZenX Thread and Room sidebar: actual-component synthetic preview

Open sidebar-state.html in a browser. Use ?lang=zh-CN and ?theme=light.
The self-contained HTML blocks networking through its content security policy.

Production: AuxiliaryPanel, shared sidebar controller/reducer, file panel,
CodeMirror, translations and theme/styles. Synthetic: in-memory state and file
ports, demonstration Thread/Room selectors, and outer main-area scaffold.
No native Electron, Host, private files, credentials or user profile is used.

Acceptance: update Thread A while Thread B stays visible with no resource read;
select A to render its saved open/file state; display shared Room tabs
with distinct member-owned README files. evidence.json records owner state and
resource calls. source.json records the commit and production source hashes.
Full App, trusted tool scope, durable store and native service routing are tested
separately. These screenshots are component evidence, not native OS acceptance.
CI uses existing Chrome and fonts-noto-cjk with the browser sandbox enabled.
No browser is downloaded; missing Chrome or CJK font support fails explicitly.

`,
);
console.log(
  `Built self-contained Thread and Room sidebar state preview at ${directory}`,
);
