import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import * as esbuild from "esbuild";
const output = path.resolve(process.argv[2] ?? ".composer-overflow-preview");
await mkdir(output, { recursive: true });
const build = await esbuild.build({
  metafile: true,
  entryPoints: ["apps/zenx/test/fixtures/composer-overflow-visual.tsx"],
  bundle: true,
  outdir: output,
  entryNames: "composer",
  platform: "browser",
  format: "esm",
  jsx: "automatic",
  define: { "process.env.NODE_ENV": '"production"' },
  loader: {
    ".woff2": "dataurl",
    ".woff": "dataurl",
    ".svg": "dataurl",
    ".png": "dataurl",
  },
});
const csp = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/u.exec(
  await readFile("apps/zenx/src/renderer/index.html", "utf8"),
)[1];
await writeFile(
  path.join(output, "index.html"),
  `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${csp}"><title>Synthetic Composer overflow regression</title><link rel="stylesheet" href="composer.css"><script src="observer.js"></script></head><body><div id="root"></div><script type="module" src="composer.js"></script></body></html>`,
);
await writeFile(
  path.join(output, "observer.js"),
  `window.composerCspViolations=[];document.addEventListener('securitypolicyviolation',e=>window.composerCspViolations.push({directive:e.effectiveDirective,blockedURI:e.blockedURI}));`,
);
const inputs = [
  ...new Set([
    ...Object.keys(build.metafile.inputs),
    "apps/zenx/src/renderer/index.html",
    "apps/zenx/src/main/renderer-style-policy.ts",
    "apps/zenx/scripts/build-composer-overflow-preview.mjs",
    "apps/zenx/scripts/capture-composer-overflow-preview.mjs",
    "apps/zenx/scripts/preview-browser.mjs",
    "apps/zenx/scripts/preview-browser-lifecycle.mjs",
    ".github/workflows/composer-overflow.yml",
    "apps/zenx/scripts/prepare-cjk-fonts.mjs",
  ]),
].sort();
await writeFile(
  path.join(output, "source.json"),
  JSON.stringify(
    {
      commit: execFileSync("git", ["rev-parse", "HEAD"], {
        encoding: "utf8",
      }).trim(),
      tree: execFileSync("git", ["rev-parse", "HEAD^{tree}"], {
        encoding: "utf8",
      }).trim(),
      dirty: execFileSync(
        "git",
        ["status", "--porcelain", "--untracked-files=no"],
        { encoding: "utf8" },
      ).trim(),
      inputs: await Promise.all(
        inputs.map(async (file) => ({
          path: file,
          sha256: createHash("sha256")
            .update(await readFile(file))
            .digest("hex"),
        })),
      ),
    },
    null,
    2,
  ),
);
console.log(output);
