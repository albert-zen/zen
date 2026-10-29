import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const root = fileURLToPath(new URL("../", import.meta.url));
const directory = path.resolve(
  process.argv[2] ?? ".fullscreen-primary-chat-preview",
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
      entry: path.join(root, "scripts/fullscreen-primary-chat-preview.tsx"),
      name: "FullscreenPrimaryChatPreview",
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
  path.join(directory, "fullscreen-primary-chat.html"),
  `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'"><title>ZenX Fullscreen primary chat · synthetic component preview</title><style>${css}</style></head><body><div id="root"></div><script>${js.replaceAll("</script", "<\\/script")}</script></body></html>`,
);
const sources = [
  "src/renderer/src/auxiliary-panel.tsx",
  "src/renderer/src/App.tsx",
  "src/renderer/src/companion-workspace.tsx",
  "src/renderer/src/ThreadView.tsx",
  "src/renderer/src/bundled-automation-ui.tsx",
  "src/renderer/src/workspace-browser-panel.tsx",
  "src/renderer/src/InlineComposerEditor.tsx",
  "src/renderer/src/styles.css",
  "src/renderer/src/theme.css",
  "src/renderer/src/i18n/panels.ts",
  "scripts/fullscreen-primary-chat-preview.tsx",
  "scripts/fullscreen-primary-chat-preview.css",
  "scripts/build-fullscreen-primary-chat-preview.mjs",
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
        "Actual production AuxiliaryPanel, ThreadView, Composer and RoomsPage with synthetic in-memory conversations and browser mount ports. Browser page pixels are an explicitly synthetic DOM stand-in. No Host, Agent, native input, network or persistence; not native Electron acceptance.",
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
  `Fullscreen primary-chat evidence. Actual production AuxiliaryPanel, ThreadView, Composer and RoomsPage with synthetic in-memory conversation data. Browser pixels and lease receipts are simulated, not native Electron. No Host, Agent, network, private profile or persistence. Thread/Room owners, draft editing, side chat, reorder, fullscreen and same-page explicit selection are available. source.json identifies exact source hashes. CSP blocks networking. This fixture is not full App integration or full accessibility acceptance.
`,
);
console.log(`Built fullscreen primary-chat preview at ${directory}`);
