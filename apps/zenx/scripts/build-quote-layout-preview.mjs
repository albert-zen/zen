import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
const directory = path.resolve(process.argv[2] ?? ".quote-preview");
const build = path.join(directory, "build");
await mkdir(directory, { recursive: true });
execFileSync(
  process.execPath,
  [
    "node_modules/vite/bin/vite.js",
    "build",
    "--config",
    "apps/zenx/test/fixtures/quote-layout.vite.config.mjs",
  ],
  { stdio: "inherit", env: { ...process.env, ZENX_QUOTE_LAYOUT_OUT: build } },
);
let html = await readFile(
  path.join(build, "test/fixtures/quote-layout-comparison.html"),
  "utf8",
);
const script = html.match(/<script[^>]*src="([^"]+)"[^>]*><\/script>/u);
const style = html.match(
  /<link[^>]*rel="stylesheet"[^>]*href="([^"]+)"[^>]*>/u,
);
if (!script || !style)
  throw new Error("Expected one preview script and stylesheet");
const javascript = await readFile(
  path.join(build, "assets", path.basename(script[1])),
  "utf8",
);
const css = await readFile(
  path.join(build, "assets", path.basename(style[1])),
  "utf8",
);
// Replacement callbacks preserve literal $&, $`, $' sequences in bundled code.
html = html.replace(
  script[0],
  () =>
    `<script type="module">${javascript.replaceAll("</script", "<\\/script")}</script>`,
);
html = html.replace(style[0], () => `<style>${css}</style>`);
const inlinedScript = html.match(
  /<script type="module">([\s\S]*?)<\/script>/u,
)?.[1];
if (!inlinedScript) throw new Error("Expected one inlined preview script");
execFileSync(process.execPath, ["--input-type=module", "--check"], {
  input: inlinedScript,
  stdio: ["pipe", "inherit", "inherit"],
});
await writeFile(path.join(directory, "quote-layout.html"), html);
console.log(
  "Self-contained synthetic quote preview created and syntax checked.",
);
