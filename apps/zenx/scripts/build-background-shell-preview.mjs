/** Build a local synthetic document with production current-command and Terminal UI. */
import { build } from "vite";
import { mkdir, readFile, writeFile, copyFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const out = path.resolve(
  process.argv[2] ?? path.join(root, ".background-shell-preview"),
);
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
      entry: path.join(
        root,
        "apps/zenx/test/fixtures/background-shell-visual.tsx",
      ),
      name: "BackgroundShellPreview",
      formats: ["iife"],
    },
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
});
const output = (Array.isArray(result) ? result[0] : result).output;
const js = output
  .filter((entry) => entry.type === "chunk")
  .map((entry) => entry.code)
  .join("\n");
const css = output
  .filter((entry) => entry.type === "asset" && entry.fileName.endsWith(".css"))
  .map((entry) => String(entry.source))
  .join("\n");
await mkdir(out, { recursive: true });
await writeFile(
  path.join(out, "background-shell-preview.html"),
  `<!doctype html><html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Background commands · synthetic production-component fixture</title><style>${css}</style><body style="margin:0"><div id="root"></div><script>${js.replaceAll("</script", "<\\/script")}</script></body></html>`,
);
await copyFile(
  path.join(root, "apps/zenx/src/renderer/public/terminal-frame.html"),
  path.join(out, "terminal-frame.html"),
);
const sourcePaths = new Set([
  "apps/zenx/scripts/build-background-shell-preview.mjs",
  "apps/zenx/src/renderer/public/terminal-frame.html",
  "package-lock.json",
]);
for (const entry of output) {
  if (entry.type !== "chunk") continue;
  for (const moduleId of Object.keys(entry.modules)) {
    const filename = moduleId.split("?")[0];
    if (!filename?.startsWith(`${root}${path.sep}`)) continue;
    const relative = path.relative(root, filename);
    if (!relative.split(path.sep).includes("node_modules"))
      sourcePaths.add(relative);
  }
}
const sha256 = async (filename) =>
  createHash("sha256")
    .update(await readFile(filename))
    .digest("hex");
const sources = Object.fromEntries(
  await Promise.all(
    [...sourcePaths]
      .sort()
      .map(async (filename) => [
        filename,
        await sha256(path.join(root, filename)),
      ]),
  ),
);
const sourceDirtyPaths = execFileSync(
  "git",
  ["diff", "--name-only", "HEAD", "--", ...sourcePaths],
  { cwd: root, encoding: "utf8" },
)
  .trim()
  .split("\n")
  .filter(Boolean);
await writeFile(
  path.join(out, "source-manifest.json"),
  JSON.stringify(
    {
      sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: root,
        encoding: "utf8",
      }).trim(),
      sourceDirtyPaths,
      syntheticData: true,
      privateInputsIncluded: false,
      executionBoundary:
        "Read-only synthetic observations; no model or Host execution.",
      visualAcceptance:
        "Not performed by the builder; capture this exact output separately.",
      sources,
      artifacts: Object.fromEntries(
        await Promise.all(
          ["background-shell-preview.html", "terminal-frame.html"].map(
            async (filename) => [
              filename,
              await sha256(path.join(out, filename)),
            ],
          ),
        ),
      ),
    },
    null,
    2,
  ) + "\n",
);
console.log(out);
