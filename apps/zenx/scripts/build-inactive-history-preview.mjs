import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
const root = fileURLToPath(new URL("../", import.meta.url));
const directory = path.resolve(process.argv[2] ?? ".inactive-history-preview");
await mkdir(directory, { recursive: true });
const appPath = path.join(root, "src/renderer/src/App.tsx");
const candidate = await readFile(appPath, "utf8");
const baseline = candidate
  .replace(
    /\/\*\* Drafts live separately; only reconstructable, inactive history is disposable\. \*\/[\s\S]*?(?=export function AppConversationProviders)/,
    "",
  )
  .replace(
    /  const trimThreadHistoryCache = \(\) =>[\s\S]*?\}, \[selectedThreadId, threadDetail, composerStates\]\);\n/,
    "",
  )
  .replace("        trimThreadHistoryCache();\n", "");
const gitBlob = (s) =>
  createHash("sha1")
    .update(`blob ${Buffer.byteLength(s)}\0`)
    .update(s)
    .digest("hex");
assert.equal(
  gitBlob(baseline),
  "97bbf176c50becc43da1a55670abd33fa130ebad",
  "Baseline App must match the exact pre-723 main blob, not a guessed simulation",
);
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
              name: "exact-pre-cache-App",
              enforce: "pre",
              load(id) {
                return id === appPath ? baseline : undefined;
              },
            },
          ]
        : [],
    build: {
      write: false,
      minify: true,
      cssCodeSplit: false,
      lib: {
        entry: path.join(root, "test/fixtures/inactive-history-visual.tsx"),
        name: "InactiveHistoryPreview",
        formats: ["iife"],
      },
      rollupOptions: { output: { inlineDynamicImports: true } },
    },
  });
  const output = (Array.isArray(result) ? result[0] : result).output;
  const js = output
    .filter((f) => f.type === "chunk")
    .map((f) => f.code)
    .join("\n");
  const css = output
    .filter((f) => f.type === "asset" && f.fileName.endsWith(".css"))
    .map((f) => String(f.source))
    .join("\n");
  assert.ok(js && css);
  await writeFile(
    path.join(directory, `history-${variant}.html`),
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'"><title>Synthetic App history retention ${variant}</title><style>${css}</style></head><body><div id="root"></div><script>${js.replaceAll("</script", "<\\/script")}</script></body></html>`,
  );
}
const files = [
  "src/renderer/src/App.tsx",
  "src/renderer/src/ThreadView.tsx",
  "src/renderer/src/ExperimentalTranscriptViewport.tsx",
  "test/fixtures/inactive-history-visual.tsx",
  "test/native-recovery-fixture.ts",
  "scripts/build-inactive-history-preview.mjs",
  "scripts/capture-inactive-history-preview.mjs",
  "scripts/preview-browser-lifecycle.mjs",
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
        "Production App with synthetic protocol and deterministic generated text. V8 retained used heap after explicit GC is not RSS, Electron WebContents, decoded image/GPU memory, macOS footprint, or original-machine acceptance.",
      baselineAppBlob: gitBlob(baseline),
      candidateAppBlob: gitBlob(candidate),
      sources: Object.fromEntries(
        await Promise.all(
          files.map(async (f) => [
            f,
            createHash("sha256")
              .update(await readFile(path.join(root, f)))
              .digest("hex"),
          ]),
        ),
      ),
    },
    null,
    2,
  ) + "\n",
);
