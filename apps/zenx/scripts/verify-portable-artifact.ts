import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

import { validatePluginPackage } from "@zenx/plugin-sdk";
import { npmInvocation } from "../../../packages/zenx-plugin-sdk/dist/npm-invocation.mjs";
import {
  resolveBundledProvider,
  type PinnedProviderId,
} from "../src/main/capabilities/provider-provisioning.js";

const run = promisify(execFile);
const zenxRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const repositoryRoot = path.resolve(zenxRoot, "..", "..");
const providerDigestPlaceholder = "__ZENX_PACKAGED_PROVIDER_MANIFEST_SHA256__";

export interface ExpectedPlugin {
  packageIdentity: string;
  pluginId: string;
}

const expectedPlugins = new Map<string, ExpectedPlugin>([
  [
    "zenx-browser-plugin-electron-1.0.0.tgz",
    { packageIdentity: "@zenx/browser-plugin@1.0.0", pluginId: "browser" },
  ],
  [
    "zenx-browser-plugin-playwright-1.0.0.tgz",
    { packageIdentity: "@zenx/browser-plugin@1.0.0", pluginId: "browser" },
  ],
  [
    "zenx-browser-plugin-user-session-1.0.0.tgz",
    { packageIdentity: "@zenx/browser-plugin@1.0.0", pluginId: "browser" },
  ],
  [
    "zenx-computer-plugin-macos-1.0.0.tgz",
    { packageIdentity: "@zenx/computer-plugin@1.0.0", pluginId: "computer" },
  ],
  [
    "zenx-computer-plugin-peekaboo-1.0.0.tgz",
    { packageIdentity: "@zenx/computer-plugin@1.0.0", pluginId: "computer" },
  ],
  [
    "zenx-computer-plugin-win32-1.1.0.tgz",
    { packageIdentity: "@zenx/computer-plugin@1.1.0", pluginId: "computer" },
  ],
  [
    "zenx-rooms-plugin-1.0.0.tgz",
    { packageIdentity: "@zenx/rooms-plugin@1.0.0", pluginId: "zenx-rooms" },
  ],
  [
    "zenx-self-control-plugin-1.0.0.tgz",
    {
      packageIdentity: "@zenx/self-control-plugin@1.0.0",
      pluginId: "zenx-self-control",
    },
  ],
  [
    "zenx-triggers-plugin-1.0.0.tgz",
    {
      packageIdentity: "@zenx/triggers-plugin@1.0.0",
      pluginId: "zenx-triggers",
    },
  ],
]);

export interface PortableArtifactOptions {
  artifactDirectory: string;
  platform: NodeJS.Platform;
  arch: string;
}

if (isDirectExecution()) {
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
}

export async function verifyPortableArtifact(options: PortableArtifactOptions) {
  const appDirectory = applicationDirectory(
    options.artifactDirectory,
    options.platform,
  );
  const resourcesDirectory = resourcesPath(appDirectory, options.platform);
  const executable = executablePath(appDirectory, options.platform);
  const appResources = path.join(resourcesDirectory, "app");
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
  ) as Record<string, unknown>;
  const zenxPackage = JSON.parse(
    await readFile(path.join(zenxRoot, "package.json"), "utf8"),
  ) as {
    version: string;
    devDependencies: { pnpm: string };
  };
  assert.equal(packagedApp.name, "zenx");
  assert.equal(packagedApp.version, zenxPackage.version);
  const pnpmPackage = JSON.parse(
    await readFile(
      path.join(resourcesDirectory, "pnpm", "package.json"),
      "utf8",
    ),
  ) as Record<string, unknown>;
  assert.equal(pnpmPackage.name, "pnpm");
  assert.equal(pnpmPackage.version, zenxPackage.devDependencies.pnpm);
  await requireFile(path.join(resourcesDirectory, "pnpm", "bin", "pnpm.cjs"));

  const marketplace = JSON.parse(
    await readFile(
      path.join(resourcesDirectory, "marketplace", "catalog.json"),
      "utf8",
    ),
  ) as { entries?: unknown[] };
  assert.deepEqual(marketplace, { entries: [] });

  const pluginFiles = (await readdir(plugins))
    .filter((file) => file.endsWith(".tgz"))
    .sort();
  assert.deepEqual(pluginFiles, [...expectedPlugins.keys()].sort());
  const pluginDigests: Record<string, string> = {};
  for (const filename of pluginFiles) {
    const expected = expectedPlugins.get(filename);
    assert.ok(expected, `unexpected first-party plugin tarball: ${filename}`);
    const tarball = path.join(plugins, filename);
    await verifyFirstPartyPluginTarball(tarball, expected);
    pluginDigests[filename] = await sha256File(tarball);
  }

  const providerManifestSha256 = await verifyPortableProviders({
    resourcesDirectory,
    appMainDirectory: path.join(appResources, "out", "main"),
    platform: options.platform,
  });

  if (options.platform === "linux") {
    const providerLock = await readProviderLock();
    const platformKey = `linux-${options.arch === "arm64" ? "arm64" : "x64"}`;
    const browser = providerLock.browser.platformArchives[platformKey];
    assert.ok(browser, `provider lock is missing ${platformKey}`);
    await requireExecutable(
      path.join(
        resourcesDirectory,
        "providers",
        "playwright-browsers",
        `${providerLock.browser.name}-${providerLock.browser.revision}`,
        browser.executable,
      ),
      options.platform,
    );
    await requireFile(
      path.join(
        resourcesDirectory,
        "providers",
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
    marketplaceEntries: marketplace.entries?.length ?? 0,
    firstPartyTarballs: pluginFiles.length,
    pluginSha256: pluginDigests,
    providerManifestSha256,
  };
}

export async function verifyFirstPartyPluginTarball(
  tarball: string,
  expected: ExpectedPlugin,
): Promise<void> {
  const invocation = npmInvocation(["pack", "--dry-run", "--json", tarball]);
  const packed = await run(invocation.executable, invocation.args, {
    cwd: repositoryRoot,
    maxBuffer: 1024 * 1024,
  });
  const [metadata] = JSON.parse(packed.stdout) as Array<{
    name?: string;
    version?: string;
    files?: Array<{ path: string }>;
  }>;
  assert.ok(metadata, `npm could not inspect ${path.basename(tarball)}`);
  assert.equal(
    `${metadata.name}@${metadata.version}`,
    expected.packageIdentity,
  );
  assert.deepEqual(metadata.files?.map(({ path: file }) => file).sort(), [
    "README.md",
    "dist/runtime.js",
    "package.json",
    "zenx.plugin.json",
  ]);

  const staging = await mkdtemp(
    path.join(os.tmpdir(), "zenx-portable-plugin-verify-"),
  );
  try {
    await run("tar", ["-xzf", tarball, "-C", staging]);
    const validated = await validatePluginPackage(
      path.join(staging, "package"),
    );
    assert.equal(
      validated.manifest.id,
      expected.pluginId,
      `first-party tarball ${path.basename(tarball)} has an unexpected plugin id`,
    );
    assert.equal(
      `${validated.packageName}@${validated.packageVersion}`,
      expected.packageIdentity,
    );
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

export async function verifyPortableProviders(options: {
  resourcesDirectory: string;
  appMainDirectory: string;
  platform: NodeJS.Platform;
}): Promise<string> {
  const manifestPath = path.join(
    options.resourcesDirectory,
    "providers",
    "manifest.json",
  );
  const manifestSha256 = await sha256File(manifestPath);
  const trustAnchor = await readPackagedProviderManifestTrustAnchor(
    options.appMainDirectory,
  );
  assert.equal(
    trustAnchor,
    manifestSha256,
    "packaged main provider manifest trust anchor does not match App Resources",
  );

  const lock = await readProviderLock();
  await requireResolvedProvider("playwright-cli", {
    resourcesDirectory: options.resourcesDirectory,
    platform: options.platform,
    expectedVersion: lock.providers["playwright-cli"].version,
    expectedManifestSha256: trustAnchor,
  });
  if (options.platform === "win32") {
    await requireResolvedProvider("microsoft-winapp-cli", {
      resourcesDirectory: options.resourcesDirectory,
      platform: options.platform,
      expectedVersion: lock.providers["microsoft-winapp-cli"].version,
      expectedManifestSha256: trustAnchor,
    });
  }
  return manifestSha256;
}

export async function readPackagedProviderManifestTrustAnchor(
  mainDirectory: string,
): Promise<string> {
  const chunksDirectory = path.join(mainDirectory, "chunks");
  const candidates = (await readdir(chunksDirectory))
    .filter(
      (file) =>
        file.startsWith("packaged-provider-integrity-") &&
        file.endsWith(".js") &&
        file.length > "packaged-provider-integrity-.js".length,
    )
    .sort();
  assert.equal(
    candidates.length,
    1,
    "packaged main must contain exactly one provider integrity chunk",
  );
  const chunkPath = path.join(chunksDirectory, candidates[0]!);
  const source = await readFile(chunkPath, "utf8");
  assert.equal(
    source.includes(providerDigestPlaceholder),
    false,
    "packaged main still contains the provider manifest digest placeholder",
  );
  const declarationPrefix = 'const PACKAGED_PROVIDER_MANIFEST_SHA256 = "';
  const exportBoundary =
    '";\nexport {\n  PACKAGED_PROVIDER_MANIFEST_SHA256 as ';
  const moduleSuffix = "\n};\n";
  assert.equal(
    source.startsWith(declarationPrefix) && source.endsWith(moduleSuffix),
    true,
    "packaged main provider integrity chunk is not the canonical pure module",
  );
  const body = source.slice(
    declarationPrefix.length,
    source.length - moduleSuffix.length,
  );
  const boundaryIndex = body.indexOf(exportBoundary);
  assert.equal(
    boundaryIndex > 0 && boundaryIndex === body.lastIndexOf(exportBoundary),
    true,
    "packaged main provider integrity chunk is not the canonical pure module",
  );
  const digest = body.slice(0, boundaryIndex);
  const exportName = body.slice(boundaryIndex + exportBoundary.length);
  assert.equal(
    isSha256(digest) && isJavaScriptIdentifier(exportName),
    true,
    "packaged main provider integrity chunk has an invalid export binding",
  );
  assert.equal(
    source,
    `${declarationPrefix}${digest}${exportBoundary}${exportName}${moduleSuffix}`,
    "packaged main provider integrity chunk is not the canonical pure module",
  );

  // The strict source shape above permits only one literal declaration and one
  // export, so importing this dedicated chunk cannot load Electron or runtime
  // code. A content-addressed query prevents a prior import from masking edits.
  const chunkUrl = pathToFileURL(chunkPath);
  chunkUrl.searchParams.set(
    "zenxPortableIntegrity",
    createHash("sha256").update(source).digest("hex"),
  );
  const namespace = (await import(chunkUrl.href)) as Record<string, unknown>;
  assert.deepEqual(
    Object.keys(namespace),
    [exportName],
    "packaged main provider integrity chunk has an unexpected export surface",
  );
  assert.equal(
    namespace[exportName],
    digest,
    "packaged main provider integrity export does not match its literal trust anchor",
  );
  return digest;
}

function isSha256(value: string): boolean {
  return (
    value.length === 64 &&
    [...value].every(
      (character) =>
        (character >= "0" && character <= "9") ||
        (character >= "a" && character <= "f"),
    )
  );
}

function isJavaScriptIdentifier(value: string): boolean {
  if (value.length === 0) return false;
  const characters = [...value];
  const isLetter = (character: string) =>
    (character >= "A" && character <= "Z") ||
    (character >= "a" && character <= "z") ||
    character === "_" ||
    character === "$";
  return (
    isLetter(characters[0]!) &&
    characters
      .slice(1)
      .every(
        (character) =>
          isLetter(character) || (character >= "0" && character <= "9"),
      )
  );
}

async function requireResolvedProvider(
  providerId: PinnedProviderId,
  options: Parameters<typeof resolveBundledProvider>[1],
): Promise<void> {
  const resolution = await resolveBundledProvider(providerId, {
    ...options,
    verifyDirectoryAssets: true,
  });
  assert.ok(
    resolution.provider,
    resolution.reason ?? `Bundled ${providerId} could not be resolved`,
  );
}

async function readProviderLock(): Promise<{
  browser: {
    name: string;
    revision: string;
    platformArchives: Record<string, { executable: string }>;
  };
  providers: Record<PinnedProviderId, { version: string }>;
}> {
  return JSON.parse(
    await readFile(
      path.join(zenxRoot, "resources", "providers", "provider-lock.json"),
      "utf8",
    ),
  ) as Awaited<ReturnType<typeof readProviderLock>>;
}

function applicationDirectory(
  artifactDirectory: string,
  platform: NodeJS.Platform,
) {
  return platform === "darwin"
    ? path.join(artifactDirectory, "ZenX.app")
    : artifactDirectory;
}

function resourcesPath(appDirectory: string, platform: NodeJS.Platform) {
  return platform === "darwin"
    ? path.join(appDirectory, "Contents", "Resources")
    : path.join(appDirectory, "resources");
}

function executablePath(appDirectory: string, platform: NodeJS.Platform) {
  if (platform === "darwin") {
    return path.join(appDirectory, "Contents", "MacOS", "ZenX");
  }
  return path.join(appDirectory, platform === "win32" ? "ZenX.exe" : "ZenX");
}

async function requireFile(file: string) {
  await access(file);
  assert.equal(
    (await stat(file)).isFile(),
    true,
    `required file is missing: ${file}`,
  );
}

async function requireDirectory(directory: string) {
  await access(directory);
  assert.equal(
    (await stat(directory)).isDirectory(),
    true,
    `required directory is missing: ${directory}`,
  );
}

async function requireExecutable(file: string, platform: NodeJS.Platform) {
  await requireFile(file);
  if (platform !== "win32") {
    assert.notEqual((await stat(file)).mode & 0o111, 0);
  }
}

async function sha256File(file: string) {
  return createHash("sha256")
    .update(await readFile(file))
    .digest("hex");
}

function isDirectExecution() {
  return (
    process.argv[1] !== undefined &&
    path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  );
}
