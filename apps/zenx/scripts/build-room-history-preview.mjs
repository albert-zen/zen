import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const root = fileURLToPath(new URL("../", import.meta.url));
const directory = path.resolve(process.argv[2] ?? ".room-history-preview");
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
      entry: path.join(root, "scripts/room-history-preview.tsx"),
      name: "RoomHistoryPreview",
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
const fixture = await readFile(path.join(directory, "fixture.json"), "utf8");
const source = JSON.parse(
  await readFile(path.join(directory, "fixture-source.json"), "utf8"),
);
assert.equal(
  source.commit,
  execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim(),
);
const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'"><title>ZenX Room history · synthetic component preview</title><style>${css}</style></head><body><div id="root"></div><script>window.__roomHistoryFixture=${fixture.replaceAll("<", "\\u003c")};</script><script>${js.replaceAll("</script", "<\\/script")}</script></body></html>`;
await writeFile(path.join(directory, "room-history.html"), html);
await writeFile(
  path.join(directory, "source.json"),
  JSON.stringify(
    {
      ...source,
      htmlSha256: createHash("sha256").update(html).digest("hex"),
      scope:
        "Production RoomsPage with synthetic responses verified through real journal persistence and restart. Browser component capture, not native Electron acceptance.",
    },
    null,
    2,
  ) + "\n",
);
