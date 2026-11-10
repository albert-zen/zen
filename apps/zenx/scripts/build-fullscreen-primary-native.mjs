import { build } from "esbuild";
import { mkdir, copyFile, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));
const directory = path.resolve(process.argv[2]);
await mkdir(directory, { recursive: true });
const result = await build({
  entryPoints: [path.join(here, "capture-fullscreen-primary-native.ts")],
  outfile: path.join(directory, "native-main.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  packages: "external",
  metafile: true,
});
await copyFile(
  path.join(here, "fullscreen-primary-native-preload.cjs"),
  path.join(directory, "native-preload.cjs"),
);
const sources = {};
for (const name of [
  ...Object.keys(result.metafile.inputs),
  path.join(here, "fullscreen-primary-native-preload.cjs"),
])
  sources[path.relative(path.join(here, "../../.."), name)] = createHash(
    "sha256",
  )
    .update(await readFile(name))
    .digest("hex");
await writeFile(
  path.join(directory, "native-source.json"),
  JSON.stringify(
    {
      scope:
        "Native production WorkspaceBrowser service and Electron WebContentsView; synthetic data on a disposable hosted macOS runner, not user-machine or physical input acceptance.",
      sources,
      outputs: Object.fromEntries(
        await Promise.all(
          [
            "native-main.cjs",
            "native-preload.cjs",
            "fullscreen-primary-chat.html",
          ].map(async (name) => [
            name,
            createHash("sha256")
              .update(await readFile(path.join(directory, name)))
              .digest("hex"),
          ]),
        ),
      ),
    },
    null,
    2,
  ),
);
