import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import type { CanonicalItem } from "../../../src/item.js";
import { AppServerManager } from "../src/main/app-server-manager.js";
import { ZenXCapabilityService } from "../src/main/capability-service.js";
import { JsonZenXCapabilityGrantStore } from "../src/main/capabilities/grant-store.js";
import { BUNDLED_PNPM_VERSION } from "../src/main/plugin-profile.js";

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

test("Settings host installs one tarball through the committed profile and Agent discovery", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-profile-install-"),
  );
  const userData = path.join(directory, "user-data");
  const tarball = await createPluginTarball(directory);
  const capabilities = new ZenXCapabilityService({
    userDataDirectory: userData,
    localDirectory: path.join(userData, "no-legacy-capabilities"),
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
    const store = new JsonZenXCapabilityGrantStore(
      path.join(userData, "capability-grants.json"),
    );
    let failCatalog = false;
    const grantStore = {
      load: async () => await store.load(),
      save: async (configuration: Parameters<typeof store.save>[0]) => {
        if (failCatalog) throw new Error("catalog fixture failure");
        await store.save(configuration);
      },
    };
    const baselineTarball = await createPluginTarball(directory);
    const baseline = profileService(userData, {
      pnpmCliPath: pnpmCli,
      grantStore,
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
          grantStore,
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

test("profile update Catalog failure keeps the old generation and serving runtime", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-profile-update-fail-"),
  );
  const userData = path.join(directory, "user-data");
  const store = new JsonZenXCapabilityGrantStore(
    path.join(userData, "capability-grants.json"),
  );
  let failSave = false;
  const service = profileService(userData, {
    pnpmCliPath: pnpmCli,
    grantStore: {
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

test("npm specs resolve recommended and exact versions through a local registry", async () => {
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
  try {
    await service.initialize();
    registry.setLatest("1.0.0");
    await service.installPluginPackage({
      mode: "npm",
      packageSpec: "@zenx-test/npm-fixture",
    });
    assert.equal(
      await invoke(service, "npm_fixture_echo", "one"),
      "npm-v1:one",
    );
    registry.setLatest("2.0.0");
    await service.updatePluginPackage("npm-fixture");
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
    localDirectory: path.join(userDataDirectory, "no-legacy-capabilities"),
    bundledProvidersOnly: true,
    ...options,
  });
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
  const packedSdk = await run(
    process.platform === "win32" ? "npm.cmd" : "npm",
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
        fixtureManifest(
          id,
          options.description,
          options.omitUiEntry,
          version,
          options.runtimeType,
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
) {
  const toolPrefix = id.replaceAll("-", "_");
  return {
    schemaVersion: 2,
    id,
    name: id === "profile-fixture" ? "Profile fixture" : `Fixture ${id}`,
    version,
    description: description ?? "Installed from a controlled tarball",
    compatibility: { zenx: ">=0.1.0 <0.2.0" },
    runtime: { type: runtimeType, entry: "runtime.mjs" },
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
    resources: [],
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
