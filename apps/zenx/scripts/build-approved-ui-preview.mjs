import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const root = fileURLToPath(new URL("../", import.meta.url));
const directory = path.resolve(process.argv[2] ?? ".approved-ui-preview");
await mkdir(directory, { recursive: true });
const stylesheet = path.join(root, "src/renderer/src/styles.css");
// Reconstruct only the reviewed pre-change stylesheet, never production files.
function previousSidebarStyles(current) {
  const replace = (from, to) => {
    assert.equal(
      current.split(from).length,
      2,
      `Unique baseline seam: ${from}`,
    );
    current = current.replace(from, to);
  };
  replace('@import "./ContextUsageIndicator.css";\n', "");
  replace(
    `.thread-row[data-shortcut-key]::after {\n  position: absolute;\n  inset-inline-end: 6px;\n  top: 50%;\n  transform: translateY(-50%);\n  white-space: nowrap;\n  pointer-events: none;\n}`,
    `.thread-row[data-shortcut-key]::after {\n  position: absolute;\n  right: 9px;\n  top: 50%;\n  transform: translateY(-50%);\n}\n.thread-row-shell:has(.thread-row[data-shortcut-key]) .thread-menu-trigger {\n  opacity: 0;\n  visibility: hidden;\n  pointer-events: none;\n}`,
  );
  replace("  --thread-shortcut-space: 0px;\n", "");
  replace(
    `/* The hint owns a trailing slot; factual statuses and hover actions stay to\n   its left. Size with the caption token so text scaling keeps the gap intact. */\n.thread-row-shell:has(> .thread-row[data-shortcut-key]) {\n  --thread-shortcut-space: calc(3 * var(--font-size-caption) + 20px);\n}\n:root[data-platform="darwin"]\n  .thread-row-shell:has(> .thread-row[data-shortcut-key]) {\n  --thread-shortcut-space: calc(2 * var(--font-size-caption) + 16px);\n}\n`,
    "",
  );
  replace(
    "padding-inline-end: calc(\n    10px + var(--thread-state-space, 0px) + var(--thread-shortcut-space)\n  );",
    "padding-inline-end: calc(10px + var(--thread-state-space, 0px));",
  );
  replace(
    "inset-inline-end: var(--thread-shortcut-space);",
    "inset-inline-end: 0;",
  );
  replace(
    "padding-inline-end: calc(\n      54px + var(--thread-state-space, 0px) + var(--thread-shortcut-space)\n    );",
    "padding-inline-end: calc(54px + var(--thread-state-space, 0px));",
  );
  const bytes = Buffer.from(current);
  const blob = createHash("sha1")
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest("hex");
  assert.ok(
    blob.startsWith("464e3f45"),
    "Reviewed dfd42754 stylesheet baseline",
  );
  return current;
}
const baseline = previousSidebarStyles(await readFile(stylesheet, "utf8"));
for (const variant of ["before", "after"]) {
  const result = await build({
    configFile: false,
    root: path.resolve(root, "../.."),
    logLevel: "warn",
    define: { "process.env.NODE_ENV": '"production"' },
    plugins:
      variant === "before"
        ? [
            {
              name: "reviewed-sidebar-baseline-only",
              enforce: "pre",
              load(id) {
                return id === stylesheet ? baseline : undefined;
              },
            },
          ]
        : [],
    build: {
      write: false,
      minify: true,
      cssCodeSplit: false,
      lib: {
        entry: path.join(root, "test/fixtures/approved-sidebar-visual.tsx"),
        name: "ApprovedSidebarPreview",
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
  assert.ok(js && css, "Complete JavaScript and CSS output");
  await writeFile(
    path.join(directory, `sidebar-${variant}.html`),
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body data-variant="${variant}"><div id="root"></div><script>${js.replaceAll("</script", "<\\/script")}</script></body></html>`,
  );
}
execFileSync(process.execPath, [
  path.join(root, "scripts/preview-context-ring-motion.mjs"),
  path.join(directory, "context-comparison.html"),
]);
const comparison = await readFile(
  path.join(directory, "context-comparison.html"),
  "utf8",
);
const prefix = "<script>const frames=";
const suffix = ';document.querySelectorAll("iframe")';
const start = comparison.lastIndexOf(prefix) + prefix.length;
const end = comparison.indexOf(suffix, start);
assert.ok(start >= prefix.length && end > start);
const frames = JSON.parse(comparison.slice(start, end));
assert.equal(frames.length, 2);
await writeFile(path.join(directory, "context-before.html"), frames[0]);
await writeFile(path.join(directory, "context-after.html"), frames[1]);
await writeFile(
  path.join(directory, "source.json"),
  JSON.stringify(
    {
      commit: execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: root,
        encoding: "utf8",
      }).trim(),
      note: "Actual production Sidebar and context/send controls with synthetic data. Before reverses only the accepted CSS changes. No Host actions or user data.",
      cssSha256: createHash("sha256")
        .update(await readFile(stylesheet))
        .digest("hex"),
    },
    null,
    2,
  ) + "\n",
);
console.log("Built real-component Sidebar and context before/after fixtures.");
