import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const root = fileURLToPath(new URL("../", import.meta.url));
const directory = path.resolve(process.argv[2] ?? ".file-sidebar-preview");
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
      entry: path.join(root, "scripts/file-sidebar-preview.tsx"),
      name: "FileSidebarPreview",
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
  path.join(directory, "file-sidebar.html"),
  `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'"><title>ZenX File sidebar · synthetic component preview</title><style>${css}</style></head><body><div id="root"></div><script>${js.replaceAll("</script", "<\\/script")}</script></body></html>`,
);
// Production-CSP twin: external same-origin assets retain the actual renderer
// policy, so runtime style-module injection cannot hide behind unsafe-inline.
const rendererHtml = await readFile(
  path.join(root, "src/renderer/index.html"),
  "utf8",
);
const productionCsp =
  /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/u.exec(
    rendererHtml,
  )?.[1];
assert.ok(
  productionCsp?.includes("style-src 'self'"),
  "Read exact production CSP",
);
await writeFile(path.join(directory, "file-sidebar-production.css"), css);
await writeFile(path.join(directory, "file-sidebar-production.js"), js);
await writeFile(
  path.join(directory, "file-sidebar-policy-observer.js"),
  "window.__fileCspViolations=[];addEventListener('securitypolicyviolation',e=>window.__fileCspViolations.push({effectiveDirective:e.effectiveDirective,blockedURI:e.blockedURI,violatedDirective:e.violatedDirective,disposition:e.disposition}));",
);
await writeFile(
  path.join(directory, "file-sidebar-production-csp.html"),
  `<!doctype html><html data-native-file-diagnostic><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${productionCsp}"><title>ZenX synthetic file diagnostic · production CSP</title><link rel="stylesheet" href="file-sidebar-production.css"><script src="file-sidebar-policy-observer.js"></script></head><body><div id="root"></div><script src="file-sidebar-production.js"></script></body></html>`,
);
const sources = [
  "src/renderer/src/Markdown.tsx",
  "src/renderer/src/i18n/panels.ts",
  "src/renderer/src/local-path-links.ts",
  "src/renderer/src/message-file-path.ts",
  "src/external-link-policy.ts",
  "src/renderer/src/auxiliary-panel.tsx",
  "src/renderer/src/workspace-files-panel.tsx",
  "src/renderer/src/workspace-external-open.tsx",
  "src/renderer/src/ui/controls.tsx",
  "src/renderer/src/icons.tsx",
  "src/renderer/src/workspace-file-picker.tsx",
  "src/renderer/src/workspace-file-explorer.tsx",
  "src/renderer/src/workspace-file-drafts.ts",
  "src/renderer/src/SourceEditor.tsx",
  "src/renderer/src/InlineMarkdownEditor.tsx",
  "src/renderer/src/InlineComposerEditor.tsx",
  "src/renderer/src/editor-style-nonce.ts",
  "src/main/renderer-file-protocol.ts",
  "src/main/renderer-style-policy.ts",
  "src/renderer/src/file-content-search.ts",
  "src/renderer/src/styles.css",
  "src/renderer/src/workspace-files.css",
  "src/renderer/src/i18n/panels.ts",
  "src/renderer/src/theme.css",
  "scripts/file-sidebar-preview.tsx",
  "scripts/build-file-sidebar-preview.mjs",
  "scripts/capture-file-sidebar-preview.mjs",
  "src/renderer/index.html",
  "scripts/capture-file-sidebar-electron.cjs",
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
        "Actual AuxiliaryPanel, WorkspaceFilesPanel, WorkspaceFileExplorer, SourceEditor and InlineMarkdownEditor with production styles. Synthetic source and Markdown files, memory-only drafts and a scoped fake file API; no Host, private files or profile. Application catalog, picker results, external-open receipts and unsupported-remote error are simulated; no native picker or application is launched. Browser CDP keyboard/pointer input, not native Electron or physical OS acceptance.",
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
  `ZenX file sidebar: actual-component synthetic preview

Open file-sidebar.html in a browser. Use ?lang=zh-CN and ?theme=light.
The self-contained HTML blocks all networking through its content security policy.

Production: AuxiliaryPanel, file navigation/tree, breadcrumb row, file drafts,
SourceEditor, InlineMarkdownEditor, CodeMirror, translations and theme/styles.
Synthetic: two long memory-only files, fake read/list/search APIs, an inert
non-file tab, and the outer main-area scaffold. No Host, file writes, credentials,
private profile or user data. The file surface has no fixture CSS overrides.

Acceptance checks actual wheel and keyboard scrolling, horizontal source scroll,
bounded viewport and non-scrolling ancestors, reaching each file's end, reading
position across tab switches and tree toggles, breadcrumb-row toggle placement,
and shared tree scope across file versus non-file tabs. External-open menu checks cover labels, viewport bounds, keyboard focus, mock default/custom dispatch, simulated application picking success/cancellation/error, management-dialog reopening and keyboard focus, and an unsupported-remote error with no fallback. Both languages cover desktop, narrow and short viewports. Configuration persists only in the synthetic in-memory catalog, not a real Host profile. Screenshots are browser
renderings, not a live Electron app or physical OS input acceptance.
See measurements.json for assertions and source.json for commit/source hashes.
CI uses existing Chrome and fonts-noto-cjk; the browser sandbox stays enabled.
No browser is downloaded. Missing Chrome or CJK font support fails explicitly.

`,
);
console.log(`Built self-contained File sidebar preview at ${directory}`);
