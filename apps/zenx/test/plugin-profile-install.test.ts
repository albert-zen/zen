import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer, request as httpRequest } from "node:http";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import type { CanonicalItem } from "../../../src/item.js";
import { requestPluginDevLink } from "@zenx/plugin-sdk";
import { npmInvocation } from "../../../packages/zenx-plugin-sdk/dist/npm-invocation.mjs";
import { AppServerManager } from "../src/main/app-server-manager.js";
import { ZenXCapabilityService } from "../src/main/capability-service.js";
import { MutableAppServerRequestPort } from "../src/main/capabilities/self-control-package.js";
import { ZenXProjectProjection } from "../src/main/project-projection.js";
import { JsonZenXPluginCatalogStore } from "../src/main/capabilities/plugin-catalog-store.js";
import type { ZenXPluginManifestV2 } from "../src/main/capabilities/types.js";
import {
  BUNDLED_PNPM_VERSION,
  loadProfilePluginPackage,
} from "../src/main/plugin-profile.js";
import { createZenXPluginHostSdk } from "../src/main/plugin-host-sdk.js";
import {
  MarketplaceCatalogService,
  marketplacePackageSource,
} from "../src/main/marketplace-catalog.js";
import { ZenXPluginDevControlServer } from "../src/main/plugin-dev-control.js";

const run = promisify(execFile);
const pnpmCli = fileURLToPath(
  new URL("../../../node_modules/pnpm/bin/pnpm.cjs", import.meta.url),
);
const pluginSdkCli = fileURLToPath(
  new URL("../../../packages/zenx-plugin-sdk/dist/cli.js", import.meta.url),
);
const pluginSdkRoot = fileURLToPath(
  new URL("../../../packages/zenx-plugin-sdk", import.meta.url),
);

test("plugin profile npm fixtures never invoke a Windows command shim directly", async () => {
  const source = await readFile(fileURLToPath(import.meta.url), "utf8");
  const directWindowsNpmShim = new RegExp(["npm", "\\.cmd"].join(""), "u");
  assert.doesNotMatch(source, directWindowsNpmShim);
  assert.deepEqual(
    npmInvocation(["pack", "C:\\Plugin Fixture\\literal & path"], {
      platform: "win32",
      execPath: "C:\\Program Files\\nodejs\\node.exe",
      npmExecPath:
        "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js",
    }),
    {
      executable: "C:\\Program Files\\nodejs\\node.exe",
      args: [
        "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js",
        "pack",
        "C:\\Plugin Fixture\\literal & path",
      ],
    },
  );
});

test("Settings host installs one tarball through the committed profile and Agent discovery", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-profile-install-"),
  );
  const userData = path.join(directory, "user-data");
  const tarball = await createPluginTarball(directory);
  const capabilities = new ZenXCapabilityService({
    userDataDirectory: userData,
    bundledProvidersOnly: true,
    pnpmCliPath: pnpmCli,
    pnpmEnvironment: {
      ...process.env,
      PATH: path.join(directory, "no-path-pnpm"),
    },
  });
  const manager = new AppServerManager({
    entryPath: fileURLToPath(
      new URL("../src/main/app-server-host.ts", import.meta.url),
    ),
    tokenFile: path.join(userData, "runtime", "app-server.token"),
    hostConfig: {
      cwd: directory,
      dataDirectory: path.join(directory, "zen-data"),
      model: "fake",
      models: ["fake"],
      approvalPolicy: "never",
      provider: { type: "fake" },
    },
    capabilityHost: capabilities,
    execArgv: ["--import", "tsx"],
    startupTimeoutMs: 10_000,
  });

  try {
    await capabilities.initialize();
    const installed = await capabilities.installPluginTarball(tarball);
    assert.deepEqual(
      installed.plugins.map(({ id, lifecycle }) => ({ id, lifecycle })),
      [{ id: "profile-fixture", lifecycle: "enabled" }],
    );
    assert.equal(
      installed.bundles[0]?.entry,
      "<main>Profile fixture UI</main>",
    );

    const catalog = JSON.parse(
      await readFile(path.join(userData, "capability-grants.json"), "utf8"),
    ) as {
      profileGeneration: string;
      packages: Record<string, { profilePackageName?: string }>;
    };
    assert.match(catalog.profileGeneration, /^[0-9a-f-]{36}$/u);
    assert.equal(
      catalog.packages["profile-fixture"]?.profilePackageName,
      "@zenx-test/profile-fixture",
    );
    const generation = path.join(
      userData,
      "plugin-profile",
      "generations",
      catalog.profileGeneration,
    );
    const profilePackage = JSON.parse(
      await readFile(path.join(generation, "package.json"), "utf8"),
    ) as {
      packageManager: string;
      pnpm: { allowBuilds: Record<string, boolean> };
      dependencies: Record<string, string>;
    };
    assert.equal(profilePackage.packageManager, `pnpm@${BUNDLED_PNPM_VERSION}`);
    assert.deepEqual(profilePackage.pnpm.allowBuilds, {});
    assert.deepEqual(Object.keys(profilePackage.dependencies), [
      "@zenx-test/profile-fixture",
    ]);
    assert.match(
      await readFile(path.join(generation, "pnpm-lock.yaml"), "utf8"),
      /transitive-plugin/u,
    );
    await readFile(
      path.join(
        generation,
        "node_modules",
        "@zenx-test",
        "profile-fixture",
        "package.json",
      ),
      "utf8",
    );
    assert.deepEqual(Object.keys(catalog.packages), ["profile-fixture"]);

    await manager.start();
    const thread = (await manager.request("thread/start", {})).thread;
    await runTurn(
      manager,
      thread.id,
      '!tool zenx_plugin {"operation":"discover"}',
    );
    await runTurn(
      manager,
      thread.id,
      '!tool zenx_plugin {"operation":"read","pluginId":"profile-fixture"}',
    );
    await runTurn(
      manager,
      thread.id,
      '!tool profile_fixture_echo {"value":"exact profile bytes"}',
    );
    const items = await journalItems(
      path.join(directory, "zen-data", "threads", `${thread.id}.jsonl`),
    );
    const results = items.filter((item) => item.type === "tool_result");
    assert.deepEqual(JSON.parse(results.at(-3)!.output), {
      operation: "discover",
      plugins: [
        {
          id: "profile-fixture",
          name: "Profile fixture",
          description: "Installed from a controlled tarball",
          status: "enabled",
        },
      ],
    });
    assert.equal(
      JSON.parse(results.at(-2)!.output).plugin.mainDocument,
      "Use profile_fixture_echo to echo exact bytes.",
    );
    assert.equal(results.at(-1)!.output, "profile:exact profile bytes");
  } finally {
    await manager.stop();
    await capabilities.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a second profile install rebuilds links inside the new generation", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-profile-generation-links-"),
  );
  const userData = path.join(directory, "user-data");
  const resourcesDirectory = path.join(directory, "resources");
  const pluginResources = path.join(resourcesDirectory, "plugins");
  await mkdir(pluginResources, { recursive: true });
  const firstTarball = await createTarballFixture(pluginResources, {
    id: "generation-first",
    packageName: "@zenx-test/generation-first",
    runtimeType: "bundled",
    runtimeModule: 'export const identity = "first";\n',
  });
  const secondTarball = await createTarballFixture(pluginResources, {
    id: "generation-second",
    packageName: "@zenx-test/generation-second",
    runtimeType: "bundled",
    runtimeModule: 'export const identity = "second";\n',
  });
  const service = profileService(userData, {
    pnpmCliPath: pnpmCli,
    resourcesDirectory,
    trustedProfileLoaders: {
      "generation-first": () => ({
        invoke: async () => ({ output: "first", exitCode: 0 }),
      }),
      "generation-second": () => ({
        invoke: async () => ({ output: "second", exitCode: 0 }),
      }),
    },
  });
  try {
    await service.initialize();
    await service.installBundledPluginPackage(firstTarball, {
      pluginId: "generation-first",
      packageName: "@zenx-test/generation-first",
    });
    const firstCatalog = await readCatalog(userData);
    await service.installBundledPluginPackage(secondTarball, {
      pluginId: "generation-second",
      packageName: "@zenx-test/generation-second",
    });
    const secondCatalog = await readCatalog(userData);
    assert.notEqual(
      secondCatalog.profileGeneration,
      firstCatalog.profileGeneration,
    );
    assert.deepEqual(
      service
        .pluginSnapshot()
        .plugins.map(({ id }) => id)
        .sort(),
      ["generation-first", "generation-second"],
    );
    const secondGeneration = path.join(
      userData,
      "plugin-profile",
      "generations",
      secondCatalog.profileGeneration,
    );
    const firstPackage = await realpath(
      path.join(
        secondGeneration,
        "node_modules",
        "@zenx-test",
        "generation-first",
      ),
    );
    assert.ok(
      firstPackage.startsWith(`${secondGeneration}${path.sep}`),
      `${firstPackage} must stay inside ${secondGeneration}`,
    );
  } finally {
    await service.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("public create and pack output installs through Agent discovery and invocation", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-public-sdk-profile-"),
  );
  const userData = path.join(directory, "user-data");
  const tarball = await createPublicSdkPluginTarball(directory);
  const capabilities = profileService(userData, { pnpmCliPath: pnpmCli });
  const manager = new AppServerManager({
    entryPath: fileURLToPath(
      new URL("../src/main/app-server-host.ts", import.meta.url),
    ),
    tokenFile: path.join(userData, "runtime", "app-server.token"),
    hostConfig: {
      cwd: directory,
      dataDirectory: path.join(directory, "zen-data"),
      model: "fake",
      models: ["fake"],
      approvalPolicy: "never",
      provider: { type: "fake" },
    },
    capabilityHost: capabilities,
    execArgv: ["--import", "tsx"],
    startupTimeoutMs: 10_000,
  });
  try {
    await capabilities.initialize();
    await capabilities.installPluginTarball(tarball);
    await manager.start();
    const thread = (await manager.request("thread/start", {})).thread;
    await runTurn(
      manager,
      thread.id,
      '!tool zenx_plugin {"operation":"discover"}',
    );
    await runTurn(
      manager,
      thread.id,
      '!tool zenx_plugin {"operation":"read","pluginId":"sdk-created"}',
    );
    await runTurn(
      manager,
      thread.id,
      '!tool sdk_created_run {"probe":"public create and pack"}',
    );
    const items = await journalItems(
      path.join(directory, "zen-data", "threads", `${thread.id}.jsonl`),
    );
    const results = items.filter((item) => item.type === "tool_result");
    assert.equal(
      JSON.parse(results.at(-3)!.output).plugins[0].id,
      "sdk-created",
    );
    assert.match(
      JSON.parse(results.at(-2)!.output).plugin.mainDocument,
      /sdk_created_run/u,
    );
    assert.equal(
      results.at(-1)!.output,
      JSON.stringify({ probe: "public create and pack" }),
    );
  } finally {
    await manager.stop();
    await capabilities.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("external public fixture completes create, dev target reload, validate, pack, and ordinary profile run", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-public-dev-flow-"),
  );
  const project = path.join(directory, "external-plugin");
  const devUserData = path.join(directory, "dev-user-data");
  const installUserData = path.join(directory, "install-user-data");
  const sdkTarballs = path.join(directory, "sdk-tarballs");
  await mkdir(sdkTarballs);
  let devControl: ZenXPluginDevControlServer | undefined;
  const devCapabilities = profileService(devUserData, { pnpmCliPath: pnpmCli });
  const devManager = profileManager(directory, "dev", devCapabilities);
  const installedCapabilities = profileService(installUserData, {
    pnpmCliPath: pnpmCli,
  });
  const installedManager = profileManager(
    directory,
    "installed",
    installedCapabilities,
  );
  try {
    await run(process.execPath, [
      pluginSdkCli,
      "create",
      project,
      "--name",
      "@external/dev-flow",
      "--id",
      "dev-flow",
    ]);
    const packedSdk = await runNpm(
      ["pack", pluginSdkRoot, "--json", "--pack-destination", sdkTarballs],
      { cwd: directory },
    );
    const sdkFilename = (
      JSON.parse(packedSdk.stdout) as [{ filename: string }]
    )[0].filename;
    const projectPackageFile = path.join(project, "package.json");
    const projectPackage = JSON.parse(
      await readFile(projectPackageFile, "utf8"),
    ) as { dependencies: Record<string, string> };
    projectPackage.dependencies["@zenx/plugin-sdk"] = `file:${path.join(
      sdkTarballs,
      sdkFilename,
    )}`;
    await writeFile(
      projectPackageFile,
      `${JSON.stringify(projectPackage, null, 2)}\n`,
    );
    await runNpm(
      [
        "install",
        "--ignore-scripts",
        "--no-save",
        path.join(sdkTarballs, sdkFilename),
      ],
      { cwd: project },
    );

    await devCapabilities.initialize();
    await devManager.start();
    const descriptorFile = path.join(devUserData, "runtime", "plugin-dev.json");
    devControl = await ZenXPluginDevControlServer.start({
      descriptorFile,
      tokenFile: path.join(devUserData, "runtime", "plugin-dev.token"),
      install: async (request, signal, enterCommitPhase) =>
        await devCapabilities.devPluginPackage(
          request.projectDirectory,
          {
            pluginId: request.pluginId,
            packageName: request.packageName,
          },
          { signal, enterCommitPhase },
        ),
      reload: async (pluginId) =>
        await devManager.refreshPluginAfterCommit(pluginId),
    });
    const developed = await run(process.execPath, [
      pluginSdkCli,
      "dev",
      project,
      "--target",
      descriptorFile,
    ]);
    assert.deepEqual(JSON.parse(developed.stdout).reload, {
      status: "reloaded",
    });
    await assertAgentPluginFlow(devManager, directory, "dev", "dev flow");

    const validated = await run(process.execPath, [
      pluginSdkCli,
      "validate",
      project,
    ]);
    assert.equal(JSON.parse(validated.stdout).pluginId, "dev-flow");
    const packed = await run(process.execPath, [pluginSdkCli, "pack", project]);
    const tarball = path.join(
      project,
      (JSON.parse(packed.stdout) as [{ filename: string }])[0].filename,
    );

    await installedCapabilities.initialize();
    await installedCapabilities.installPluginTarball(tarball);
    await installedManager.start();
    await assertAgentPluginFlow(
      installedManager,
      directory,
      "installed",
      "ordinary install",
    );
  } finally {
    await devControl?.close();
    await devManager.stop();
    await installedManager.stop();
    await devCapabilities.close();
    await installedCapabilities.close();
    await rm(directory, { recursive: true, force: true });
  }
});

function profileManager(
  directory: string,
  name: string,
  capabilities: ZenXCapabilityService,
): AppServerManager {
  return new AppServerManager({
    entryPath: fileURLToPath(
      new URL("../src/main/app-server-host.ts", import.meta.url),
    ),
    tokenFile: path.join(directory, `${name}-app-server.token`),
    hostConfig: {
      cwd: directory,
      dataDirectory: path.join(directory, `${name}-zen-data`),
      model: "fake",
      models: ["fake"],
      approvalPolicy: "never",
      provider: { type: "fake" },
    },
    capabilityHost: capabilities,
    execArgv: ["--import", "tsx"],
    startupTimeoutMs: 10_000,
  });
}

async function assertAgentPluginFlow(
  manager: AppServerManager,
  directory: string,
  name: string,
  probe: string,
): Promise<void> {
  const thread = (await manager.request("thread/start", {})).thread;
  await runTurn(
    manager,
    thread.id,
    '!tool zenx_plugin {"operation":"discover"}',
  );
  await runTurn(
    manager,
    thread.id,
    '!tool zenx_plugin {"operation":"read","pluginId":"dev-flow"}',
  );
  await runTurn(
    manager,
    thread.id,
    `!tool dev_flow_run ${JSON.stringify({ probe })}`,
  );
  const items = await journalItems(
    path.join(directory, `${name}-zen-data`, "threads", `${thread.id}.jsonl`),
  );
  const results = items.filter((item) => item.type === "tool_result");
  assert.equal(JSON.parse(results.at(-3)!.output).plugins[0].id, "dev-flow");
  assert.match(
    JSON.parse(results.at(-2)!.output).plugin.mainDocument,
    /dev_flow_run/u,
  );
  assert.equal(results.at(-1)!.output, JSON.stringify({ probe }));
}

test("restart loads only the Catalog-selected generation without the source tarball or pnpm", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-profile-restart-"),
  );
  const userData = path.join(directory, "user-data");
  const tarball = await createPluginTarball(directory);
  const first = profileService(userData, { pnpmCliPath: pnpmCli });
  try {
    await first.initialize();
    await first.installPluginTarball(tarball);
    const catalog = await readCatalog(userData);
    const stale = path.join(
      userData,
      "plugin-profile",
      "generations",
      "11111111-1111-1111-1111-111111111111",
    );
    await mkdir(stale, { recursive: true });
    await writeFile(path.join(stale, "uncommitted"), "must not load");
    await first.close();
    await rm(path.dirname(tarball), { recursive: true, force: true });
    await rm(path.join(directory, "fixture-package-profile-fixture"), {
      recursive: true,
      force: true,
    });

    const restarted = profileService(userData, {
      pnpmCliPath: path.join(directory, "missing-pnpm.cjs"),
    });
    try {
      await restarted.initialize();
      assert.equal(restarted.pluginSnapshot().plugins[0]?.lifecycle, "enabled");
      assert.equal(
        (
          await restarted.execute({
            callId: "restart-call",
            name: "profile_fixture_echo",
            arguments: { value: "after restart" },
            cwd: directory,
            signal: new AbortController().signal,
          })
        ).output,
        "profile:after restart",
      );
      assert.deepEqual(
        await readdir(path.join(userData, "plugin-profile", "generations")),
        [catalog.profileGeneration],
      );
    } finally {
      await restarted.close();
    }
  } finally {
    await first.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("startup with no Catalog generation discards abandoned staging without publishing it", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-profile-abandoned-"),
  );
  const userData = path.join(directory, "user-data");
  const abandoned = path.join(
    userData,
    "plugin-profile",
    "generations",
    "11111111-1111-1111-1111-111111111111",
  );
  await mkdir(abandoned, { recursive: true });
  await writeFile(path.join(abandoned, "package.json"), "not authoritative");
  const service = profileService(userData, {
    pnpmCliPath: path.join(directory, "missing-pnpm.cjs"),
  });
  try {
    await service.initialize();
    assert.deepEqual(service.pluginSnapshot().plugins, []);
    assert.deepEqual(await readdir(path.dirname(abandoned)), []);
  } finally {
    await service.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("pnpm, manifest, runtime, UI, and Catalog failures preserve the committed generation and runtime", async () => {
  const cases: Array<{
    name: string;
    candidate: TarballFixtureOptions;
    expected: RegExp;
    fakePnpm?: boolean;
    failCatalog?: boolean;
  }> = [
    {
      name: "pnpm",
      candidate: {} as TarballFixtureOptions,
      expected: /Bundled pnpm failed/u,
      fakePnpm: true,
    },
    {
      name: "manifest",
      candidate: { description: "" },
      expected: /description must be a non-empty string/u,
    },
    {
      name: "runtime",
      candidate: { runtimeIdentity: "wrong-runtime-id" },
      expected: /ready identity mismatch/u,
    },
    {
      name: "UI",
      candidate: { omitUiEntry: true },
      expected: /UI bundle entry must be a non-empty string/u,
    },
    {
      name: "Catalog",
      candidate: {} as TarballFixtureOptions,
      expected: /catalog fixture failure/u,
      failCatalog: true,
    },
  ];

  for (const failure of cases) {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), `zenx-profile-${failure.name}-`),
    );
    const userData = path.join(directory, "user-data");
    const store = new JsonZenXPluginCatalogStore(
      path.join(userData, "capability-grants.json"),
    );
    let failCatalog = false;
    const catalogStore = {
      load: async () => await store.load(),
      save: async (configuration: Parameters<typeof store.save>[0]) => {
        if (failCatalog) throw new Error("catalog fixture failure");
        await store.save(configuration);
      },
    };
    const baselineTarball = await createPluginTarball(directory);
    const baseline = profileService(userData, {
      pnpmCliPath: pnpmCli,
      catalogStore,
    });
    try {
      await baseline.initialize();
      await baseline.installPluginTarball(baselineTarball);
      const beforeCatalog = await readFile(
        path.join(userData, "capability-grants.json"),
        "utf8",
      );
      const before = await readCatalog(userData);
      const candidate = await createTarballFixture(directory, {
        id: `${failure.name.toLowerCase()}-candidate`,
        packageName: `@zenx-test/${failure.name.toLowerCase()}-candidate`,
        ...failure.candidate,
      });
      let active = baseline;
      if (failure.fakePnpm) {
        await baseline.close();
        active = profileService(userData, {
          pnpmCliPath: await createFailingPnpm(directory),
          catalogStore,
        });
        await active.initialize();
      }
      failCatalog = failure.failCatalog ?? false;
      await assert.rejects(
        active.installPluginTarball(candidate),
        failure.expected,
        failure.name,
      );
      failCatalog = false;
      assert.equal(
        await readFile(path.join(userData, "capability-grants.json"), "utf8"),
        beforeCatalog,
        failure.name,
      );
      assert.equal(
        (await readCatalog(userData)).profileGeneration,
        before.profileGeneration,
      );
      assert.deepEqual(
        active.pluginSnapshot().plugins.map((plugin) => plugin.id),
        ["profile-fixture"],
        failure.name,
      );
      assert.equal(
        (
          await active.execute({
            callId: `after-${failure.name}`,
            name: "profile_fixture_echo",
            arguments: { value: failure.name },
            cwd: directory,
            signal: new AbortController().signal,
          })
        ).output,
        `profile:${failure.name}`,
      );
      if (active !== baseline) await active.close();
    } finally {
      failCatalog = false;
      await baseline.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test("profile process runtime admission uses its manifest start timeout", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-profile-runtime-timeout-"),
  );
  const tarball = await createTarballFixture(directory, {
    id: "runtime-timeout",
    packageName: "@zenx-test/runtime-timeout",
    runtimeTimeoutMs: 25,
    runtimeModule: "setInterval(() => {}, 1000);\n",
  });
  const service = profileService(path.join(directory, "user-data"), {
    pnpmCliPath: pnpmCli,
  });
  try {
    await service.initialize();
    await assert.rejects(
      service.installPluginTarball(tarball),
      /runtime runtime-timeout did not become ready/u,
    );
    assert.deepEqual(service.pluginSnapshot().plugins, []);
  } finally {
    await service.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("the common profile loader admits an HTTP runtime before filesystem entry resolution", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zenx-profile-http-"));
  const generation = path.join(directory, "generation");
  const packageRoot = path.join(
    generation,
    "node_modules",
    "@zenx-test",
    "http-profile",
  );
  let requests = 0;
  const server = createServer(async (request, response) => {
    requests += 1;
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
      id: string;
      arguments: { value: string };
    };
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        version: 1,
        id: body.id,
        result: { output: `http:${body.arguments.value}`, exitCode: 0 },
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  await mkdir(packageRoot, { recursive: true });
  const manifest = {
    ...fixtureManifest("http-profile"),
    runtime: {
      type: "http" as const,
      url: `http://127.0.0.1:${String(address.port)}/invoke`,
      timeoutMs: 1_000,
    },
  };
  await Promise.all([
    writeFile(
      path.join(packageRoot, "package.json"),
      `${JSON.stringify({
        name: "@zenx-test/http-profile",
        version: "1.0.0",
        zenx: { plugin: "zenx.plugin.json" },
      })}\n`,
    ),
    writeFile(
      path.join(packageRoot, "zenx.plugin.json"),
      `${JSON.stringify(manifest)}\n`,
    ),
  ]);
  const capabilityPackage = await loadProfilePluginPackage(
    generation,
    "@zenx-test/http-profile",
  );
  const sdk = await createZenXPluginHostSdk({
    pluginId: "http-profile",
    storageRoot: path.join(directory, "storage"),
    storageVersion: 1,
    queryProjects: async () => [],
    appServer: {
      completeTurn: async () => {
        throw new Error("unused");
      },
    },
  });
  try {
    await capabilityPackage.start?.(sdk);
    assert.deepEqual(
      await capabilityPackage.invoke(
        "http_profile_echo",
        {
          callId: "http-profile-call",
          name: "http_profile_echo",
          arguments: { value: "loaded" },
          cwd: directory,
          signal: new AbortController().signal,
        },
        sdk,
      ),
      { output: "http:loaded", exitCode: 0 },
    );
    assert.equal(requests, 1);
  } finally {
    await capabilityPackage.close?.();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("profile update Catalog failure keeps the old generation and serving runtime", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-profile-update-fail-"),
  );
  const userData = path.join(directory, "user-data");
  const store = new JsonZenXPluginCatalogStore(
    path.join(userData, "capability-grants.json"),
  );
  let failSave = false;
  const service = profileService(userData, {
    pnpmCliPath: pnpmCli,
    catalogStore: {
      load: async () => await store.load(),
      save: async (configuration) => {
        if (failSave) throw new Error("update Catalog fixture failure");
        await store.save(configuration);
      },
    },
  });
  const v1 = await createTarballFixture(directory, {
    id: "update-failure",
    packageName: "@zenx-test/update-failure",
    outputPrefix: "old:",
  });
  const v2 = await createTarballFixture(directory, {
    id: "update-failure",
    packageName: "@zenx-test/update-failure",
    version: "2.0.0",
    outputPrefix: "new:",
  });
  try {
    await service.initialize();
    await service.installPluginTarball(v1);
    const before = await readCatalog(userData);
    failSave = true;
    await assert.rejects(
      service.updatePluginPackage("update-failure", {
        mode: "tarball",
        packageSpec: v2,
      }),
      /update Catalog fixture failure/u,
    );
    failSave = false;
    assert.equal(
      (await readCatalog(userData)).profileGeneration,
      before.profileGeneration,
    );
    assert.equal(service.pluginSnapshot().plugins[0]?.version, "1.0.0");
    assert.equal(
      await invoke(service, "update_failure_echo", "still-serving"),
      "old:still-serving",
    );
  } finally {
    failSave = false;
    await service.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("failed staging cleanup can leave only disk garbage and concurrent installs serialize", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-profile-serial-"),
  );
  const userData = path.join(directory, "user-data");
  const tarball = await createPluginTarball(directory);
  const service = profileService(userData, {
    pnpmCliPath: pnpmCli,
    removeProfileGeneration: async () => {
      throw new Error("cleanup fixture failure");
    },
  });
  try {
    await service.initialize();
    const outcomes = await Promise.allSettled([
      service.installPluginTarball(tarball),
      service.installPluginTarball(tarball),
    ]);
    assert.deepEqual(
      outcomes.map((outcome) => outcome.status),
      ["fulfilled", "rejected"],
    );
    assert.deepEqual(
      service.pluginSnapshot().plugins.map((plugin) => plugin.id),
      ["profile-fixture"],
    );
    const catalog = await readCatalog(userData);
    const generations = await readdir(
      path.join(userData, "plugin-profile", "generations"),
    );
    assert.equal(generations.includes(catalog.profileGeneration), true);
    assert.equal(generations.length > 1, true);
    assert.equal(
      (
        await service.execute({
          callId: "after-cleanup-failure",
          name: "profile_fixture_echo",
          arguments: { value: "published" },
          cwd: directory,
          signal: new AbortController().signal,
        })
      ).output,
      "profile:published",
    );
  } finally {
    await service.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("stable local copies are immutable while explicit development links reload source changes", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-profile-local-"),
  );
  const userData = path.join(directory, "user-data");
  await createTarballFixture(directory, {
    id: "stable-local",
    packageName: "@zenx-test/stable-local",
    outputPrefix: "stable-one:",
  });
  await createTarballFixture(directory, {
    id: "dev-live",
    packageName: "@zenx-test/dev-live",
    outputPrefix: "dev-one:",
  });
  const stableDirectory = path.join(
    directory,
    "fixture-package-stable-local-1.0.0",
  );
  const devDirectory = path.join(directory, "fixture-package-dev-live-1.0.0");
  const service = profileService(userData, { pnpmCliPath: pnpmCli });
  try {
    await service.initialize();
    await service.installPluginPackage({
      mode: "local-copy",
      packageSpec: stableDirectory,
    });
    await service.installPluginPackage({
      mode: "dev-link",
      packageSpec: devDirectory,
    });
    assert.equal(
      await invoke(service, "stable_local_echo", "before"),
      "stable-one:before",
    );
    assert.equal(
      await invoke(service, "dev_live_echo", "before"),
      "dev-one:before",
    );

    await replaceRuntimePrefix(stableDirectory, "stable-one:", "stable-two:");
    await replaceRuntimePrefix(devDirectory, "dev-one:", "dev-two:");
    await service.setEnabled("stable-local", false);
    await service.setEnabled("dev-live", false);
    await service.setEnabled("stable-local", true);
    await service.setEnabled("dev-live", true);

    assert.equal(
      await invoke(service, "stable_local_echo", "after"),
      "stable-one:after",
    );
    assert.equal(
      await invoke(service, "dev_live_echo", "after"),
      "dev-two:after",
    );
    const sources = service
      .pluginSnapshot()
      .plugins.map((plugin) => [plugin.id, plugin.profileSource?.mode]);
    assert.deepEqual(sources, [
      ["stable-local", "local-copy"],
      ["dev-live", "dev-link"],
    ]);
  } finally {
    await service.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("explicit dev-link mutation reloads the same plugin version without touching another active plugin", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-profile-dev-reload-"),
  );
  const userData = path.join(directory, "user-data");
  await createTarballFixture(directory, {
    id: "dev-target",
    packageName: "@zenx-test/dev-target",
    outputPrefix: "target-one:",
  });
  await createTarballFixture(directory, {
    id: "dev-neighbor",
    packageName: "@zenx-test/dev-neighbor",
    outputPrefix: "neighbor:",
  });
  const targetDirectory = path.join(
    directory,
    "fixture-package-dev-target-1.0.0",
  );
  const neighborDirectory = path.join(
    directory,
    "fixture-package-dev-neighbor-1.0.0",
  );
  const service = profileService(userData, { pnpmCliPath: pnpmCli });
  try {
    await service.initialize();
    await service.installPluginPackage({
      mode: "dev-link",
      packageSpec: targetDirectory,
    });
    await service.installPluginPackage({
      mode: "dev-link",
      packageSpec: neighborDirectory,
    });
    const neighborGeneration = service
      .pluginSnapshot()
      .plugins.find((plugin) => plugin.id === "dev-neighbor")
      ?.profileSource?.resolvedSpec;

    await replaceRuntimePrefix(targetDirectory, "target-one:", "target-two:");
    await service.installPluginPackage(
      { mode: "dev-link", packageSpec: targetDirectory },
      "dev-target",
    );

    assert.equal(
      await invoke(service, "dev_target_echo", "after"),
      "target-two:after",
    );
    assert.equal(
      await invoke(service, "dev_neighbor_echo", "still"),
      "neighbor:still",
    );
    assert.equal(
      service
        .pluginSnapshot()
        .plugins.find((plugin) => plugin.id === "dev-neighbor")?.profileSource
        ?.resolvedSpec,
      neighborGeneration,
    );
    const committedGeneration = (await readCatalog(userData)).profileGeneration;
    await replaceRuntimePrefix(
      targetDirectory,
      'pluginId:"dev-target"',
      'pluginId:"wrong-target"',
    );
    await assert.rejects(
      service.installPluginPackage(
        { mode: "dev-link", packageSpec: targetDirectory },
        "dev-target",
      ),
      /ready identity mismatch/u,
    );
    assert.equal(
      await invoke(service, "dev_target_echo", "rollback"),
      "target-two:rollback",
    );
    assert.equal(
      (await readCatalog(userData)).profileGeneration,
      committedGeneration,
    );
  } finally {
    await service.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("dev timeout before the commit fence settles pnpm and discards staging", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-profile-dev-abort-"),
  );
  const userData = path.join(directory, "user-data");
  await createTarballFixture(directory, {
    id: "abort-target",
    packageName: "@zenx-test/abort-target",
  });
  const projectDirectory = path.join(
    directory,
    "fixture-package-abort-target-1.0.0",
  );
  const marker = path.join(directory, "pnpm-started");
  let devControl: ZenXPluginDevControlServer | undefined;
  const service = profileService(userData, {
    pnpmCliPath: await createStallingPnpm(directory),
    pnpmEnvironment: { ...process.env, ZENX_TEST_PNPM_MARKER: marker },
  });
  try {
    await service.initialize();
    const descriptorFile = path.join(userData, "runtime", "plugin-dev.json");
    devControl = await ZenXPluginDevControlServer.start({
      descriptorFile,
      tokenFile: path.join(userData, "runtime", "plugin-dev.token"),
      transactionTimeoutMs: 250,
      install: async (request, signal, enterCommitPhase) =>
        await service.devPluginPackage(
          request.projectDirectory,
          {
            pluginId: request.pluginId,
            packageName: request.packageName,
          },
          { signal, pnpmAbortGraceMs: 20, enterCommitPhase },
        ),
      reload: async () => ({ status: "reloaded" }),
    });
    const mutation = requestPluginDevLink(
      descriptorFile,
      {
        version: 1,
        projectDirectory,
        pluginId: "abort-target",
        packageName: "@zenx-test/abort-target",
      },
      { timeoutMs: 1_000 },
    );
    await waitForFile(marker);
    await assert.rejects(mutation, /transaction timed out after 250ms/u);
    assert.deepEqual(service.pluginSnapshot().plugins, []);
    assert.deepEqual(
      await readdir(path.join(userData, "plugin-profile", "generations")),
      [],
    );
  } finally {
    await devControl?.close();
    await service.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("dev abort after runtime admission begins rolls back before Catalog commit", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-profile-dev-precommit-"),
  );
  const userData = path.join(directory, "user-data");
  const marker = path.join(directory, "runtime-started");
  await createTarballFixture(directory, {
    id: "precommit-target",
    packageName: "@zenx-test/precommit-target",
    runtimeTimeoutMs: 500,
    runtimeModule: delayedReadyRuntime("precommit-target", marker, 80),
  });
  const projectDirectory = path.join(
    directory,
    "fixture-package-precommit-target-1.0.0",
  );
  const controller = new AbortController();
  const service = profileService(userData, { pnpmCliPath: pnpmCli });
  try {
    await service.initialize();
    const mutation = service.devPluginPackage(
      projectDirectory,
      {
        pluginId: "precommit-target",
        packageName: "@zenx-test/precommit-target",
      },
      { signal: controller.signal },
    );
    await waitForFile(marker);
    controller.abort(new Error("fixture precommit deadline"));
    await assert.rejects(mutation, /fixture precommit deadline/u);
    assert.deepEqual(service.pluginSnapshot().plugins, []);
    assert.deepEqual(
      await readdir(path.join(userData, "plugin-profile", "generations")),
      [],
    );
  } finally {
    await service.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("dev install timeout and close after its Catalog fence wait for the committed result", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-profile-dev-install-fence-"),
  );
  const userData = path.join(directory, "user-data");
  await createTarballFixture(directory, {
    id: "install-fence",
    packageName: "@zenx-test/install-fence",
  });
  const projectDirectory = path.join(
    directory,
    "fixture-package-install-fence-1.0.0",
  );
  const catalog = blockingCatalog(userData);
  const service = profileService(userData, {
    pnpmCliPath: pnpmCli,
    catalogStore: catalog.store,
  });
  let fences = 0;
  let devControl: ZenXPluginDevControlServer | undefined;
  const transactionTimeoutMs = 3_000;
  try {
    await service.initialize();
    const blocked = catalog.blockNext(() => assert.equal(fences, 1));
    const descriptorFile = path.join(userData, "runtime", "plugin-dev.json");
    devControl = await ZenXPluginDevControlServer.start({
      descriptorFile,
      tokenFile: path.join(userData, "runtime", "plugin-dev.token"),
      transactionTimeoutMs,
      install: async (request, signal, enterCommitPhase) =>
        await service.devPluginPackage(
          request.projectDirectory,
          {
            pluginId: request.pluginId,
            packageName: request.packageName,
          },
          {
            signal,
            enterCommitPhase: () => {
              fences += 1;
              enterCommitPhase();
            },
          },
        ),
      reload: async () => ({ status: "reloaded" }),
    });
    const startedAt = Date.now();
    const requested = requestPluginDevLink(
      descriptorFile,
      {
        version: 1,
        projectDirectory,
        pluginId: "install-fence",
        packageName: "@zenx-test/install-fence",
      },
      { timeoutMs: 5_000 },
    );
    await blocked.started;
    const closing = devControl.close();
    await delay(
      Math.max(0, transactionTimeoutMs - (Date.now() - startedAt) + 25),
    );
    assert.equal(
      await Promise.race([
        closing.then(() => "closed"),
        delay(20).then(() => "waiting"),
      ]),
      "waiting",
    );
    blocked.release();
    const result = await requested;
    await closing;
    assert.equal(result.reload.status, "reloaded");
    assert.equal(fences, 1);
    assert.equal(
      (await readCatalog(userData)).profileGeneration,
      result.generation,
    );
    assert.equal(service.pluginSnapshot().plugins[0]?.id, "install-fence");
  } finally {
    catalog.release();
    await devControl?.close();
    await service.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("dev Catalog save rejection after the fence reports failure without a commit", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-profile-dev-save-fail-"),
  );
  const userData = path.join(directory, "user-data");
  await createTarballFixture(directory, {
    id: "save-fail",
    packageName: "@zenx-test/save-fail",
  });
  const projectDirectory = path.join(
    directory,
    "fixture-package-save-fail-1.0.0",
  );
  const delegate = new JsonZenXPluginCatalogStore(
    path.join(userData, "capability-grants.json"),
  );
  let fences = 0;
  const service = profileService(userData, {
    pnpmCliPath: pnpmCli,
    catalogStore: {
      load: async () => await delegate.load(),
      save: async () => {
        assert.equal(fences, 1);
        throw new Error("fixture fenced Catalog failure");
      },
    },
  });
  let devControl: ZenXPluginDevControlServer | undefined;
  try {
    await service.initialize();
    const descriptorFile = path.join(userData, "runtime", "plugin-dev.json");
    devControl = await ZenXPluginDevControlServer.start({
      descriptorFile,
      tokenFile: path.join(userData, "runtime", "plugin-dev.token"),
      install: async (request, signal, enterCommitPhase) =>
        await service.devPluginPackage(
          request.projectDirectory,
          {
            pluginId: request.pluginId,
            packageName: request.packageName,
          },
          {
            signal,
            enterCommitPhase: () => {
              fences += 1;
              enterCommitPhase();
            },
          },
        ),
      reload: async () => ({ status: "reloaded" }),
    });
    await assert.rejects(
      requestPluginDevLink(
        descriptorFile,
        {
          version: 1,
          projectDirectory,
          pluginId: "save-fail",
          packageName: "@zenx-test/save-fail",
        },
        { timeoutMs: 1_000 },
      ),
      /fixture fenced Catalog failure/u,
    );
    assert.equal(fences, 1);
    assert.deepEqual(service.pluginSnapshot().plugins, []);
    assert.deepEqual(
      await readdir(path.join(userData, "plugin-profile", "generations")),
      [],
    );
    await assert.rejects(readCatalog(userData), /ENOENT/u);
  } finally {
    await devControl?.close();
    await service.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("dev same-version update commits after a post-fence client disconnect", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-profile-dev-update-fence-"),
  );
  const userData = path.join(directory, "user-data");
  await createTarballFixture(directory, {
    id: "update-fence",
    packageName: "@zenx-test/update-fence",
    outputPrefix: "before:",
  });
  const projectDirectory = path.join(
    directory,
    "fixture-package-update-fence-1.0.0",
  );
  const catalog = blockingCatalog(userData);
  const service = profileService(userData, {
    pnpmCliPath: pnpmCli,
    catalogStore: catalog.store,
  });
  let fences = 0;
  let devControl: ZenXPluginDevControlServer | undefined;
  try {
    await service.initialize();
    await service.installPluginPackage({
      mode: "dev-link",
      packageSpec: projectDirectory,
    });
    const previousGeneration = (await readCatalog(userData)).profileGeneration;
    await replaceRuntimePrefix(projectDirectory, "before:", "after:");
    const blocked = catalog.blockNext(() => assert.equal(fences, 1));
    const descriptorFile = path.join(userData, "runtime", "plugin-dev.json");
    const tokenFile = path.join(userData, "runtime", "plugin-dev.token");
    devControl = await ZenXPluginDevControlServer.start({
      descriptorFile,
      tokenFile,
      transactionTimeoutMs: 10_000,
      install: async (request, signal, enterCommitPhase) =>
        await service.devPluginPackage(
          request.projectDirectory,
          {
            pluginId: request.pluginId,
            packageName: request.packageName,
          },
          {
            signal,
            enterCommitPhase: () => {
              fences += 1;
              enterCommitPhase();
            },
          },
        ),
      reload: async () => ({ status: "reloaded" }),
    });
    const clientRequest = await rawProfileDevRequest(
      descriptorFile,
      tokenFile,
      {
        version: 1,
        projectDirectory,
        pluginId: "update-fence",
        packageName: "@zenx-test/update-fence",
      },
    );
    const client = clientRequest.request;
    client.once("error", () => undefined);
    await waitForDevCommitFence(blocked.started, clientRequest.response);
    client.destroy();
    const closing = devControl.close();
    assert.equal(
      await Promise.race([
        closing.then(() => "closed"),
        delay(20).then(() => "waiting"),
      ]),
      "waiting",
    );
    blocked.release();
    await closing;
    assert.equal(fences, 1);
    assert.notEqual(
      (await readCatalog(userData)).profileGeneration,
      previousGeneration,
    );
    assert.equal(
      await invoke(service, "update_fence_echo", "committed"),
      "after:committed",
    );
  } finally {
    catalog.release();
    await devControl?.close();
    await service.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a profile dev failure before the commit fence remains observable", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-profile-dev-prefence-failure-"),
  );
  const descriptorFile = path.join(directory, "plugin-dev.json");
  const tokenFile = path.join(directory, "plugin-dev.token");
  const devControl = await ZenXPluginDevControlServer.start({
    descriptorFile,
    tokenFile,
    install: async () => {
      throw new Error("fixture pre-fence rejection");
    },
    reload: async () => ({ status: "reloaded" }),
  });
  let client:
    Awaited<ReturnType<typeof rawProfileDevRequest>>["request"] | undefined;
  try {
    const clientRequest = await rawProfileDevRequest(
      descriptorFile,
      tokenFile,
      {
        version: 1,
        projectDirectory: directory,
        pluginId: "prefence-failure",
        packageName: "@zenx-test/prefence-failure",
      },
    );
    client = clientRequest.request;
    client.once("error", () => undefined);
    await assert.rejects(
      waitForDevCommitFence(
        new Promise<void>(() => undefined),
        clientRequest.response,
      ),
      /settled before its commit fence \(HTTP 400\):.*fixture pre-fence rejection/u,
    );
  } finally {
    client?.destroy();
    await devControl.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Git profile sources require and persist an exact commit", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zenx-profile-git-"));
  const userData = path.join(directory, "user-data");
  await createTarballFixture(directory, {
    id: "git-fixture",
    packageName: "@zenx-test/git-fixture",
    outputPrefix: "git:",
  });
  const repository = path.join(directory, "fixture-package-git-fixture-1.0.0");
  await run("git", ["init", "-q"], { cwd: repository });
  await run("git", ["config", "user.email", "fixture@zenx.local"], {
    cwd: repository,
  });
  await run("git", ["config", "user.name", "ZenX Fixture"], {
    cwd: repository,
  });
  await run("git", ["add", "."], { cwd: repository });
  await run("git", ["commit", "-qm", "fixture"], { cwd: repository });
  const commit = (
    await run("git", ["rev-parse", "HEAD"], { cwd: repository })
  ).stdout.trim();
  const service = profileService(userData, { pnpmCliPath: pnpmCli });
  try {
    await service.initialize();
    await assert.rejects(
      service.installPluginPackage({
        mode: "git",
        packageSpec: `git+file://${repository}`,
      }),
      /pin an exact commit/u,
    );
    await service.installPluginPackage({
      mode: "git",
      packageSpec: `git+file://${repository}#${commit}`,
    });
    assert.equal(
      await invoke(service, "git_fixture_echo", "commit"),
      "git:commit",
    );
    assert.equal(
      service.pluginSnapshot().plugins[0]?.profileSource?.packageSpec,
      `git+file://${repository}#${commit}`,
    );
  } finally {
    await service.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("ordinary package sources cannot claim a Host-trusted bundled runtime", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-profile-trust-"),
  );
  const tarball = await createTarballFixture(directory, {
    id: "untrusted-bundled",
    packageName: "@zenx-test/untrusted-bundled",
    runtimeType: "bundled",
  });
  const service = profileService(path.join(directory, "user-data"), {
    pnpmCliPath: pnpmCli,
  });
  try {
    await service.initialize();
    await assert.rejects(
      service.installPluginTarball(tarball),
      /bundled runtime is not admitted by App Resources/u,
    );
    assert.deepEqual(service.pluginSnapshot().plugins, []);
  } finally {
    await service.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("only App Resource packages enter the canonical trusted bundled source", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-profile-bundled-"),
  );
  const resourcesDirectory = path.join(directory, "resources");
  const pluginResources = path.join(resourcesDirectory, "plugins");
  await mkdir(pluginResources, { recursive: true });
  const tarball = await createTarballFixture(pluginResources, {
    id: "trusted-bundled",
    packageName: "@zenx-test/trusted-bundled",
    runtimeType: "bundled",
    runtimeModule: 'export const identity = "app-resource";\n',
  });
  const service = profileService(path.join(directory, "user-data"), {
    pnpmCliPath: pnpmCli,
    resourcesDirectory,
    trustedProfileLoaders: {
      "trusted-bundled": (module) => {
        assert.equal(module.identity, "app-resource");
        return {
          invoke: async (_toolName, invocation) => ({
            output: `trusted:${String(invocation.arguments.value)}`,
            exitCode: 0,
          }),
        };
      },
    },
  });
  try {
    await service.initialize();
    await assert.rejects(
      service.installPluginTarball(tarball),
      /bundled runtime is not admitted by App Resources/u,
    );
    await service.installBundledPluginPackage(tarball, {
      pluginId: "trusted-bundled",
      packageName: "@zenx-test/trusted-bundled",
    });
    assert.equal(
      service.pluginSnapshot().plugins[0]?.profileSource?.mode,
      "bundled",
    );
    assert.equal(
      await invoke(service, "trusted_bundled_echo", "resource"),
      "trusted:resource",
    );
  } finally {
    await service.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("desktop composition injects one live Project, AppServer, UI, and storage Host SDK", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-sdk-composition-"),
  );
  const resourcesDirectory = path.join(directory, "resources");
  const pluginResources = path.join(resourcesDirectory, "plugins");
  await mkdir(pluginResources, { recursive: true });
  const tarball = await createTarballFixture(pluginResources, {
    id: "sdk-composition",
    packageName: "@zenx-test/sdk-composition",
    runtimeType: "bundled",
    runtimeModule: 'export const fixture = "sdk-composition";\n',
    mutateManifest: (manifest) => ({
      ...manifest,
      tools: [
        ...manifest.tools,
        { ...manifest.tools[0]!, name: "sdk_composition_ui" },
      ],
      contributions: {
        ...manifest.contributions,
        commands: [
          {
            id: "round-trip",
            title: "Round trip",
            tool: "sdk_composition_ui",
          },
        ],
      },
    }),
  });
  const projects = new ZenXProjectProjection("linux", async (value) => value);
  await projects.updateConfiguration(["/workspace"], "/workspace");
  const appServerPort = new MutableAppServerRequestPort(projects);
  let service!: ZenXCapabilityService;
  let injectedSdk:
    Awaited<ReturnType<typeof createZenXPluginHostSdk>> | undefined;
  service = new ZenXCapabilityService({
    userDataDirectory: path.join(directory, "user-data"),
    resourcesDirectory,
    pnpmCliPath: pnpmCli,
    bundledProvidersOnly: true,
    projectProjection: projects,
    appServerPort,
    trustedProfileLoaders: {
      "sdk-composition": () => ({
        start: (sdk) => {
          injectedSdk = sdk;
        },
        invoke: async (toolName) => {
          if (toolName === "sdk_composition_ui") {
            return {
              output: JSON.stringify({ ui: "round-trip" }),
              exitCode: 0,
            };
          }
          await injectedSdk!.storage.set({ persisted: "value" });
          return {
            output: JSON.stringify({
              projects: await injectedSdk!.query.projects.list(),
              turn: await injectedSdk!.actions.threads.startTurn({
                threadId: "thread-1",
                input: "from plugin",
              }),
              handle: await injectedSdk!.ui.handles.read(
                "sdk-composition:context",
              ),
              command: await injectedSdk!.ui.commands.execute("round-trip"),
              storage: await injectedSdk!.storage.get(),
            }),
            exitCode: 0,
          };
        },
      }),
    },
  });
  await appServerPort.attach({
    request: async () =>
      ({
        data: [
          {
            id: "thread-1",
            cwd: "/workspace",
            status: { type: "idle" },
          },
        ],
        nextCursor: null,
        backwardsCursor: null,
      }) as never,
    completePluginTurn: async (threadId) => ({
      threadId,
      turnId: "turn-1",
      items: [],
    }),
  });
  try {
    await service.initialize();
    await service.installBundledPluginPackage(tarball, {
      pluginId: "sdk-composition",
      packageName: "@zenx-test/sdk-composition",
    });
    const result = JSON.parse(
      (
        await service.execute({
          callId: "sdk-composition-call",
          name: "sdk_composition_echo",
          arguments: {},
          cwd: directory,
          signal: new AbortController().signal,
        })
      ).output,
    ) as Record<string, unknown>;
    assert.deepEqual(result, {
      projects: [
        {
          key: "/workspace",
          workspace: "/workspace",
          configured: true,
          isDefault: true,
          threadIds: ["thread-1"],
        },
      ],
      turn: { threadId: "thread-1", turnId: "turn-1", items: [] },
      handle: { pluginId: "sdk-composition", lifecycle: "enabled" },
      command: { ui: "round-trip" },
      storage: { persisted: "value" },
    });
  } finally {
    await service.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a local Marketplace fixture drives exact versions through the canonical package installer", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zenx-profile-npm-"));
  const userData = path.join(directory, "user-data");
  const v1 = await createTarballFixture(directory, {
    id: "npm-fixture",
    packageName: "@zenx-test/npm-fixture",
    version: "1.0.0",
    outputPrefix: "npm-v1:",
  });
  const v2 = await createTarballFixture(directory, {
    id: "npm-fixture",
    packageName: "@zenx-test/npm-fixture",
    version: "2.0.0",
    outputPrefix: "npm-v2:",
  });
  const registry = await startFixtureRegistry({ "1.0.0": v1, "2.0.0": v2 });
  const service = profileService(userData, {
    pnpmCliPath: pnpmCli,
    pnpmEnvironment: {
      ...process.env,
      npm_config_registry: registry.url,
    },
  });
  const marketplace = new MarketplaceCatalogService({
    load: async () => ({
      entries: [
        {
          packageSpec: "@zenx-test/npm-fixture",
          name: "npm fixture",
          description: "Local Marketplace installer fixture.",
          icon: "fixture",
          recommendedVersion: "2.0.0",
          curated: true,
          versions: [
            {
              version: "2.0.0",
              packageSpec: "@zenx-test/npm-fixture@2.0.0",
            },
            {
              version: "1.0.0",
              packageSpec: "@zenx-test/npm-fixture@1.0.0",
            },
          ],
        },
      ],
    }),
  });
  try {
    await service.initialize();
    const catalog = await marketplace.load();
    await service.installPluginPackage(
      marketplacePackageSource(catalog.entries[0]!, "1.0.0"),
    );
    assert.equal(
      await invoke(service, "npm_fixture_echo", "one"),
      "npm-v1:one",
    );
    const committedBeforeCatalogFailure = structuredClone(
      service.pluginSnapshot(),
    );
    const unavailableMarketplace = new MarketplaceCatalogService({
      load: async () => {
        throw new Error("fixture Marketplace unavailable");
      },
    });
    await assert.rejects(
      unavailableMarketplace.load(),
      /fixture Marketplace unavailable/u,
    );
    assert.deepEqual(service.pluginSnapshot(), committedBeforeCatalogFailure);
    await service.updatePluginPackage(
      "npm-fixture",
      marketplacePackageSource(catalog.entries[0]!, "2.0.0"),
    );
    assert.equal(
      await invoke(service, "npm_fixture_echo", "two"),
      "npm-v2:two",
    );
    assert.equal(
      service.pluginSnapshot().plugins[0]?.profileSource?.resolvedSpec,
      "2.0.0",
    );
  } finally {
    await service.close();
    await registry.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("profile update, remove, restart, reinstall, enablement, and data deletion share one generation lifecycle", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zenx-profile-life-"));
  const userData = path.join(directory, "user-data");
  const firstTarball = await createTarballFixture(directory, {
    id: "life-fixture",
    packageName: "@zenx-test/life-fixture",
    version: "1.0.0",
    outputPrefix: "v1:",
  });
  const secondTarball = await createTarballFixture(directory, {
    id: "life-fixture",
    packageName: "@zenx-test/life-fixture",
    version: "2.0.0",
    outputPrefix: "v2:",
  });
  const service = profileService(userData, { pnpmCliPath: pnpmCli });
  try {
    await service.initialize();
    await service.installPluginTarball(firstTarball);
    await mkdir(path.join(userData, "plugin-data", "life-fixture"), {
      recursive: true,
    });
    await writeFile(
      path.join(userData, "plugin-data", "life-fixture", "state.json"),
      "preserved",
    );
    await Promise.all([
      service.updatePluginPackage("life-fixture", {
        mode: "tarball",
        packageSpec: secondTarball,
      }),
      service.setEnabled("life-fixture", false),
      service.uninstall("life-fixture"),
    ]);
    assert.equal(service.pluginSnapshot().plugins[0]?.lifecycle, "uninstalled");
    assert.equal(service.pluginSnapshot().plugins[0]?.version, "2.0.0");
    const removedCatalog = await readCatalog(userData);
    const removedProfile = JSON.parse(
      await readFile(
        path.join(
          userData,
          "plugin-profile",
          "generations",
          removedCatalog.profileGeneration,
          "package.json",
        ),
        "utf8",
      ),
    ) as { dependencies: Record<string, string> };
    assert.deepEqual(removedProfile.dependencies ?? {}, {});
    assert.equal(
      await readFile(
        path.join(userData, "plugin-data", "life-fixture", "state.json"),
        "utf8",
      ),
      "preserved",
    );
    await service.close();

    const restarted = profileService(userData, { pnpmCliPath: pnpmCli });
    try {
      await restarted.initialize();
      assert.equal(restarted.pluginSnapshot().plugins[0]?.available, false);
      await restarted.reinstall("life-fixture");
      assert.equal(
        restarted.pluginSnapshot().plugins[0]?.lifecycle,
        "installed",
      );
      await restarted.setEnabled("life-fixture", true);
      assert.equal(
        await invoke(restarted, "life_fixture_echo", "again"),
        "v2:again",
      );
      await restarted.setEnabled("life-fixture", false);
      await restarted.deletePluginData("life-fixture");
      await assert.rejects(
        readFile(
          path.join(userData, "plugin-data", "life-fixture", "state.json"),
          "utf8",
        ),
        /ENOENT/u,
      );
    } finally {
      await restarted.close();
    }
  } finally {
    await service.close();
    await rm(directory, { recursive: true, force: true });
  }
});

async function invoke(
  service: ZenXCapabilityService,
  name: string,
  value: string,
): Promise<string> {
  return (
    await service.execute({
      callId: `${name}-${value}`,
      name,
      arguments: { value },
      cwd: process.cwd(),
      signal: new AbortController().signal,
    })
  ).output;
}

async function replaceRuntimePrefix(
  packageDirectory: string,
  before: string,
  after: string,
): Promise<void> {
  const runtimePath = path.join(packageDirectory, "runtime.mjs");
  const source = await readFile(runtimePath, "utf8");
  assert.match(
    source,
    new RegExp(before.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"),
  );
  await writeFile(runtimePath, source.replace(before, after));
}

async function startFixtureRegistry(
  tarballs: Readonly<Record<string, string>>,
): Promise<{
  url: string;
  setLatest(version: string): void;
  close(): Promise<void>;
}> {
  const payloads = new Map<string, Buffer>();
  for (const [version, tarball] of Object.entries(tarballs)) {
    payloads.set(version, await readFile(tarball));
  }
  let latest = Object.keys(tarballs)[0]!;
  let baseUrl = "";
  const server = createServer((request, response) => {
    const tarballMatch = /^\/npm-fixture-(\d+\.\d+\.\d+)\.tgz$/u.exec(
      request.url ?? "",
    );
    if (tarballMatch !== null) {
      const payload = payloads.get(tarballMatch[1]!);
      if (payload === undefined) {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, { "content-type": "application/octet-stream" });
      response.end(payload);
      return;
    }
    const versions = Object.fromEntries(
      [...payloads].map(([version, payload]) => [
        version,
        {
          name: "@zenx-test/npm-fixture",
          version,
          dist: {
            tarball: `${baseUrl}npm-fixture-${version}.tgz`,
            shasum: createHash("sha1").update(payload).digest("hex"),
          },
        },
      ]),
    );
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        name: "@zenx-test/npm-fixture",
        "dist-tags": { latest },
        versions,
      }),
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  baseUrl = `http://127.0.0.1:${String(address.port)}/`;
  return {
    url: baseUrl,
    setLatest: (version) => {
      assert.equal(payloads.has(version), true);
      latest = version;
    },
    close: async () =>
      await new Promise<void>((resolve, reject) =>
        server.close((error) =>
          error === undefined ? resolve() : reject(error),
        ),
      ),
  };
}

function profileService(
  userDataDirectory: string,
  options: Partial<ConstructorParameters<typeof ZenXCapabilityService>[0]>,
): ZenXCapabilityService {
  return new ZenXCapabilityService({
    userDataDirectory,
    bundledProvidersOnly: true,
    ...options,
  });
}

function blockingCatalog(userDataDirectory: string) {
  const delegate = new JsonZenXPluginCatalogStore(
    path.join(userDataDirectory, "capability-grants.json"),
  );
  let active:
    | {
        beforeSave: () => void;
        started: ReturnType<typeof deferred<void>>;
        release: ReturnType<typeof deferred<void>>;
      }
    | undefined;
  return {
    store: {
      load: async () => await delegate.load(),
      save: async (configuration: Parameters<typeof delegate.save>[0]) => {
        const blocked = active;
        if (blocked !== undefined) {
          blocked.beforeSave();
          blocked.started.resolve(undefined);
          await blocked.release.promise;
          if (active === blocked) active = undefined;
        }
        await delegate.save(configuration);
      },
    },
    blockNext: (beforeSave: () => void) => {
      assert.equal(active, undefined);
      const blocked = {
        beforeSave,
        started: deferred<void>(),
        release: deferred<void>(),
      };
      active = blocked;
      return {
        started: blocked.started.promise,
        release: () => blocked.release.resolve(undefined),
      };
    },
    release: () => active?.release.resolve(undefined),
  };
}

async function rawProfileDevRequest(
  descriptorFile: string,
  tokenFile: string,
  body: {
    version: 1;
    projectDirectory: string;
    packageName: string;
    pluginId: string;
  },
) {
  const descriptor = JSON.parse(await readFile(descriptorFile, "utf8")) as {
    url: string;
  };
  const token = (await readFile(tokenFile, "utf8")).trim();
  const request = httpRequest(new URL("/v1/plugins/dev", descriptor.url), {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
  });
  const response = new Promise<{ status: number; body: string }>(
    (resolve, reject) => {
      request.once("error", reject);
      request.once("response", (incoming) => {
        let responseBody = "";
        incoming.setEncoding("utf8");
        incoming.on("data", (chunk) => (responseBody += chunk));
        incoming.once("end", () =>
          resolve({ status: incoming.statusCode ?? 0, body: responseBody }),
        );
      });
    },
  );
  request.end(JSON.stringify(body));
  return { request, response };
}

async function waitForDevCommitFence(
  started: Promise<void>,
  response: Promise<{ status: number; body: string }>,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      started,
      response.then(({ status, body }) => {
        throw new Error(
          `Plugin dev request settled before its commit fence (HTTP ${String(status)}): ${body}`,
        );
      }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(new Error("Timed out waiting for plugin dev commit fence")),
          15_000,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function readCatalog(userDataDirectory: string): Promise<{
  profileGeneration: string;
  packages: Record<string, { profilePackageName?: string }>;
}> {
  return JSON.parse(
    await readFile(
      path.join(userDataDirectory, "capability-grants.json"),
      "utf8",
    ),
  ) as {
    profileGeneration: string;
    packages: Record<string, { profilePackageName?: string }>;
  };
}

async function createFailingPnpm(directory: string): Promise<string> {
  const packageDirectory = path.join(directory, "failing-pnpm");
  await mkdir(path.join(packageDirectory, "bin"), { recursive: true });
  await Promise.all([
    writeFile(
      path.join(packageDirectory, "package.json"),
      `${JSON.stringify({ name: "pnpm", version: BUNDLED_PNPM_VERSION })}\n`,
    ),
    writeFile(
      path.join(packageDirectory, "bin", "pnpm.cjs"),
      "process.exit(42);\n",
    ),
  ]);
  return path.join(packageDirectory, "bin", "pnpm.cjs");
}

async function createStallingPnpm(directory: string): Promise<string> {
  const packageDirectory = path.join(directory, "stalling-pnpm");
  await mkdir(path.join(packageDirectory, "bin"), { recursive: true });
  await Promise.all([
    writeFile(
      path.join(packageDirectory, "package.json"),
      `${JSON.stringify({ name: "pnpm", version: BUNDLED_PNPM_VERSION })}\n`,
    ),
    writeFile(
      path.join(packageDirectory, "bin", "pnpm.cjs"),
      'require("node:fs").writeFileSync(process.env.ZENX_TEST_PNPM_MARKER, "started"); process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);\n',
    ),
  ]);
  return path.join(packageDirectory, "bin", "pnpm.cjs");
}

async function waitForFile(filePath: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  for (;;) {
    try {
      await access(filePath);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (Date.now() >= deadline)
      throw new Error("Timed out waiting for fixture file");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function delayedReadyRuntime(
  pluginId: string,
  marker: string,
  delayMs: number,
): string {
  return `import { writeFileSync } from "node:fs";
import readline from "node:readline";
writeFileSync(${JSON.stringify(marker)}, "started");
setTimeout(() => process.stdout.write(JSON.stringify({version:1,type:"ready",pluginId:${JSON.stringify(pluginId)},packageVersion:"1.0.0"})+"\\n"), ${String(delayMs)});
const lines = readline.createInterface({input:process.stdin});
lines.on("line", (line) => { if (JSON.parse(line).type === "close") process.exit(0); });
`;
}

async function createPluginTarball(directory: string): Promise<string> {
  const transitive = await createTarballFixture(directory, {
    id: "transitive-plugin",
    packageName: "@zenx-test/transitive-plugin",
  });
  return await createTarballFixture(directory, {
    dependencies: { "@zenx-test/transitive-plugin": `file:${transitive}` },
  });
}

async function createPublicSdkPluginTarball(
  directory: string,
): Promise<string> {
  const packageDirectory = path.join(directory, "sdk-created-plugin");
  await run(
    process.execPath,
    [
      pluginSdkCli,
      "create",
      packageDirectory,
      "--name",
      "@zenx-test/sdk-created",
      "--id",
      "sdk-created",
    ],
    { cwd: directory },
  );
  const sdkTarballs = path.join(directory, "sdk-tarballs");
  await mkdir(sdkTarballs);
  const packedSdk = await runNpm(
    ["pack", pluginSdkRoot, "--json", "--pack-destination", sdkTarballs],
    { cwd: directory },
  );
  const sdkFilename = (
    JSON.parse(packedSdk.stdout) as [{ filename: string }]
  )[0].filename;
  const packageFile = path.join(packageDirectory, "package.json");
  const packageJson = JSON.parse(await readFile(packageFile, "utf8")) as {
    dependencies: Record<string, string>;
  };
  packageJson.dependencies["@zenx/plugin-sdk"] = `file:${path.join(
    sdkTarballs,
    sdkFilename,
  )}`;
  await writeFile(packageFile, `${JSON.stringify(packageJson, null, 2)}\n`);
  const packed = await run(
    process.execPath,
    [pluginSdkCli, "pack", packageDirectory],
    { cwd: directory },
  );
  const filename = (JSON.parse(packed.stdout) as [{ filename: string }])[0]
    .filename;
  return path.join(packageDirectory, filename);
}

async function runNpm(args: readonly string[], options: { cwd: string }) {
  const invocation = npmInvocation(args);
  return await run(invocation.executable, invocation.args, options);
}

interface TarballFixtureOptions {
  id?: string;
  packageName?: string;
  description?: string;
  runtimeIdentity?: string;
  omitUiEntry?: boolean;
  dependencies?: Record<string, string>;
  version?: string;
  outputPrefix?: string;
  runtimeType?: "process" | "bundled";
  runtimeModule?: string;
  runtimeTimeoutMs?: number;
  mutateManifest?: (
    manifest: ReturnType<typeof fixtureManifest>,
  ) => ReturnType<typeof fixtureManifest>;
}

async function createTarballFixture(
  directory: string,
  options: TarballFixtureOptions,
): Promise<string> {
  const id = options.id ?? "profile-fixture";
  const packageName = options.packageName ?? "@zenx-test/profile-fixture";
  const version = options.version ?? "1.0.0";
  const packageDirectory = path.join(
    directory,
    `fixture-package-${id}-${version}`,
  );
  const tarballs = path.join(directory, "tarballs");
  await mkdir(packageDirectory, { recursive: true });
  await mkdir(tarballs, { recursive: true });
  await Promise.all([
    writeFile(
      path.join(packageDirectory, "package.json"),
      `${JSON.stringify(
        {
          name: packageName,
          version,
          type: "module",
          zenx: { plugin: "zenx.plugin.json" },
          ...(options.dependencies === undefined
            ? {}
            : { dependencies: options.dependencies }),
          files: ["zenx.plugin.json", "runtime.mjs"],
        },
        null,
        2,
      )}\n`,
    ),
    writeFile(
      path.join(packageDirectory, "zenx.plugin.json"),
      `${JSON.stringify(
        (options.mutateManifest ?? ((manifest) => manifest))(
          fixtureManifest(
            id,
            options.description,
            options.omitUiEntry,
            version,
            options.runtimeType,
            options.runtimeTimeoutMs,
          ),
        ),
        null,
        2,
      )}\n`,
    ),
    writeFile(
      path.join(packageDirectory, "runtime.mjs"),
      options.runtimeModule ??
        `import readline from "node:readline";
process.stdout.write(JSON.stringify({version:1,type:"ready",pluginId:${JSON.stringify(options.runtimeIdentity ?? id)},packageVersion:${JSON.stringify(version)}})+"\\n");
const lines = readline.createInterface({input:process.stdin});
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.type === "close") process.exit(0);
  if (message.type !== "invoke") return;
  process.stdout.write(JSON.stringify({version:1,type:"result",id:message.id,result:{output:${JSON.stringify(options.outputPrefix ?? "profile:")}+String(message.arguments.value),exitCode:0}})+"\\n");
});
`,
    ),
  ]);
  const packed = await run(
    process.execPath,
    [pnpmCli, "pack", "--pack-destination", tarballs],
    { cwd: packageDirectory, env: { ...process.env, PATH: "" } },
  );
  const filename = packed.stdout.trim().split("\n").at(-1);
  assert.ok(filename);
  return path.isAbsolute(filename)
    ? filename
    : path.join(packageDirectory, filename);
}

function fixtureManifest(
  id = "profile-fixture",
  description?: string,
  invalidUiEntry = false,
  version = "1.0.0",
  runtimeType: "process" | "bundled" = "process",
  runtimeTimeoutMs?: number,
): ZenXPluginManifestV2 {
  const toolPrefix = id.replaceAll("-", "_");
  return {
    schemaVersion: 2,
    id,
    name: id === "profile-fixture" ? "Profile fixture" : `Fixture ${id}`,
    version,
    description: description ?? "Installed from a controlled tarball",
    compatibility: { zenx: ">=0.1.0 <0.2.0" },
    runtime: {
      type: runtimeType,
      entry: "runtime.mjs",
      ...(runtimeTimeoutMs === undefined
        ? {}
        : { timeoutMs: runtimeTimeoutMs }),
    },
    mainDocument: `Use ${toolPrefix}_echo to echo exact bytes.`,
    provider: {
      id: `${id}-provider`,
      platforms: ["*"],
      interactionModes: ["background_safe"],
      capabilities: ["profile.echo"],
    },
    permissions: [],
    tools: [
      {
        name: `${toolPrefix}_echo`,
        description: "Echo exact profile bytes",
        inputSchema: {
          type: "object",
          properties: { value: { type: "string" } },
          required: ["value"],
          additionalProperties: false,
        },
        permissions: [],
        interactionMode: "background_safe",
        capabilities: ["profile.echo"],
      },
    ],
    ui: {
      bundles: [
        {
          id: "profile-ui",
          apiVersion: 1,
          kind: "isolated",
          entry: invalidUiEntry ? "" : "<main>Profile fixture UI</main>",
        },
      ],
      surfaces: [
        {
          id: "profile-surface",
          bundleId: "profile-ui",
          exportName: "profile-surface",
        },
      ],
    },
    contributions: {
      pages: [
        {
          id: "profile-page",
          route: `/plugins/${id}/home`,
          title: "Profile fixture",
          surfaceId: "profile-surface",
        },
      ],
    },
  };
}

async function runTurn(
  manager: AppServerManager,
  threadId: string,
  text: string,
): Promise<void> {
  const completed = deferred<void>();
  const dispose = manager.onNotification((method, params) => {
    if (
      method === "turn/completed" &&
      (params as { threadId?: string }).threadId === threadId
    ) {
      completed.resolve();
    }
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await manager.request("turn/start", {
      threadId,
      input: [{ type: "text", text }],
    });
    await Promise.race([
      completed.promise,
      new Promise<never>(
        (_resolve, reject) =>
          (timer = setTimeout(
            () => reject(new Error("Timed out waiting for Turn")),
            10_000,
          )),
      ),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    dispose();
  }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function journalItems(journalPath: string): Promise<CanonicalItem[]> {
  return (await readFile(journalPath, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as CanonicalItem);
}
