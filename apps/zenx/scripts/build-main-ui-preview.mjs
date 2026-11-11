/** Fast visual feedback only: production renderers, existing synthetic fixtures. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const started = performance.now();
const root = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const output = path.resolve(process.argv[2] ?? ".main-ui-preview");
const selection = process.argv[3] ?? "all";
const entries = {
  reading: {
    entry: "apps/zenx/test/fixtures/ui-polish-visual.tsx",
    scope:
      "Production App/Markdown/Information/Queue/Approval/Composer. Rich synthetic read-only conversation, desktop only; no real tool, account, approval decision or filesystem access.",
  },
  main: {
    entry: "apps/zenx/test/fixtures/ui-polish-visual.tsx",
    scope:
      "Production App, Sidebar and ThreadView. Synthetic bridge and conversation. No Host, native Electron, live account or real filesystem acceptance.",
  },
  navigation: {
    entry: "apps/zenx/test/fixtures/ui-polish-visual.tsx",
    scope:
      "Production App titlebar, Information host/cards and Sidebar. Native pointer/keyboard navigation on a read-only synthetic bridge. Desktop only; no native Electron or real Host acceptance.",
  },
  pending: {
    entry: "apps/zenx/test/fixtures/queue-steer-visual.tsx",
    scope:
      "Production Sidebar and ThreadView pending messages. Synthetic user/agent queue and steer rows. No real send or delivery.",
  },
  information: {
    entry: "apps/zenx/scripts/information-layout-preview.tsx",
    scope:
      "Production EditableInformationPanel, conversation cards and plugin information hosts. Synthetic ports and outer chat scaffold, not App navigation.",
  },
};
assert(
  selection === "all" || Object.hasOwn(entries, selection),
  "Scene must be all, main, navigation, reading, pending or information",
);
// Keep the ordinary three-surface loop unchanged; the longer native navigation
// journey is explicitly selected when its affected states need verification.
const selected =
  selection === "all" ? ["main", "pending", "information"] : [selection];
await mkdir(output, { recursive: true });
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const git = (...args) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const sources = new Set([
  "apps/zenx/scripts/prepare-preview-fonts.mjs",
  "apps/zenx/scripts/preview-font-probe.mjs",
  "apps/zenx/scripts/preview-fonts-OFL.txt",
  "apps/zenx/test/preview-fonts.test.mjs",
  "apps/zenx/scripts/reading-main-ui-preview.mjs",
  "apps/zenx/test/reading-main-ui-preview.test.mjs",
  ".github/workflows/desktop-reading-ui.yml",
  "apps/zenx/scripts/queue-reading-main-ui-preview.mjs",
  "apps/zenx/test/queue-reading-main-ui-preview.test.mjs",
  "package-lock.json",
  "apps/zenx/scripts/build-main-ui-preview.mjs",
  "apps/zenx/scripts/capture-main-ui-preview.mjs",
  "apps/zenx/scripts/navigation-main-ui-preview.mjs",
  "apps/zenx/scripts/preview-browser-lifecycle.mjs",
]);
const scenes = {};
for (const name of selected) {
  const sceneStarted = performance.now();
  const result = await build({
    configFile: false,
    root,
    logLevel: "warn",
    define: { "process.env.NODE_ENV": '"production"' },
    plugins: [
      {
        name: "preview-source-receipt",
        transform(_code, id) {
          const file = id.split("?")[0];
          if (file.startsWith(`${root}/`) && !file.includes("/node_modules/"))
            sources.add(path.relative(root, file));
        },
      },
    ],
    build: {
      write: false,
      minify: true,
      cssCodeSplit: false,
      lib: {
        entry: path.join(root, entries[name].entry),
        name: "MainUiPreview",
        formats: ["iife"],
      },
      rollupOptions: { output: { inlineDynamicImports: true } },
    },
  });
  const assets = (Array.isArray(result) ? result[0] : result).output;
  const js = assets
    .filter((f) => f.type === "chunk")
    .map((f) => f.code)
    .join("\n");
  const css = assets
    .filter((f) => f.type === "asset" && f.fileName.endsWith(".css"))
    .map((f) => String(f.source))
    .join("\n");
  assert(js && css, "Bundle actual components and styles");
  assert(
    !assets.some((f) => f.type === "asset" && !f.fileName.endsWith(".css")),
    "No external assets",
  );
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; frame-src 'self'"><title>ZenX ${name} · synthetic production component preview</title><style>${css}</style></head><body><div id="root"></div><script>${js.replaceAll("</script", "<\\/script").replaceAll("<!--", "\\x3c!--")}</script></body></html>`;
  await writeFile(path.join(output, `${name}.html`), html);
  scenes[name] = {
    ...entries[name],
    html: `${name}.html`,
    sha256: hash(html),
    buildMs: Math.round(performance.now() - sceneStarted),
  };
}
if (selected.includes("information")) {
  const frame = "apps/zenx/src/renderer/public/plugin-frame.html";
  sources.add(frame);
  await writeFile(
    path.join(output, "plugin-frame.html"),
    await readFile(path.join(root, frame)),
  );
}
const sourceHashes = Object.fromEntries(
  await Promise.all(
    [...sources]
      .sort()
      .map(async (file) => [file, hash(await readFile(path.join(root, file)))]),
  ),
);
const receipt = {
  schemaVersion: 1,
  commit: git("rev-parse", "HEAD"),
  tree: git("rev-parse", "HEAD^{tree}"),
  dirtyFiles: git("status", "--porcelain", "--untracked-files=normal")
    .split("\n")
    .filter(Boolean),
  diffSha256: hash(
    git(
      "diff",
      "HEAD",
      "--",
      "apps/zenx",
      ".github/workflows/main-ui-preview.yml",
    ),
  ),
  buildMs: Math.round(performance.now() - started),
  scenes,
  sources: sourceHashes,
};
await writeFile(
  path.join(output, "source.json"),
  JSON.stringify(receipt, null, 2) + "\n",
);
console.log(
  JSON.stringify({
    output,
    commit: receipt.commit,
    scenes: selected,
    buildMs: receipt.buildMs,
  }),
);
