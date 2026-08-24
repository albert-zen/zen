import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const zenxRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const repositoryRoot = path.resolve(zenxRoot, "..", "..");
const roomsPluginRoot = path.join(
  repositoryRoot,
  "packages",
  "zenx-rooms-plugin",
);
const pluginSdkCli = path.join(
  repositoryRoot,
  "packages",
  "zenx-plugin-sdk",
  "dist",
  "cli.js",
);
export const ZENX_ROOMS_TARBALL = "zenx-rooms-plugin-1.0.0.tgz";

export async function packZenXRoomsPlugin(options) {
  const pluginsDirectory = path.join(options.outputDirectory, "plugins");
  await mkdir(pluginsDirectory, { recursive: true, mode: 0o700 });
  await run(
    process.platform === "win32" ? "npm.cmd" : "npm",
    ["run", "build", "--workspace", "@zenx/rooms-plugin"],
    { cwd: repositoryRoot },
  );
  const staging = await mkdtemp(path.join(os.tmpdir(), "zenx-rooms-pack-"));
  try {
    const packageDirectory = path.join(staging, "package");
    await cp(roomsPluginRoot, packageDirectory, {
      recursive: true,
      filter: (source) => path.basename(source) !== "node_modules",
    });
    const packed = await run(
      process.execPath,
      [pluginSdkCli, "pack", packageDirectory],
      {
        cwd: packageDirectory,
      },
    );
    const result = JSON.parse(packed.stdout);
    const filename = result?.[0]?.filename;
    if (typeof filename !== "string" || filename !== ZENX_ROOMS_TARBALL) {
      throw new Error("Rooms public pack returned an unexpected tarball");
    }
    const destination = path.join(pluginsDirectory, ZENX_ROOMS_TARBALL);
    await rm(destination, { force: true });
    await rename(path.join(packageDirectory, filename), destination);
    return destination;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const output = process.argv[2];
  if (output === undefined)
    throw new Error("Usage: pack-first-party-plugins <output>");
  process.stdout.write(
    `${await packZenXRoomsPlugin({ outputDirectory: output })}\n`,
  );
}
