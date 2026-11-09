// Usage: node build.mjs REPO NEW_OUTPUT_DIRECTORY. Never overwrites evidence.
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { mkdir, writeFile, readFile, realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
const root = await realpath(process.argv[2]);
const output = path.resolve(process.argv[3]);
await mkdir(output);
const require = createRequire(path.join(root, "package.json"));
const { build } = await import(require.resolve("vite"));
const result = await build({
  configFile: false,
  root,
  logLevel: "warn",
  define: { "process.env.NODE_ENV": '"production"' },
  resolve: {
    alias: [
      { find: "@repo", replacement: root },
      ...["react", "react/jsx-runtime", "react-dom", "react-dom/client"].map(
        (name) => ({
          find: new RegExp(`^${name}$`),
          replacement: require.resolve(name),
        }),
      ),
    ],
  },
  build: {
    write: false,
    minify: true,
    cssCodeSplit: false,
    lib: {
      entry: fileURLToPath(new URL("fixture.tsx", import.meta.url)),
      name: "ContrastSettingsFixture",
      formats: ["iife"],
    },
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
});
const assets = (Array.isArray(result) ? result[0] : result).output;
const js = assets
  .filter((a) => a.type === "chunk")
  .map((a) => a.code)
  .join("\n");
const css = assets
  .filter((a) => a.type === "asset" && a.fileName.endsWith(".css"))
  .map((a) => String(a.source))
  .join("\n");
if (!js || !css) throw Error("Missing component or stylesheet output");
await writeFile(
  path.join(output, "index.html"),
  `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Synthetic Settings contrast fixture</title><style>${css}</style></head><body><div id="root"></div><script>${js.replaceAll("</script", "<\\/script")}</script></body></html>`,
);
const sourceFiles = [
  "apps/zenx/src/renderer/src/styles.css",
  "apps/zenx/src/renderer/src/theme.css",
  "apps/zenx/src/renderer/src/SettingsView.tsx",
];
const hashes = {};
for (const file of sourceFiles)
  hashes[file] = createHash("sha256")
    .update(await readFile(path.join(root, file)))
    .digest("hex");
await writeFile(
  path.join(output, "source.json"),
  JSON.stringify(
    {
      root,
      hashes,
      fixture:
        "Actual production SettingsView with synthetic local-only ports. No real credentials, account, Host, or model service. Browser component rendering is not native whole-app acceptance.",
    },
    null,
    2,
  ),
);
