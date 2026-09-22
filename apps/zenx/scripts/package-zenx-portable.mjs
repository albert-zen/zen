import { prepareRtkResource } from "./prepare-rtk.mjs";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { packZenXFirstPartyPlugins } from "./pack-first-party-plugins.mjs";
import ts from "typescript";

const run = promisify(execFile);
const zenx = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const root = path.resolve(zenx, "..", "..");
const packagedRoot = path.join(zenx, ".packaged");
const runsRoot = path.join(packagedRoot, "runs");
const artifactRoot = path.join(packagedRoot, "artifact");
const artifactCache = path.join(packagedRoot, "cache", "artifacts");
export const MACOS_MINIMUM_VERSION = "12.0";
export const MACOS_CODESIGN_MODE_ENV = "ZENX_CODESIGN_MODE";

if (isDirectExecution()) await packageZenX(process.argv.slice(2));

async function packageZenX(arguments_) {
  const target = arguments_.includes("--app") ? "app" : "smoke";
  const productName = target === "app" ? "ZenX" : "ZenXProviderSmoke";
  const targetDirectory = `${productName}-${process.platform}-${process.arch}`;
  await withPackagingTargetLock(packagedRoot, targetDirectory, async () => {
    await mkdir(runsRoot, { recursive: true, mode: 0o700 });
    const staging = await mkdtemp(path.join(runsRoot, "package-"));
    try {
      const buildSnapshot = await createBuildSnapshot(staging);
      const resources = path.join(staging, "resources");
      const appDir = path.join(staging, "app");
      const stagedArtifacts = path.join(staging, "artifact");
      const assembly = JSON.parse(
        (
          await run(process.execPath, [
            path.join(root, "scripts", "assemble-zenx-providers.mjs"),
            "--output",
            resources,
            "--cache",
            artifactCache,
          ])
        ).stdout,
      );
      await packZenXFirstPartyPlugins({ outputDirectory: resources });
      const hasRtk = await prepareRtkResource({
        resourcesDirectory: resources,
      });
      const zenxPackage = JSON.parse(
        await readFile(path.join(zenx, "package.json"), "utf8"),
      );
      await stagePackage({
        target,
        outDirectory: buildSnapshot,
        rootDirectory: root,
        appDirectory: appDir,
        manifestSha256: assembly.manifestSha256,
      });
      await writeFile(
        path.join(appDir, "package.json"),
        `${JSON.stringify(packageManifest(target, zenxPackage), null, 2)}\n`,
      );
      const macOsSigningConfiguration = await resolveMacOsSigningConfiguration({
        platform: process.platform,
      });
      const { packager } = await import("@electron/packager");
      const packaged = await packager({
        dir: appDir,
        out: stagedArtifacts,
        overwrite: false,
        platform: process.platform,
        arch: process.arch,
        name: productName,
        electronVersion: "43.2.0",
        ...macOsPackagerOptions(
          process.platform,
          target,
          macOsSigningConfiguration,
        ),
        ...(applicationIconForPlatform(process.platform, target) === undefined
          ? {}
          : { icon: applicationIconForPlatform(process.platform, target) }),
        afterCopy: [
          async ({ buildPath }) => {
            if (hasRtk)
              await cp(
                path.join(resources, "rtk"),
                path.join(path.dirname(buildPath), "rtk"),
                { recursive: true },
              );
            await copyPackagedProviderResources({
              buildPath,
              sourceDirectory: path.join(resources, "providers"),
            });
            await copyMarketplaceCatalogResource({
              buildPath,
              sourceFile: path.join(
                zenx,
                "resources",
                "marketplace",
                "catalog.json",
              ),
            });
            await copyBundledPnpmResource({
              buildPath,
              sourceDirectory: path.join(root, "node_modules", "pnpm"),
              expectedVersion: zenxPackage.devDependencies.pnpm,
            });
            await copyFirstPartyPluginResources({
              buildPath,
              sourceDirectory: path.join(resources, "plugins"),
            });
            await copyChromeExtensionResource({
              buildPath,
              sourceDirectory: path.join(zenx, "resources", "chrome-extension"),
            });
            await copyChromeNativeHostResource({
              buildPath,
              sourceDirectory: path.join(
                zenx,
                "resources",
                "chrome-native-host",
              ),
            });
            if (process.platform === "darwin") {
              await compileMacNativeHelpers({
                destinationDirectory: path.join(
                  path.dirname(buildPath),
                  "native-helpers",
                ),
              });
            }
          },
        ],
        asar: false,
      });
      if (path.basename(packaged[0]) !== targetDirectory) {
        throw new Error(
          `Electron packager returned unexpected target ${path.basename(packaged[0])}`,
        );
      }
      if (target === "smoke") {
        await runExecutable(executablePath(packaged[0], target));
      }
      const publishedArtifact = await publishPackagedArtifact(
        packaged[0],
        path.join(artifactRoot, targetDirectory),
      );
      const executable = executablePath(publishedArtifact, target);
      console.log(
        JSON.stringify(
          {
            packagedArtifact: publishedArtifact,
            executable,
            target,
            version: zenxPackage.version,
            manifestDigest: assembly.manifestSha256,
            releaseSizeBytes: assembly.releaseSizeBytes,
          },
          null,
          2,
        ),
      );
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  });
}

export function applicationIconForPlatform(platform, target = "app") {
  if (target !== "app") return undefined;
  if (platform === "darwin")
    return path.join(zenx, "resources", "icons", "zenx.icns");
  if (platform === "win32")
    return path.join(zenx, "resources", "icons", "zenx.ico");
  return undefined;
}

export function macOsPackagerOptions(
  platform,
  target = "app",
  signingConfiguration = { identity: "-", mode: "ad-hoc" },
) {
  if (platform !== "darwin") return {};
  const { identity, mode } = signingConfiguration;
  if (!["ad-hoc", "local", "developer-id"].includes(mode)) {
    throw new Error(`Unsupported ZenX macOS signing mode: ${String(mode)}`);
  }
  if (mode === "ad-hoc" && identity !== "-") {
    throw new Error('Ad-hoc ZenX macOS signing requires identity "-"');
  }
  if (mode === "local") normalizeLocalSigningIdentity(identity);
  if (mode === "developer-id" && !identity?.trim()) {
    throw new Error("Developer ID signing requires a configured identity");
  }
  return {
    appBundleId:
      target === "app"
        ? "com.electron.zenx"
        : "com.electron.zenx-provider-smoke",
    osxSign: {
      identity,
      ...(mode === "ad-hoc" || mode === "local"
        ? { identityValidation: false }
        : {}),
      continueOnError: false,
      ignore: macPackagedProviderSignIgnore,
      optionsForFile:
        mode === "developer-id"
          ? macNativeHelperSignOptions
          : mode === "local"
            ? macLocalSignOptionsForFile
            : macAdHocSignOptionsForFile,
      preAutoEntitlements: false,
      strictVerify: true,
    },
  };
}

export async function resolveMacOsSigningConfiguration({
  platform = process.platform,
  environment = process.env,
  homeDirectory = os.homedir(),
  readFile: readSigningFile = readFile,
} = {}) {
  if (platform !== "darwin") return { identity: "-", mode: "ad-hoc" };

  const explicitIdentity = environment.ZENX_CODESIGN_IDENTITY?.trim();
  const explicitMode = environment[MACOS_CODESIGN_MODE_ENV]?.trim();
  if (
    explicitMode !== undefined &&
    explicitMode !== "" &&
    explicitMode !== "local"
  ) {
    throw new Error(
      `${MACOS_CODESIGN_MODE_ENV} must be "local" when it is configured`,
    );
  }
  if (explicitMode === "local") {
    if (!explicitIdentity) {
      throw new Error(
        `ZENX_CODESIGN_IDENTITY is required when ${MACOS_CODESIGN_MODE_ENV}=local`,
      );
    }
    return {
      identity: normalizeLocalSigningIdentity(explicitIdentity),
      mode: "local",
    };
  }
  if (explicitIdentity === "-") {
    return { identity: "-", mode: "ad-hoc" };
  }
  if (explicitIdentity) {
    return { identity: explicitIdentity, mode: "developer-id" };
  }

  const configurationPath = path.join(
    homeDirectory,
    "Library",
    "Application Support",
    "ZenX",
    "signing.json",
  );
  let source;
  try {
    source = await readSigningFile(configurationPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return { identity: "-", mode: "ad-hoc" };
    throw new Error(
      `Could not read ZenX macOS signing configuration at ${configurationPath}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }

  let configuration;
  try {
    configuration = JSON.parse(source);
  } catch (error) {
    throw new Error(
      `Invalid ZenX macOS signing configuration at ${configurationPath}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (
    configuration === null ||
    typeof configuration !== "object" ||
    Array.isArray(configuration) ||
    configuration.mode !== "local"
  ) {
    throw new Error(
      `Invalid ZenX macOS signing configuration at ${configurationPath}: mode must be "local"`,
    );
  }
  return {
    identity: normalizeLocalSigningIdentity(configuration.identity),
    mode: "local",
  };
}

function normalizeLocalSigningIdentity(identity) {
  if (
    typeof identity !== "string" ||
    !/^[a-f\d]{40}$/iu.test(identity.trim())
  ) {
    throw new Error(
      "A local ZenX signing identity must be a 40-character SHA-1 certificate fingerprint",
    );
  }
  return identity.trim().toUpperCase();
}

export function macPackagedProviderSignIgnore(filePath) {
  return filePath
    .split(path.sep)
    .join("/")
    .includes("/Contents/Resources/providers/");
}

export function macAdHocSignOptionsForFile(filePath) {
  return {
    entitlements: [],
    hardenedRuntime: false,
  };
}

export function macLocalSignOptionsForFile(filePath) {
  const pathComponents = filePath.split(/[\\/]/u);
  const executableName = pathComponents.at(-1);
  const helperIdentifiers = {
    "zenx-accessibility": "com.electron.zenx.native-helper.zenx-accessibility",
    "zenx-foreground-input":
      "com.electron.zenx.native-helper.zenx-foreground-input",
  };
  return {
    entitlements: [],
    hardenedRuntime: false,
    timestamp: "none",
    ...(!pathComponents.includes("native-helpers") ||
    helperIdentifiers[executableName] === undefined
      ? {}
      : {
          additionalArguments: [
            "--identifier",
            helperIdentifiers[executableName],
          ],
        }),
  };
}

export function macNativeHelperSignOptions(filePath) {
  return filePath.split(path.sep).includes("native-helpers")
    ? { entitlements: [] }
    : null;
}

export function extractMacNativeHelperSources(source) {
  const sourceFile = ts.createSourceFile(
    "computer-provider.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const names = new Set([
    "MAC_ACCESSIBILITY_SOURCE",
    "MAC_FOREGROUND_INPUT_SOURCE",
  ]);
  const sources = {};
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (
        ts.isIdentifier(declaration.name) &&
        names.has(declaration.name.text) &&
        declaration.initializer !== undefined &&
        ts.isNoSubstitutionTemplateLiteral(declaration.initializer)
      ) {
        sources[declaration.name.text] = declaration.initializer.text;
      }
    }
  }
  for (const name of names) {
    if (typeof sources[name] !== "string" || sources[name].length === 0) {
      throw new Error(
        `Could not extract ${name} from Computer provider source`,
      );
    }
  }
  return sources;
}

export async function compileMacNativeHelpers(options) {
  const providerSource =
    options.providerSource ??
    (await readFile(
      path.join(zenx, "src", "main", "capabilities", "computer-provider.ts"),
      "utf8",
    ));
  const sources = extractMacNativeHelperSources(providerSource);
  const compile =
    options.compile ??
    ((sourcePath, executablePath) =>
      compileSwiftHelper(
        sourcePath,
        executablePath,
        options.arch ?? process.arch,
      ));
  await mkdir(options.destinationDirectory, { recursive: true, mode: 0o755 });
  await chmod(options.destinationDirectory, 0o755);
  const sourceDirectory = await mkdtemp(
    path.join(
      path.dirname(options.destinationDirectory),
      ".native-helper-source-",
    ),
  );
  try {
    for (const [name, source] of [
      ["zenx-accessibility", sources.MAC_ACCESSIBILITY_SOURCE],
      ["zenx-foreground-input", sources.MAC_FOREGROUND_INPUT_SOURCE],
    ]) {
      const sourcePath = path.join(sourceDirectory, `${name}.swift`);
      const executablePath = path.join(options.destinationDirectory, name);
      await writeFile(sourcePath, source, { encoding: "utf8", mode: 0o600 });
      await compile(sourcePath, executablePath);
      await chmod(executablePath, 0o755);
    }
  } finally {
    await rm(sourceDirectory, { recursive: true, force: true });
  }
  return options.destinationDirectory;
}

export function macSwiftTargetTriple(arch) {
  if (arch === "arm64") return `arm64-apple-macos${MACOS_MINIMUM_VERSION}`;
  if (arch === "x64") return `x86_64-apple-macos${MACOS_MINIMUM_VERSION}`;
  throw new Error(`Unsupported macOS helper architecture: ${arch}`);
}

export function assertMacNativeHelperDeploymentTarget(
  buildMetadata,
  expectedMinimum = MACOS_MINIMUM_VERSION,
) {
  if (!/^\s*platform MACOS\s*$/mu.test(buildMetadata)) {
    throw new Error("macOS Computer helper has no MACOS build platform");
  }
  const minimum = /^\s*minos\s+([0-9.]+)\s*$/mu.exec(buildMetadata)?.[1];
  if (minimum !== expectedMinimum) {
    throw new Error(
      `macOS Computer helper minimum system ${minimum ?? "missing"}; expected ${expectedMinimum}`,
    );
  }
}

async function compileSwiftHelper(sourcePath, executablePath, arch) {
  await run(
    "/usr/bin/swiftc",
    [
      "-O",
      "-target",
      macSwiftTargetTriple(arch),
      sourcePath,
      "-o",
      executablePath,
    ],
    { timeout: 60_000 },
  );
  const { stdout } = await run(
    "/usr/bin/vtool",
    ["-show-build", executablePath],
    { timeout: 10_000 },
  );
  assertMacNativeHelperDeploymentTarget(stdout);
}

/** Build only into the current packaging run before anything snapshots it. */
export async function createBuildSnapshot(
  stagingDirectory,
  build = runZenXBuild,
) {
  const buildDirectory = path.join(stagingDirectory, "build");
  await build(buildDirectory);
  return buildDirectory;
}

async function runZenXBuild(buildDirectory) {
  await run(
    process.execPath,
    [
      path.join(
        root,
        "node_modules",
        "electron-vite",
        "bin",
        "electron-vite.js",
      ),
      "build",
      "--outDir",
      buildDirectory,
    ],
    { cwd: zenx },
  );
}

export async function withPackagingTargetLock(
  packageRoot,
  targetDirectory,
  action,
) {
  const locks = path.join(packageRoot, "locks");
  await mkdir(locks, { recursive: true, mode: 0o700 });
  const lockPath = path.join(locks, `${targetDirectory}.lock`);
  let lock;
  try {
    lock = await open(lockPath, "wx", 0o600);
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw new Error(
        `Packaging target ${targetDirectory} is already in progress; if no packaging process is active, remove the stale lock explicitly`,
      );
    }
    throw error;
  }
  try {
    await lock.writeFile(`${String(process.pid)} ${randomUUID()}\n`);
    await lock.sync();
    return await action();
  } finally {
    await lock.close();
    await rm(lockPath, { force: true });
  }
}

export async function publishPackagedArtifact(stagedArtifact, finalArtifact) {
  await mkdir(path.dirname(finalArtifact), { recursive: true, mode: 0o700 });
  const retiredArtifact = path.join(
    path.dirname(finalArtifact),
    `.${path.basename(finalArtifact)}.${randomUUID()}.retired`,
  );
  let retired = false;
  try {
    await rename(finalArtifact, retiredArtifact);
    retired = true;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  try {
    await rename(stagedArtifact, finalArtifact);
  } catch (error) {
    if (retired) await rename(retiredArtifact, finalArtifact);
    throw error;
  }
  if (retired) {
    await rm(retiredArtifact, { recursive: true, force: true });
  }
  return finalArtifact;
}

export async function stagePackage(options) {
  const stagedMain =
    options.target === "app"
      ? path.join(options.appDirectory, "out", "main")
      : path.join(options.appDirectory, "main");
  if (options.target === "app") {
    await cp(options.outDirectory, path.join(options.appDirectory, "out"), {
      recursive: true,
    });
    await cp(
      path.join(options.rootDirectory, "node_modules", "ws"),
      path.join(options.appDirectory, "node_modules", "ws"),
      { recursive: true },
    );
    const pluginSdkSource = path.join(
      options.rootDirectory,
      "node_modules",
      "@zenx",
      "plugin-sdk",
    );
    const pluginSdkDestination = path.join(
      options.appDirectory,
      "node_modules",
      "@zenx",
      "plugin-sdk",
    );
    await mkdir(pluginSdkDestination, { recursive: true, mode: 0o700 });
    await Promise.all([
      cp(
        path.join(pluginSdkSource, "package.json"),
        path.join(pluginSdkDestination, "package.json"),
      ),
      cp(
        path.join(pluginSdkSource, "dist"),
        path.join(pluginSdkDestination, "dist"),
        { recursive: true },
      ),
    ]);
  } else {
    await cp(path.join(options.outDirectory, "main"), stagedMain, {
      recursive: true,
    });
  }
  await injectProviderManifestDigest(stagedMain, options.manifestSha256);
}

export async function copyPackagedProviderResources(options) {
  const resourcesDirectory = path.dirname(options.buildPath);
  const destination = path.join(
    resourcesDirectory,
    path.basename(options.sourceDirectory),
  );
  await mkdir(resourcesDirectory, { recursive: true, mode: 0o700 });
  await cp(options.sourceDirectory, destination, {
    recursive: true,
    verbatimSymlinks: true,
  });
  return destination;
}

export async function copyBundledPnpmResource(options) {
  const packageManifest = JSON.parse(
    await readFile(path.join(options.sourceDirectory, "package.json"), "utf8"),
  );
  if (
    packageManifest.name !== "pnpm" ||
    (options.expectedVersion !== undefined &&
      packageManifest.version !== options.expectedVersion)
  ) {
    throw new Error(
      `Bundled pnpm resource version mismatch: ${String(packageManifest.version)}`,
    );
  }
  const resourcesDirectory = path.dirname(options.buildPath);
  const destination = path.join(resourcesDirectory, "pnpm");
  await mkdir(resourcesDirectory, { recursive: true, mode: 0o700 });
  await cp(options.sourceDirectory, destination, { recursive: true });
  return destination;
}

export async function copyFirstPartyPluginResources(options) {
  const resourcesDirectory = path.dirname(options.buildPath);
  const destination = path.join(resourcesDirectory, "plugins");
  await mkdir(resourcesDirectory, { recursive: true, mode: 0o700 });
  await cp(options.sourceDirectory, destination, { recursive: true });
  return destination;
}

export async function copyChromeExtensionResource(options) {
  const resourcesDirectory = path.dirname(options.buildPath);
  const destination = path.join(resourcesDirectory, "chrome-extension");
  await mkdir(resourcesDirectory, { recursive: true, mode: 0o700 });
  await cp(options.sourceDirectory, destination, { recursive: true });
  return destination;
}

export async function copyChromeNativeHostResource(options) {
  const resourcesDirectory = path.dirname(options.buildPath);
  const destination = path.join(resourcesDirectory, "chrome-native-host");
  await mkdir(resourcesDirectory, { recursive: true, mode: 0o700 });
  await cp(options.sourceDirectory, destination, { recursive: true });
  return destination;
}

export async function copyMarketplaceCatalogResource(options) {
  const resourcesDirectory = path.dirname(options.buildPath);
  const destination = path.join(
    resourcesDirectory,
    "marketplace",
    "catalog.json",
  );
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  await cp(options.sourceFile, destination);
  return destination;
}

export function packageManifest(target, zenxPackage) {
  return target === "app"
    ? {
        name: "zenx",
        version: zenxPackage.version,
        private: true,
        type: "module",
        main: "out/main/index.js",
        dependencies: {
          "@zenx/plugin-sdk": zenxPackage.dependencies["@zenx/plugin-sdk"],
          ws: zenxPackage.dependencies.ws,
        },
      }
    : {
        name: "zenx-packaged-provider-smoke",
        version: zenxPackage.version,
        private: true,
        type: "module",
        main: "main/packaged-provider-smoke.js",
      };
}

function isDirectExecution() {
  return (
    process.argv[1] !== undefined &&
    path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  );
}

async function injectProviderManifestDigest(mainDirectory, manifestSha256) {
  let replacements = 0;
  for (const file of await walk(mainDirectory)) {
    if (!file.endsWith(".js")) continue;
    const source = await readFile(file, "utf8");
    if (!source.includes("__ZENX_PACKAGED_PROVIDER_MANIFEST_SHA256__")) {
      continue;
    }
    await writeFile(
      file,
      source.replaceAll(
        "__ZENX_PACKAGED_PROVIDER_MANIFEST_SHA256__",
        manifestSha256,
      ),
    );
    replacements += 1;
  }
  if (replacements === 0) {
    throw new Error(
      "built ZenX main output has no provider manifest placeholder",
    );
  }
}

async function walk(rootDir) {
  const result = [];
  const { readdir } = await import("node:fs/promises");
  for (const entry of await readdir(rootDir, { withFileTypes: true })) {
    const candidate = path.join(rootDir, entry.name);
    if (entry.isDirectory()) result.push(...(await walk(candidate)));
    else result.push(candidate);
  }
  return result;
}

function executablePath(appPath, packageTarget) {
  const executableName = packageTarget === "app" ? "ZenX" : "ZenXProviderSmoke";
  if (process.platform === "win32")
    return path.join(appPath, `${executableName}.exe`);
  if (process.platform === "darwin") {
    return path.join(
      appPath,
      `${executableName}.app`,
      "Contents",
      "MacOS",
      executableName,
    );
  }
  return path.join(appPath, executableName);
}

async function runExecutable(executable) {
  await new Promise((resolve, reject) => {
    const child = spawn(executable, [], {
      stdio: "inherit",
      windowsHide: true,
      env: { ...process.env, ZENX_PACKAGED_SMOKE: "1" },
    });
    child.once("error", reject);
    child.once("exit", (code, signal) =>
      code === 0
        ? resolve()
        : reject(
            new Error(
              `packaged provider smoke exited ${String(code)} ${signal ?? ""}`,
            ),
          ),
    );
  });
}
