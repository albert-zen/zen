import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  readlink,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  applicationIconForPlatform,
  assertMacNativeHelperDeploymentTarget,
  copyChromeExtensionResource,
  copyBundledPnpmResource,
  copyFirstPartyPluginResources,
  copyMarketplaceCatalogResource,
  copyPackagedProviderResources,
  compileMacNativeHelpers,
  createBuildSnapshot,
  extractMacNativeHelperSources,
  MACOS_MINIMUM_VERSION,
  MACOS_CODESIGN_MODE_ENV,
  macAdHocSignOptionsForFile,
  macLocalSignOptionsForFile,
  macNativeHelperSignOptions,
  macOsPackagerOptions,
  macPackagedProviderSignIgnore,
  macSwiftTargetTriple,
  packageManifest,
  publishPackagedArtifact,
  resolveMacOsSigningConfiguration,
  stagePackage,
  withPackagingTargetLock,
} from "../scripts/package-zenx-portable.mjs";
import {
  BUNDLED_PNPM_VERSION,
  resolveBundledPnpmCli,
} from "../src/main/plugin-profile.js";

const placeholder = "__ZENX_PACKAGED_PROVIDER_MANIFEST_SHA256__";
const run = promisify(execFile);

test("uses production platform icons only for packaged applications", () => {
  assert.equal(
    path.basename(applicationIconForPlatform("darwin", "app")),
    "zenx.icns",
  );
  assert.equal(applicationIconForPlatform("darwin", "smoke"), undefined);
  assert.equal(
    path.basename(applicationIconForPlatform("win32", "app")),
    "zenx.ico",
  );
  assert.equal(applicationIconForPlatform("win32", "smoke"), undefined);
  assert.equal(applicationIconForPlatform("linux", "app"), undefined);
});

test("uses a stable macOS bundle ID and fail-closed ad-hoc signing by default", () => {
  assert.deepEqual(macOsPackagerOptions("linux", "app"), {});
  const adHoc = macOsPackagerOptions("darwin", "app");
  assert.equal(adHoc.appBundleId, "com.electron.zenx");
  assert.equal(
    adHoc.extendInfo.NSScreenCaptureUsageDescription,
    "ZenX captures the target window for Computer screenshot tools.",
  );
  assert.deepEqual(adHoc.osxSign, {
    identity: "-",
    identityValidation: false,
    continueOnError: false,
    ignore: macPackagedProviderSignIgnore,
    optionsForFile: macAdHocSignOptionsForFile,
    preAutoEntitlements: false,
    strictVerify: true,
  });
  assert.deepEqual(
    macOsPackagerOptions("darwin", "app", {
      identity: "Developer ID Application: Example",
      mode: "developer-id",
    }).osxSign,
    {
      identity: "Developer ID Application: Example",
      continueOnError: false,
      ignore: macPackagedProviderSignIgnore,
      optionsForFile: macNativeHelperSignOptions,
      preAutoEntitlements: false,
      strictVerify: true,
    },
  );
  assert.equal(
    macOsPackagerOptions("darwin", "smoke").appBundleId,
    "com.electron.zenx-provider-smoke",
  );
  assert.deepEqual(
    macNativeHelperSignOptions(
      "/Applications/ZenX.app/Contents/Resources/native-helpers/zenx-accessibility",
    ),
    { entitlements: [] },
  );
  assert.equal(
    macNativeHelperSignOptions("/Applications/ZenX.app/Contents/MacOS/ZenX"),
    null,
  );
  assert.deepEqual(
    macAdHocSignOptionsForFile(
      "/Applications/ZenX.app/Contents/Resources/native-helpers/zenx-accessibility",
    ),
    { entitlements: [], hardenedRuntime: false },
  );
  assert.deepEqual(
    macAdHocSignOptionsForFile(
      "/Applications/ZenX.app/Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework",
    ),
    { entitlements: [], hardenedRuntime: false },
  );
  assert.equal(
    macPackagedProviderSignIgnore(
      "/tmp/ZenX.app/Contents/Resources/providers/runtime/node",
    ),
    true,
  );
  assert.equal(
    macPackagedProviderSignIgnore(
      "/tmp/ZenX.app/Contents/Resources/native-helpers/zenx-accessibility",
    ),
    false,
  );
  assert.equal(
    macPackagedProviderSignIgnore(
      "/tmp/ZenX.app/Contents/Frameworks/Electron Framework.framework/Electron Framework",
    ),
    false,
  );
});

test("uses stable local identity signing without Apple Team ID assumptions", () => {
  const identity = "0123456789ABCDEF0123456789ABCDEF01234567";
  const local = macOsPackagerOptions("darwin", "app", {
    identity,
    mode: "local",
  });
  assert.equal(local.appBundleId, "com.electron.zenx");
  assert.deepEqual(local.osxSign, {
    identity,
    identityValidation: false,
    continueOnError: false,
    ignore: macPackagedProviderSignIgnore,
    optionsForFile: macLocalSignOptionsForFile,
    preAutoEntitlements: false,
    strictVerify: true,
  });
  assert.deepEqual(
    macLocalSignOptionsForFile(
      "/Applications/ZenX.app/Contents/Resources/native-helpers/zenx-accessibility",
    ),
    {
      entitlements: [],
      hardenedRuntime: false,
      timestamp: "none",
      additionalArguments: [
        "--identifier",
        "com.electron.zenx.native-helper.zenx-accessibility",
      ],
    },
  );
  assert.deepEqual(
    macLocalSignOptionsForFile(
      "/Applications/ZenX.app/Contents/Resources/native-helpers/zenx-foreground-input",
    ),
    {
      entitlements: [],
      hardenedRuntime: false,
      timestamp: "none",
      additionalArguments: [
        "--identifier",
        "com.electron.zenx.native-helper.zenx-foreground-input",
      ],
    },
  );
  assert.deepEqual(
    macLocalSignOptionsForFile(
      "/Applications/ZenX.app/Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework",
    ),
    {
      entitlements: [],
      hardenedRuntime: false,
      timestamp: "none",
    },
  );
  assert.deepEqual(
    macLocalSignOptionsForFile(
      "/Applications/ZenX.app/Contents/MacOS/zenx-accessibility",
    ),
    {
      entitlements: [],
      hardenedRuntime: false,
      timestamp: "none",
    },
  );
});

test("resolves local macOS signing config and lets an explicit identity override it", async () => {
  const localIdentity = "0123456789abcdef0123456789abcdef01234567";
  const readCalls = [];
  const local = await resolveMacOsSigningConfiguration({
    platform: "darwin",
    environment: {},
    homeDirectory: "/Users/example",
    readFile: async (filePath, encoding) => {
      readCalls.push([filePath, encoding]);
      return JSON.stringify({ identity: localIdentity, mode: "local" });
    },
  });
  assert.deepEqual(local, {
    identity: localIdentity.toUpperCase(),
    mode: "local",
  });
  assert.deepEqual(readCalls, [
    ["/Users/example/Library/Application Support/ZenX/signing.json", "utf8"],
  ]);

  let configRead = false;
  const developerId = await resolveMacOsSigningConfiguration({
    platform: "darwin",
    environment: {
      ZENX_CODESIGN_IDENTITY: "Developer ID Application: Example",
    },
    readFile: async () => {
      configRead = true;
      throw new Error("config should not be read");
    },
  });
  assert.deepEqual(developerId, {
    identity: "Developer ID Application: Example",
    mode: "developer-id",
  });
  assert.equal(configRead, false);

  const adHoc = await resolveMacOsSigningConfiguration({
    platform: "darwin",
    environment: { ZENX_CODESIGN_IDENTITY: "-" },
    readFile: async () => {
      throw new Error("config should not be read");
    },
  });
  assert.deepEqual(adHoc, { identity: "-", mode: "ad-hoc" });

  const explicitLocal = await resolveMacOsSigningConfiguration({
    platform: "darwin",
    environment: {
      ZENX_CODESIGN_IDENTITY: localIdentity,
      [MACOS_CODESIGN_MODE_ENV]: "local",
    },
    readFile: async () => {
      throw new Error("config should not be read");
    },
  });
  assert.deepEqual(explicitLocal, {
    identity: localIdentity.toUpperCase(),
    mode: "local",
  });
});

test("keeps missing local config ad-hoc but rejects malformed or incomplete explicit config", async () => {
  const missing = Object.assign(new Error("missing"), { code: "ENOENT" });
  assert.deepEqual(
    await resolveMacOsSigningConfiguration({
      platform: "darwin",
      environment: {},
      readFile: async () => {
        throw missing;
      },
    }),
    { identity: "-", mode: "ad-hoc" },
  );
  assert.deepEqual(
    await resolveMacOsSigningConfiguration({
      platform: "linux",
      environment: {},
      readFile: async () => {
        throw new Error("non-macOS must not read signing config");
      },
    }),
    { identity: "-", mode: "ad-hoc" },
  );

  await assert.rejects(
    resolveMacOsSigningConfiguration({
      platform: "darwin",
      environment: {},
      readFile: async () => "{bad json",
    }),
    /Invalid ZenX macOS signing configuration/u,
  );
  await assert.rejects(
    resolveMacOsSigningConfiguration({
      platform: "darwin",
      environment: {},
      readFile: async () => JSON.stringify({ mode: "local" }),
    }),
    /40-character SHA-1/u,
  );
  await assert.rejects(
    resolveMacOsSigningConfiguration({
      platform: "darwin",
      environment: {},
      readFile: async () =>
        JSON.stringify({
          identity: "0123456789ABCDEF0123456789ABCDEF01234567",
          mode: "developer-id",
        }),
    }),
    /mode must be "local"/u,
  );
  await assert.rejects(
    resolveMacOsSigningConfiguration({
      platform: "darwin",
      environment: {
        [MACOS_CODESIGN_MODE_ENV]: "local",
      },
      readFile: async () => {
        throw new Error("config should not be read");
      },
    }),
    /ZENX_CODESIGN_IDENTITY is required/u,
  );
  await assert.rejects(
    resolveMacOsSigningConfiguration({
      platform: "darwin",
      environment: {
        ZENX_CODESIGN_IDENTITY: "not-a-sha",
        [MACOS_CODESIGN_MODE_ENV]: "local",
      },
      readFile: async () => {
        throw new Error("config should not be read");
      },
    }),
    /40-character SHA-1/u,
  );
});

test("pins helper architecture and deployment target to the app minimum", () => {
  assert.equal(MACOS_MINIMUM_VERSION, "12.0");
  assert.equal(macSwiftTargetTriple("arm64"), "arm64-apple-macos12.0");
  assert.equal(macSwiftTargetTriple("x64"), "x86_64-apple-macos12.0");
  assert.throws(
    () => macSwiftTargetTriple("ia32"),
    /Unsupported macOS helper architecture/u,
  );
  assert.doesNotThrow(() =>
    assertMacNativeHelperDeploymentTarget(`Load command 11
      cmd LC_BUILD_VERSION
 platform MACOS
   minos 12.0
     sdk 26.5`),
  );
  assert.throws(
    () =>
      assertMacNativeHelperDeploymentTarget(`platform MACOS
 minos 26.0`),
    /minimum system 26\.0; expected 12\.0/u,
  );
  assert.throws(
    () => assertMacNativeHelperDeploymentTarget("platform IOS\n minos 12.0"),
    /no MACOS build platform/u,
  );
});

test("extracts and compiles both fixed macOS Computer helpers into App Resources", async () => {
  const providerSource = await readFile(
    new URL("../src/main/capabilities/computer-provider.ts", import.meta.url),
    "utf8",
  );
  const sources = extractMacNativeHelperSources(providerSource);
  assert.match(sources.MAC_ACCESSIBILITY_SOURCE, /AXIsProcessTrusted/u);
  assert.match(
    sources.MAC_ACCESSIBILITY_SOURCE,
    /current ZenX\.app is already enabled/u,
  );
  assert.match(
    sources.MAC_ACCESSIBILITY_SOURCE,
    /visitLimit: Int = 1024, maxDepth: Int = 24/u,
  );
  assert.match(
    sources.MAC_ACCESSIBILITY_SOURCE,
    /let outputLimit = 120[\s\S]*?prefix\(outputLimit\)/u,
  );
  const listWindows = sources.MAC_ACCESSIBILITY_SOURCE.match(
    /if operation == "listWindows"[\s\S]*?exit\(0\)/u,
  )?.[0];
  assert.ok(listWindows);
  const listRoleActivation = listWindows.indexOf(
    "_ = textAttribute(element, kAXRoleAttribute)",
  );
  const listWindowResolution = listWindows.indexOf(
    "elementArrayAttribute(element, kAXWindowsAttribute)",
  );
  assert.ok(listRoleActivation >= 0);
  assert.ok(listWindowResolution > listRoleActivation);
  const roleActivation = sources.MAC_ACCESSIBILITY_SOURCE.indexOf(
    "_ = textAttribute(appElement, kAXRoleAttribute)",
  );
  const windowResolution = sources.MAC_ACCESSIBILITY_SOURCE.indexOf(
    "elementArrayAttribute(appElement, kAXWindowsAttribute)",
  );
  assert.ok(roleActivation >= 0);
  assert.ok(windowResolution > roleActivation);
  for (const field of [
    "visitedCount",
    "visitLimitReached",
    "depthLimitReached",
    "outputLimitReached",
    "actionableCount",
    "semanticCount",
    "fallbackCount",
    "encounteredWebArea",
    "webAreaControlCount",
    "webAreaActionableCount",
  ]) {
    assert.match(sources.MAC_ACCESSIBILITY_SOURCE, new RegExp(field));
  }
  const displayLabel = sources.MAC_ACCESSIBILITY_SOURCE.match(
    /func displayLabel[\s\S]*?func isContainerRole/u,
  )?.[0];
  assert.ok(displayLabel);
  assert.match(displayLabel, /kAXDescriptionAttribute/u);
  assert.match(displayLabel, /kAXHelpAttribute/u);
  assert.doesNotMatch(displayLabel, /kAXValueAttribute/u);
  assert.match(
    sources.MAC_ACCESSIBILITY_SOURCE,
    /func supportsTextValue[\s\S]*?AXTextField[\s\S]*?isSettable/u,
  );
  assert.match(
    sources.MAC_ACCESSIBILITY_SOURCE,
    /guard supportsTextValue\(element\) else/u,
  );
  assert.match(
    sources.MAC_ACCESSIBILITY_SOURCE,
    /kCGWindowOwnerPID[\s\S]*?kCGWindowLayer[\s\S]*?cgWindowBounds/u,
  );
  assert.match(
    sources.MAC_ACCESSIBILITY_SOURCE,
    /geometryMatches\.count > 1[\s\S]*?mapping is ambiguous/u,
  );

  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-native-helper-resource-"),
  );
  try {
    const destinationDirectory = path.join(directory, "native-helpers");
    const compiled = [];
    await compileMacNativeHelpers({
      destinationDirectory,
      providerSource,
      compile: async (sourcePath, executablePath) => {
        if (process.platform === "darwin") {
          await run("/usr/bin/swiftc", ["-typecheck", sourcePath]);
        }
        compiled.push({
          name: path.basename(executablePath),
          source: await readFile(sourcePath, "utf8"),
        });
        await writeFile(executablePath, "fixture", { mode: 0o600 });
      },
    });
    assert.deepEqual(
      compiled.map(({ name }) => name),
      ["zenx-accessibility", "zenx-foreground-input"],
    );
    assert.equal(compiled[0].source, sources.MAC_ACCESSIBILITY_SOURCE);
    assert.equal(compiled[1].source, sources.MAC_FOREGROUND_INPUT_SOURCE);
    assert.equal((await stat(destinationDirectory)).mode & 0o777, 0o755);
    for (const { name } of compiled) {
      const mode = (await stat(path.join(destinationDirectory, name))).mode;
      assert.notEqual(mode & 0o100, 0);
    }
    assert.deepEqual((await readdir(directory)).sort(), ["native-helpers"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("copies packaged provider symlinks verbatim into the platform resources directory", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-provider-resource-copy-test-"),
  );
  try {
    const sourceDirectory = path.join(directory, "source", "providers");
    const versionDirectory = path.join(
      sourceDirectory,
      "playwright-browsers",
      "chromium-fixture",
      "Chromium.app",
      "Contents",
      "Frameworks",
      "Chromium Framework.framework",
      "Versions",
    );
    await mkdir(path.join(versionDirectory, "fixture-version"), {
      recursive: true,
    });
    await symlink("fixture-version", path.join(versionDirectory, "Current"));

    const buildPath = path.join(
      directory,
      "build",
      "ZenX.app",
      "Contents",
      "Resources",
      "app",
    );
    const packagedProviders = await copyPackagedProviderResources({
      buildPath,
      sourceDirectory,
    });
    const packagedLink = path.join(
      packagedProviders,
      "playwright-browsers",
      "chromium-fixture",
      "Chromium.app",
      "Contents",
      "Frameworks",
      "Chromium Framework.framework",
      "Versions",
      "Current",
    );
    const target = await readlink(packagedLink);
    assert.equal(target, "fixture-version");
    assert.equal(path.isAbsolute(target), false);
    assert.equal(
      path
        .resolve(path.dirname(packagedLink), target)
        .startsWith(`${packagedProviders}${path.sep}`),
      true,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("copies the fixed pnpm CLI into App Resources instead of relying on PATH", async () => {
  const zenxPackage = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  assert.equal(zenxPackage.devDependencies.pnpm, BUNDLED_PNPM_VERSION);
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-pnpm-resource-"),
  );
  try {
    const source = path.join(directory, "source", "pnpm");
    await mkdir(path.join(source, "bin"), { recursive: true });
    await Promise.all([
      writeFile(
        path.join(source, "package.json"),
        `${JSON.stringify({ name: "pnpm", version: BUNDLED_PNPM_VERSION })}\n`,
      ),
      writeFile(path.join(source, "bin", "pnpm.cjs"), "fixed pnpm cli"),
    ]);
    const buildPath = path.join(
      directory,
      "build",
      "ZenX.app",
      "Contents",
      "Resources",
      "app",
    );
    const destination = await copyBundledPnpmResource({
      buildPath,
      sourceDirectory: source,
      expectedVersion: BUNDLED_PNPM_VERSION,
    });
    assert.equal(
      await readFile(path.join(destination, "bin", "pnpm.cjs"), "utf8"),
      "fixed pnpm cli",
    );
    assert.equal(
      JSON.parse(await readFile(path.join(destination, "package.json"), "utf8"))
        .version,
      BUNDLED_PNPM_VERSION,
    );
    assert.equal(
      await resolveBundledPnpmCli({
        resourcesDirectory: path.dirname(buildPath),
      }),
      await realpath(path.join(destination, "bin", "pnpm.cjs")),
    );
    await writeFile(
      path.join(destination, "package.json"),
      `${JSON.stringify({ name: "pnpm", version: "0.0.0" })}\n`,
    );
    await assert.rejects(
      resolveBundledPnpmCli({ resourcesDirectory: path.dirname(buildPath) }),
      new RegExp(`requires bundled pnpm ${BUNDLED_PNPM_VERSION}`, "u"),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("copies first-party plugin tarballs into App Resources", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-plugin-resource-"),
  );
  try {
    const sourceDirectory = path.join(directory, "source", "plugins");
    await mkdir(sourceDirectory, { recursive: true });
    await writeFile(
      path.join(sourceDirectory, "zenx-rooms-plugin-1.0.0.tgz"),
      "rooms tarball",
    );
    const buildPath = path.join(
      directory,
      "build",
      "ZenX.app",
      "Contents",
      "Resources",
      "app",
    );
    const destination = await copyFirstPartyPluginResources({
      buildPath,
      sourceDirectory,
    });
    assert.equal(
      await readFile(
        path.join(destination, "zenx-rooms-plugin-1.0.0.tgz"),
        "utf8",
      ),
      "rooms tarball",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("copies the fixed Chrome extension into App Resources", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-chrome-extension-resource-"),
  );
  try {
    const sourceDirectory = path.join(directory, "source", "chrome-extension");
    await mkdir(sourceDirectory, { recursive: true });
    await writeFile(
      path.join(sourceDirectory, "manifest.json"),
      '{"manifest_version":3}\n',
    );
    await writeFile(
      path.join(sourceDirectory, "service-worker.js"),
      "// fixture\n",
    );
    const buildPath = path.join(
      directory,
      "build",
      "ZenX.app",
      "Contents",
      "Resources",
      "app",
    );
    const destination = await copyChromeExtensionResource({
      buildPath,
      sourceDirectory,
    });
    assert.deepEqual((await readdir(destination)).sort(), [
      "manifest.json",
      "service-worker.js",
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("copies the honestly empty external Marketplace metadata into App Resources", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-marketplace-resource-"),
  );
  try {
    const source = path.join(directory, "source", "catalog.json");
    await mkdir(path.dirname(source), { recursive: true });
    await writeFile(source, '{"entries":[]}\n');
    const buildPath = path.join(
      directory,
      "build",
      "ZenX.app",
      "Contents",
      "Resources",
      "app",
    );
    const destination = await copyMarketplaceCatalogResource({
      buildPath,
      sourceFile: source,
    });
    assert.deepEqual(JSON.parse(await readFile(destination, "utf8")), {
      entries: [],
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("concurrent app and smoke builds use complete private snapshots", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-build-snapshot-test-"),
  );
  let releaseApp;
  let appStarted;
  const started = new Promise((resolve) => {
    appStarted = resolve;
  });
  const held = new Promise((resolve) => {
    releaseApp = resolve;
  });
  try {
    const appStaging = path.join(directory, "app-run");
    const smokeStaging = path.join(directory, "smoke-run");
    const rootDirectory = path.join(directory, "root");
    await Promise.all([
      mkdir(appStaging, { recursive: true }),
      mkdir(smokeStaging, { recursive: true }),
      mkdir(path.join(rootDirectory, "node_modules", "ws"), {
        recursive: true,
      }),
      mkdir(
        path.join(rootDirectory, "node_modules", "@zenx", "plugin-sdk", "dist"),
        { recursive: true },
      ),
    ]);
    await writeFile(
      path.join(rootDirectory, "node_modules", "ws", "index.js"),
      "ws",
    );
    await Promise.all([
      writeFile(
        path.join(
          rootDirectory,
          "node_modules",
          "@zenx",
          "plugin-sdk",
          "package.json",
        ),
        `${JSON.stringify({ name: "@zenx/plugin-sdk", version: "0.1.0" })}\n`,
      ),
      writeFile(
        path.join(
          rootDirectory,
          "node_modules",
          "@zenx",
          "plugin-sdk",
          "dist",
          "index.js",
        ),
        "sdk",
      ),
    ]);
    const appBuild = createBuildSnapshot(appStaging, async (output) => {
      await writeBuildFixture(output, "app-partial");
      appStarted();
      await held;
      await writeFile(path.join(output, "main", "result"), "app-complete");
    });
    await started;
    const smokeBuild = await createBuildSnapshot(
      smokeStaging,
      async (output) => {
        await writeBuildFixture(output, "smoke-complete");
      },
    );
    const smokePackage = path.join(smokeStaging, "package");
    await stagePackage({
      target: "smoke",
      outDirectory: smokeBuild,
      rootDirectory,
      appDirectory: smokePackage,
      manifestSha256: "smoke-manifest",
    });
    assert.equal(
      await readFile(path.join(smokePackage, "main", "result"), "utf8"),
      "smoke-complete",
    );
    assert.equal(
      await readFile(path.join(appStaging, "build", "main", "result"), "utf8"),
      "app-partial",
    );
    releaseApp();
    const appSnapshot = await appBuild;
    const appPackage = path.join(appStaging, "package");
    await stagePackage({
      target: "app",
      outDirectory: appSnapshot,
      rootDirectory,
      appDirectory: appPackage,
      manifestSha256: "app-manifest",
    });
    assert.notEqual(appSnapshot, smokeBuild);
    assert.equal(
      await readFile(path.join(appPackage, "out", "main", "result"), "utf8"),
      "app-complete",
    );
    assert.equal(
      await readFile(path.join(smokePackage, "main", "result"), "utf8"),
      "smoke-complete",
    );
  } finally {
    releaseApp?.();
    await rm(directory, { recursive: true, force: true });
  }
});

async function writeBuildFixture(output, result) {
  await Promise.all([
    mkdir(path.join(output, "main"), { recursive: true }),
    mkdir(path.join(output, "preload"), { recursive: true }),
    mkdir(path.join(output, "renderer"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(path.join(output, "main", "integrity.js"), placeholder),
    writeFile(path.join(output, "main", "result"), result),
    writeFile(path.join(output, "preload", "index.cjs"), "preload"),
    writeFile(path.join(output, "renderer", "index.html"), "renderer"),
  ]);
}

test("stages the real app without modifying reusable build output", async () => {
  const fixture = await createFixture();
  try {
    const appDirectory = path.join(fixture.directory, "app");
    await stagePackage({
      target: "app",
      outDirectory: fixture.outDirectory,
      rootDirectory: fixture.rootDirectory,
      appDirectory,
      manifestSha256: "fixture-digest",
    });

    assert.equal(await readFile(fixture.integrityFile, "utf8"), placeholder);
    assert.equal(
      await readFile(
        path.join(appDirectory, "out", "main", "integrity.js"),
        "utf8",
      ),
      "fixture-digest",
    );
    await access(path.join(appDirectory, "out", "main", "app-server-host.js"));
    await access(
      path.join(appDirectory, "out", "main", "code-runtime-worker.js"),
    );
    await access(path.join(appDirectory, "out", "preload", "index.cjs"));
    await access(path.join(appDirectory, "out", "renderer", "index.html"));
    await access(path.join(appDirectory, "node_modules", "ws", "index.js"));
    await access(
      path.join(
        appDirectory,
        "node_modules",
        "@zenx",
        "plugin-sdk",
        "dist",
        "index.js",
      ),
    );
    assert.deepEqual(
      packageManifest("app", {
        version: "0.1.0",
        dependencies: {
          "@zenx/plugin-sdk": "0.1.0",
          ws: "^8.18.3",
        },
      }),
      {
        name: "zenx",
        version: "0.1.0",
        private: true,
        type: "module",
        main: "out/main/index.js",
        dependencies: {
          "@zenx/plugin-sdk": "0.1.0",
          ws: "^8.18.3",
        },
      },
    );
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("stages only the provider smoke through the same digest path", async () => {
  const fixture = await createFixture();
  try {
    const appDirectory = path.join(fixture.directory, "smoke");
    await stagePackage({
      target: "smoke",
      outDirectory: fixture.outDirectory,
      rootDirectory: fixture.rootDirectory,
      appDirectory,
      manifestSha256: "smoke-digest",
    });

    assert.equal(await readFile(fixture.integrityFile, "utf8"), placeholder);
    assert.equal(
      await readFile(path.join(appDirectory, "main", "integrity.js"), "utf8"),
      "smoke-digest",
    );
    await access(path.join(appDirectory, "main", "code-runtime-worker.js"));
    await assert.rejects(access(path.join(appDirectory, "out")), {
      code: "ENOENT",
    });
    await assert.rejects(access(path.join(appDirectory, "node_modules")), {
      code: "ENOENT",
    });
    assert.equal(
      packageManifest("smoke", {
        version: "0.1.0",
        dependencies: { ws: "^8.18.3" },
      }).main,
      "main/packaged-provider-smoke.js",
    );
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("publishes a complete run artifact without exposing its staging path", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zenx-publish-test-"));
  try {
    const staged = path.join(directory, "run", "ZenX-fixture");
    const published = path.join(directory, "artifact", "ZenX-fixture");
    await mkdir(staged, { recursive: true });
    await mkdir(published, { recursive: true });
    await writeFile(path.join(staged, "version"), "new");
    await writeFile(path.join(published, "version"), "old");

    assert.equal(await publishPackagedArtifact(staged, published), published);
    assert.equal(
      await readFile(path.join(published, "version"), "utf8"),
      "new",
    );
    await assert.rejects(access(staged), { code: "ENOENT" });
    assert.deepEqual(await readdir(path.dirname(published)), ["ZenX-fixture"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("fails concurrent packaging of the same target explicitly", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zenx-lock-test-"));
  let enter;
  let release;
  const entered = new Promise((resolve) => {
    enter = resolve;
  });
  const held = new Promise((resolve) => {
    release = resolve;
  });
  try {
    const first = withPackagingTargetLock(
      directory,
      "ZenX-fixture",
      async () => {
        enter();
        await held;
      },
    );
    await entered;
    await assert.rejects(
      withPackagingTargetLock(directory, "ZenX-fixture", async () => {}),
      /ZenX-fixture is already in progress/u,
    );
    release();
    await first;
    assert.deepEqual(await readdir(path.join(directory, "locks")), []);
  } finally {
    release?.();
    await rm(directory, { recursive: true, force: true });
  }
});

async function createFixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zenx-package-test-"));
  const rootDirectory = path.join(directory, "root");
  const outDirectory = path.join(directory, "out");
  const integrityFile = path.join(outDirectory, "main", "integrity.js");
  await mkdir(path.dirname(integrityFile), { recursive: true });
  await mkdir(path.join(outDirectory, "preload"), { recursive: true });
  await mkdir(path.join(outDirectory, "renderer"), { recursive: true });
  await mkdir(path.join(rootDirectory, "node_modules", "ws"), {
    recursive: true,
  });
  await mkdir(
    path.join(rootDirectory, "node_modules", "@zenx", "plugin-sdk", "dist"),
    { recursive: true },
  );
  await Promise.all([
    writeFile(integrityFile, placeholder),
    writeFile(path.join(outDirectory, "main", "app-server-host.js"), "host"),
    writeFile(
      path.join(outDirectory, "main", "code-runtime-worker.js"),
      "worker",
    ),
    writeFile(path.join(outDirectory, "preload", "index.cjs"), "preload"),
    writeFile(path.join(outDirectory, "renderer", "index.html"), "renderer"),
    writeFile(path.join(rootDirectory, "node_modules", "ws", "index.js"), "ws"),
    writeFile(
      path.join(
        rootDirectory,
        "node_modules",
        "@zenx",
        "plugin-sdk",
        "package.json",
      ),
      `${JSON.stringify({ name: "@zenx/plugin-sdk", version: "0.1.0" })}\n`,
    ),
    writeFile(
      path.join(
        rootDirectory,
        "node_modules",
        "@zenx",
        "plugin-sdk",
        "dist",
        "index.js",
      ),
      "sdk",
    ),
  ]);
  return { directory, rootDirectory, outDirectory, integrityFile };
}
