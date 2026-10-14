import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const sourceFiles = [
  "src/foreground-activity-view.ts",
  "test/fixtures/foreground-activity-visual.ts",
  "test/fixtures/foreground-activity-visual.html",
];
const sources = await Promise.all(
  sourceFiles.map((filename) => readFile(resolve(root, filename), "utf8")),
);
const sha256 = createHash("sha256").update(sources.join("\0")).digest("hex");
const result = await build({
  entryPoints: [resolve(root, sourceFiles[1])],
  bundle: true,
  write: false,
  format: "iife",
  target: "es2022",
});
const script = result.outputFiles[0].text.replaceAll("</script", "<\\/script");
const html = sources[2]
  .replace(
    '<script type="module" src="./foreground-activity-visual.ts"></script>',
    `<script>${script}</script>`,
  )
  .replace(
    "<head>",
    `<head>\n    <meta name="zenx-preview-source-sha256" content="${sha256}" />`,
  );
const destination = resolve(
  process.argv[2] ?? "foreground-activity-preview.html",
);
await writeFile(destination, html);
console.log(JSON.stringify({ destination, sha256, sourceFiles }));
