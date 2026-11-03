import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const root = fileURLToPath(new URL("../", import.meta.url));
const directory = path.resolve(
  process.argv[2] ?? ".information-layout-preview",
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
      entry: path.join(root, "scripts/information-layout-preview.tsx"),
      name: "EditableInformationPreview",
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
  path.join(directory, "information.html"),
  `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; frame-src 'self'"><title>ZenX editable information layout · synthetic component preview</title><style>${css}</style></head><body><div id="root"></div><script>${js.replaceAll("<script", "\\x3cscript").replaceAll("</script", "<\\/script").replaceAll("<!--", "\\x3c!--")}</script></body></html>`,
);
// External script entry avoids live-preview servers injecting reload markup into
// isolated-document HTML strings inside the bundled JavaScript.
await writeFile(path.join(directory, "information.js"), js);
const inline = await readFile(path.join(directory, "information.html"), "utf8");
const scriptStart = inline.indexOf("<script>");
const scriptEnd = inline.lastIndexOf("</script>");
await writeFile(
  path.join(directory, "index.html"),
  (
    inline.slice(0, scriptStart) +
    '<script src="./information.js"></script>' +
    inline.slice(scriptEnd + 9)
  ).replace("script-src 'unsafe-inline'", "script-src 'self' 'unsafe-inline'"),
);
const sources = [
  "src/renderer/src/EditableInformationPanel.tsx",
  "src/renderer/src/ConversationInformationCards.tsx",
  "src/renderer/src/board-ui.tsx",
  "src/renderer/src/board-ui-state.ts",
  "src/renderer/src/plugin-information-host.tsx",
  "src/renderer/src/plugin-ui-host.tsx",
  "src/information-layout.ts",
  "src/native-information.ts",
  "src/renderer/src/i18n/panels.ts",
  "src/renderer/src/styles.css",
  "src/renderer/src/theme.css",
  "src/renderer/src/shell-thread-panel.css",
  "src/renderer/src/subagents.css",
  "src/renderer/public/plugin-frame.html",
  "scripts/information-layout-preview.tsx",
  "scripts/build-information-layout-preview.mjs",
  "scripts/capture-information-layout-preview.mjs",
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
        "Actual production editable information panel, Board, information host and isolated frame components with synthetic in-memory ports and an outer chat scaffold. This is a Chromium component preview, not native Electron or real Host acceptance. Question card is a separate synthetic attention-slot probe. No private data, model calls or external writes. Source hashes bind screenshots to code.",
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
console.log(`Built synthetic editable information preview at ${directory}`);
