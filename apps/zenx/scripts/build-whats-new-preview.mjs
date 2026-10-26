import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const root = fileURLToPath(new URL("../", import.meta.url));
const directory = path.resolve(process.argv[2] ?? ".whats-new-preview");
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
      entry: path.join(root, "scripts/whats-new-preview.tsx"),
      name: "WhatsNewPreview",
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
  path.join(directory, "whats-new.html"),
  `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'"><title>ZenX What's New · synthetic component preview</title><style>${css}</style></head><body><div id="root"></div><script>${js.replaceAll("</script", "<\\/script")}</script></body></html>`,
);
const sources = [
  "src/renderer/src/Sidebar.tsx",
  "src/renderer/src/WhatsNew.tsx",
  "src/renderer/src/release-notes.ts",
  "src/renderer/src/ui/controls.tsx",
  "src/renderer/src/styles.css",
  "src/renderer/src/theme.css",
  "src/renderer/src/i18n/shell.ts",
  "scripts/whats-new-preview.tsx",
  "scripts/build-whats-new-preview.mjs",
  "scripts/capture-whats-new-preview.mjs",
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
        "Actual production Sidebar renders WhatsNew with the shared Dialog, bundled release notes, translations and theme/styles. One synthetic Project and idle Thread; no Host, credentials or private profile. The Sidebar is held open by a preview scaffold, not App; App-wide Escape handling and navigation integration are not exercised. Linux browser keyboard/pointer emulation, not native Electron or physical OS acceptance.",
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
  `ZenX What's New: actual-component synthetic preview

Open whats-new.html in a browser, then use the sidebar's What's New entry.
Use ?lang=zh-CN for Chinese and ?theme=light for the light appearance.
The HTML is self-contained and its content security policy blocks networking.

Production: Sidebar, WhatsNew, shared Dialog, release notes, translations,
brand assets and semantic theme/styles. No copied component or dialog CSS.
Synthetic: one Project, one idle Thread, service-ready status and main-area
preview scaffold. Other navigation is inactive; Host mutations are unavailable.
Sidebar is held open by the scaffold. App-wide Escape handling, Sidebar
closure and other App navigation integration are not exercised by this fixture.
No real account, profile, settings, credentials or user data are read.

Screenshots are browser-rendered production components, not a live Electron app.
Keyboard and pointer checks use Chrome CDP input, not physical native OS input.
See source.json for the checked-out commit and exact component source hashes.
See measurements.json for executed assertions, viewport geometry and failures.
CI uses its existing Chrome and the official Ubuntu fonts-noto-cjk package.
No browser or application dependency is installed by this fixture, and the
browser sandbox stays enabled. Missing Chrome or CJK fonts is an explicit failure.
Fontless Chinese screenshots are named font-unverified and cannot pass acceptance.
`,
);
console.log(`Built self-contained What's New preview at ${directory}`);
