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
    "apps/zenx/test/fixtures/message-quote.vite.config.mjs",
  ],
  { stdio: "inherit", env: { ...process.env, ZENX_QUOTE_PREVIEW_OUT: build } },
);
let html = await readFile(
  path.join(build, "test/fixtures/message-quote-visual.html"),
  "utf8",
);
const script = html.match(/<script[^>]*src="([^"]+)"[^>]*><\/script>/u);
const style = html.match(
  /<link[^>]*rel="stylesheet"[^>]*href="([^"]+)"[^>]*>/u,
);
if (!script || !style)
  throw new Error("Expected one preview script and stylesheet");
html = html.replace(
  script[0],
  `<script type="module">${(await readFile(path.join(build, "assets", path.basename(script[1])), "utf8")).replaceAll("</script", "<\\/script")}</script>`,
);
html = html.replace(
  style[0],
  `<style>${await readFile(path.join(build, "assets", path.basename(style[1])), "utf8")}</style>`,
);
await writeFile(path.join(directory, "quote-frame.html"), html);
console.log("Self-contained synthetic quote preview created.");
