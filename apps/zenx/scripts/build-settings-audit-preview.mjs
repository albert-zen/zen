import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const root = fileURLToPath(new URL("../", import.meta.url));
const directory = path.resolve(process.argv[2] ?? ".settings-audit-preview");
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
      entry: path.join(root, "scripts/settings-audit-preview.tsx"),
      name: "SettingsAuditPreview",
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
  path.join(directory, "settings-audit.html"),
  `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'"><title>ZenX Settings · synthetic component preview</title><style>${css}</style></head><body><div id="root"></div><script>${js.replaceAll("</script", "<\\/script")}</script></body></html>`,
);
const sources = [
  "src/renderer/src/SettingsView.tsx",
  "src/renderer/src/ProviderModelAdmissionControls.tsx",
  "src/renderer/src/ui/controls.tsx",
  "src/renderer/src/styles.css",
  "src/renderer/src/theme.css",
  "src/renderer/src/i18n/settings.ts",
  "scripts/settings-audit-preview.tsx",
  "scripts/build-settings-audit-preview.mjs",
  "scripts/capture-settings-audit-preview.mjs",
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
        "Actual production SettingsView and theme/styles; four synthetic providers, one with twelve models. Synthetic discovery returns one known and one unknown capability record. No Host, credentials, user profile, network or persistence. Settings-only scaffold, not App or first-launch onboarding. Linux Chrome input, not native Electron acceptance.",
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
  `Settings audit evidence. Actual production SettingsView and styles with synthetic services. No Host, credentials, private profile, provider requests or persistence. Model discovery is synthetic and does not establish endpoint metadata quality. Mutations and image probes reject. This is not App integration, first-launch onboarding, native Electron or a full accessibility test. source.json identifies the source commit and hashes. measurements.json records observations, not desired-UX assertions. Screenshot labels match recorded states. The self-contained HTML CSP blocks networking. CI capture retains the browser sandbox.
`,
);
console.log(`Built Settings audit preview at ${directory}`);
