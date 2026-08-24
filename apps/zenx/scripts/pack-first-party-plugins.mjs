import { execFile } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const zenxRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const repositoryRoot = path.resolve(zenxRoot, "..", "..");
const pluginSdkCli = path.join(
  repositoryRoot,
  "packages",
  "zenx-plugin-sdk",
  "dist",
  "cli.js",
);
export const ZENX_ROOMS_TARBALL = "zenx-rooms-plugin-1.0.0.tgz";
export const FIRST_PARTY_PLUGINS = Object.freeze([
  plugin(
    "@zenx/browser-plugin",
    "zenx-browser-plugin",
    "zenx-browser-plugin-electron-1.0.0.tgz",
  ),
  plugin(
    "@zenx/browser-plugin",
    "zenx-browser-plugin",
    "zenx-browser-plugin-playwright-1.0.0.tgz",
    "variants/playwright.zenx.plugin.json",
  ),
  plugin(
    "@zenx/browser-plugin",
    "zenx-browser-plugin",
    "zenx-browser-plugin-user-session-1.0.0.tgz",
    "variants/user-session.zenx.plugin.json",
  ),
  plugin(
    "@zenx/computer-plugin",
    "zenx-computer-plugin",
    "zenx-computer-plugin-macos-1.0.0.tgz",
  ),
  plugin(
    "@zenx/computer-plugin",
    "zenx-computer-plugin",
    "zenx-computer-plugin-peekaboo-1.0.0.tgz",
    "variants/peekaboo.zenx.plugin.json",
  ),
  plugin(
    "@zenx/computer-plugin",
    "zenx-computer-plugin",
    "zenx-computer-plugin-win32-1.1.0.tgz",
    "variants/win32.zenx.plugin.json",
  ),
  plugin("@zenx/rooms-plugin", "zenx-rooms-plugin", ZENX_ROOMS_TARBALL),
  plugin(
    "@zenx/self-control-plugin",
    "zenx-self-control-plugin",
    "zenx-self-control-plugin-1.0.0.tgz",
  ),
  plugin(
    "@zenx/triggers-plugin",
    "zenx-triggers-plugin",
    "zenx-triggers-plugin-1.0.0.tgz",
  ),
]);

function plugin(packageName, directory, tarball, manifest) {
  return Object.freeze({ packageName, directory, tarball, manifest });
}

export async function packZenXFirstPartyPlugins(options) {
  const packed = [];
  for (const definition of FIRST_PARTY_PLUGINS) {
    packed.push(await packFirstPartyPlugin(definition, options));
  }
  return packed;
}

export async function packZenXRoomsPlugin(options) {
  return (
    await packFirstPartyPlugin(
      FIRST_PARTY_PLUGINS.find(
        (entry) => entry.packageName === "@zenx/rooms-plugin",
      ),
      options,
    )
  ).tarball;
}

async function packFirstPartyPlugin(definition, options) {
  const pluginsDirectory = path.join(options.outputDirectory, "plugins");
  await mkdir(pluginsDirectory, { recursive: true, mode: 0o700 });
  await run(
    process.platform === "win32" ? "npm.cmd" : "npm",
    ["run", "build", "--workspace", definition.packageName],
    { cwd: repositoryRoot },
  );
  const staging = await mkdtemp(path.join(os.tmpdir(), "zenx-plugin-pack-"));
  try {
    const packageDirectory = path.join(staging, "package");
    await cp(
      path.join(repositoryRoot, "packages", definition.directory),
      packageDirectory,
      {
        recursive: true,
        filter: (source) => path.basename(source) !== "node_modules",
      },
    );
    if (definition.manifest !== undefined) {
      await cp(
        path.join(packageDirectory, definition.manifest),
        path.join(packageDirectory, "zenx.plugin.json"),
      );
      const manifest = JSON.parse(
        await readFile(path.join(packageDirectory, "zenx.plugin.json"), "utf8"),
      );
      const packageJsonFile = path.join(packageDirectory, "package.json");
      const packageJson = JSON.parse(await readFile(packageJsonFile, "utf8"));
      packageJson.version = manifest.version;
      await writeFile(
        packageJsonFile,
        `${JSON.stringify(packageJson, null, 2)}\n`,
      );
    }
    const packed = await run(
      process.execPath,
      [pluginSdkCli, "pack", packageDirectory],
      {
        cwd: packageDirectory,
      },
    );
    const result = JSON.parse(packed.stdout);
    const filename = result?.[0]?.filename;
    const expectedPacked = definition.tarball.replace(
      /-(?:electron|playwright|user-session|macos|peekaboo|win32)(?=-\d)/u,
      "",
    );
    if (typeof filename !== "string" || filename !== expectedPacked) {
      throw new Error(
        `${definition.packageName} public pack returned an unexpected tarball`,
      );
    }
    const destination = path.join(pluginsDirectory, definition.tarball);
    await rm(destination, { force: true });
    await rename(path.join(packageDirectory, filename), destination);
    return { packageName: definition.packageName, tarball: destination };
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
    `${JSON.stringify(await packZenXFirstPartyPlugins({ outputDirectory: output }))}\n`,
  );
}
