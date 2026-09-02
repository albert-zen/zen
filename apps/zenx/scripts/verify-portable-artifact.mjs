import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { access, readFile, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { npmInvocation } from "../../../packages/zenx-plugin-sdk/src/npm-invocation.mjs";

const run = promisify(execFile);
const zenxRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const repositoryRoot = path.resolve(zenxRoot, "..", "..");
const expectedPlugins = new Map([
  ["zenx-browser-plugin-electron-1.0.0.tgz", "@zenx/browser-plugin@1.0.0"],
  ["zenx-browser-plugin-playwright-1.0.0.tgz", "@zenx/browser-plugin@1.0.0"],
  ["zenx-browser-plugin-user-session-1.0.0.tgz", "@zenx/browser-plugin@1.0.0"],
  ["zenx-computer-plugin-macos-1.0.0.tgz", "@zenx/computer-plugin@1.0.0"],
  ["zenx-computer-plugin-peekaboo-1.0.0.tgz", "@zenx/computer-plugin@1.0.0"],
  ["zenx-computer-plugin-win32-1.1.0.tgz", "@zenx/computer-plugin@1.1.0"],
  ["zenx-rooms-plugin-1.0.0.tgz", "@zenx/rooms-plugin@1.0.0"],
  ["zenx-self-control-plugin-1.0.0.tgz", "@zenx/self-control-plugin@1.0.0"],
  ["zenx-triggers-plugin-1.0.0.tgz", "@zenx/triggers-plugin@1.0.0"],
]);

const artifactArgument = process.argv[2];
const result = await verifyPortableArtifact({
  artifactDirectory:
    artifactArgument === undefined
      ? path.join(
          zenxRoot,
          ".packaged",
          "artifact",
          `ZenX-${process.platform}-${process.arch}`,
        )
      : path.resolve(artifactArgument),
  platform: process.platform,
  arch: process.arch,
});
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

export async function verifyPortableArtifact(options) {
  const appDirectory = applicationDirectory(
    options.artifactDirectory,
    options.platform,
  );
  const resourcesDirectory = resourcesPath(appDirectory, options.platform);
  const executable = executablePath(appDirectory, options.platform);
  const appResources = path.join(resourcesDirectory, "app");
  const providers = path.join(resourcesDirectory, "providers");
  const plugins = path.join(resourcesDirectory, "plugins");

  await requireDirectory(options.artifactDirectory);
  await requireDirectory(appDirectory);
  await requireDirectory(appResources);
  await requireExecutable(executable, options.platform);
  for (const file of [
    "package.json",
    "out/main/index.js",
    "out/main/app-server-host.js",
    "out/preload/index.cjs",
    "out/renderer/index.html",
    "node_modules/ws/package.json",
    "node_modules/@zenx/plugin-sdk/package.json",
    "node_modules/@zenx/plugin-sdk/dist/index.js",
  ]) {
    await requireFile(path.join(appResources, file));
  }
  const packagedApp = JSON.parse(
    await readFile(path.join(appResources, "package.json"), "utf8"),
  );
  const zenxPackage = JSON.parse(
    await readFile(path.join(zenxRoot, "package.json"), "utf8"),
  );
  assert.equal(packagedApp.name, "zenx");
  assert.equal(packagedApp.version, zenxPackage.version);
  const pnpmPackage = JSON.parse(
    await readFile(
      path.join(resourcesDirectory, "pnpm", "package.json"),
      "utf8",
    ),
  );
  assert.equal(pnpmPackage.name, "pnpm");
  assert.equal(pnpmPackage.version, zenxPackage.devDependencies.pnpm);
  await requireFile(path.join(resourcesDirectory, "pnpm", "bin", "pnpm.cjs"));

  const marketplace = JSON.parse(
    await readFile(
      path.join(resourcesDirectory, "marketplace", "catalog.json"),
      "utf8",
    ),
  );
  assert.deepEqual(marketplace, { entries: [] });

  const pluginFiles = (await readdir(plugins))
    .filter((file) => file.endsWith(".tgz"))
    .sort();
  assert.deepEqual(pluginFiles, [...expectedPlugins.keys()].sort());
  const pluginDigests = {};
  for (const filename of pluginFiles) {
    const tarball = path.join(plugins, filename);
    const invocation = npmInvocation(["pack", "--dry-run", "--json", tarball]);
    const packed = await run(invocation.executable, invocation.args, {
      cwd: repositoryRoot,
      maxBuffer: 1024 * 1024,
    });
    const [metadata] = JSON.parse(packed.stdout);
    assert.equal(
      `${metadata.name}@${metadata.version}`,
      expectedPlugins.get(filename),
    );
    assert.deepEqual(metadata.files.map(({ path: file }) => file).sort(), [
      "README.md",
      "dist/runtime.js",
      "package.json",
      "zenx.plugin.json",
    ]);
    pluginDigests[filename] = await sha256File(tarball);
  }

  const manifestPath = path.join(providers, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  assert.equal(manifest.schemaVersion, 1);
  const playwright = manifest.providers?.["playwright-cli"];
  assert.equal(playwright?.platforms?.includes(options.platform), true);
  await verifyProviderEntry(providers, playwright);
  await verifyProviderEntry(
    providers,
    manifest.providers?.["microsoft-winapp-cli"],
  );

  if (options.platform === "linux") {
    const providerLock = JSON.parse(
      await readFile(
        path.join(zenxRoot, "resources", "providers", "provider-lock.json"),
        "utf8",
      ),
    );
    const platformKey = `linux-${options.arch === "arm64" ? "arm64" : "x64"}`;
    const browser = providerLock.browser.platformArchives[platformKey];
    assert.ok(browser, `provider lock is missing ${platformKey}`);
    await requireExecutable(
      path.join(
        providers,
        "playwright-browsers",
        `${providerLock.browser.name}-${providerLock.browser.revision}`,
        browser.executable,
      ),
      options.platform,
    );
    await requireFile(
      path.join(
        providers,
        "playwright-browsers",
        `${providerLock.browser.name}-${providerLock.browser.revision}`,
        "INSTALLATION_COMPLETE",
      ),
    );
  }

  return {
    artifactDirectory: options.artifactDirectory,
    platform: options.platform,
    arch: options.arch,
    executable,
    appVersion: packagedApp.version,
    bundledPnpmVersion: pnpmPackage.version,
    marketplaceEntries: marketplace.entries.length,
    firstPartyTarballs: pluginFiles.length,
    pluginSha256: pluginDigests,
    providerManifestSha256: await sha256File(manifestPath),
  };
}

async function verifyProviderEntry(root, provider) {
  assert.ok(provider);
  const canonicalRoot = await realpath(root);
  await requireContainedPath(canonicalRoot, provider.executable, "file");
  await requireContainedPath(canonicalRoot, provider.runtime.path, "file");
  for (const asset of provider.assets ?? []) {
    await requireContainedPath(
      canonicalRoot,
      asset.path,
      asset.kind === "directory" ? "directory" : "file",
    );
  }
}

async function requireContainedPath(root, relativePath, kind) {
  assert.equal(path.isAbsolute(relativePath), false);
  const target = await realpath(path.resolve(root, relativePath));
  const relative = path.relative(root, target);
  assert.equal(
    relative === "" ||
      (!relative.startsWith("..") && !path.isAbsolute(relative)),
    true,
    `provider path escapes the portable artifact: ${relativePath}`,
  );
  const targetStat = await stat(target);
  assert.equal(
    kind === "directory" ? targetStat.isDirectory() : targetStat.isFile(),
    true,
    `provider asset has the wrong kind: ${relativePath}`,
  );
}

function applicationDirectory(artifactDirectory, platform) {
  return platform === "darwin"
    ? path.join(artifactDirectory, "ZenX.app")
    : artifactDirectory;
}

function resourcesPath(appDirectory, platform) {
  return platform === "darwin"
    ? path.join(appDirectory, "Contents", "Resources")
    : path.join(appDirectory, "resources");
}

function executablePath(appDirectory, platform) {
  if (platform === "darwin") {
    return path.join(appDirectory, "Contents", "MacOS", "ZenX");
  }
  return path.join(appDirectory, platform === "win32" ? "ZenX.exe" : "ZenX");
}

async function requireFile(file) {
  await access(file);
  assert.equal(
    (await stat(file)).isFile(),
    true,
    `required file is missing: ${file}`,
  );
}

async function requireDirectory(directory) {
  await access(directory);
  assert.equal(
    (await stat(directory)).isDirectory(),
    true,
    `required directory is missing: ${directory}`,
  );
}

async function requireExecutable(file, platform) {
  await requireFile(file);
  if (platform !== "win32") {
    assert.notEqual((await stat(file)).mode & 0o111, 0);
  }
}

async function sha256File(file) {
  return createHash("sha256")
    .update(await readFile(file))
    .digest("hex");
}
