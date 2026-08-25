import assert from "node:assert/strict";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  readlink,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  applicationIconForPlatform,
  copyBundledPnpmResource,
  copyFirstPartyPluginResources,
  copyMarketplaceCatalogResource,
  copyPackagedProviderResources,
  createBuildSnapshot,
  packageManifest,
  publishPackagedArtifact,
  stagePackage,
  withPackagingTargetLock,
} from "../scripts/package-zenx-portable.mjs";
import {
  BUNDLED_PNPM_VERSION,
  resolveBundledPnpmCli,
} from "../src/main/plugin-profile.js";

const placeholder = "__ZENX_PACKAGED_PROVIDER_MANIFEST_SHA256__";

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
