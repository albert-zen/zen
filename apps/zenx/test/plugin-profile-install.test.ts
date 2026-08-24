import assert from "node:assert/strict";
import { execFile } from "node:child_process";
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
}

async function createTarballFixture(
  directory: string,
  options: TarballFixtureOptions,
): Promise<string> {
  const id = options.id ?? "profile-fixture";
  const packageName = options.packageName ?? "@zenx-test/profile-fixture";
  const packageDirectory = path.join(directory, `fixture-package-${id}`);
  const tarballs = path.join(directory, "tarballs");
  await mkdir(packageDirectory, { recursive: true });
  await mkdir(tarballs, { recursive: true });
  await Promise.all([
    writeFile(
      path.join(packageDirectory, "package.json"),
      `${JSON.stringify(
        {
          name: packageName,
          version: "1.0.0",
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
        fixtureManifest(id, options.description, options.omitUiEntry),
        null,
        2,
      )}\n`,
    ),
    writeFile(
      path.join(packageDirectory, "runtime.mjs"),
      `import readline from "node:readline";
process.stdout.write(JSON.stringify({version:1,type:"ready",pluginId:${JSON.stringify(options.runtimeIdentity ?? id)},packageVersion:"1.0.0"})+"\\n");
const lines = readline.createInterface({input:process.stdin});
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.type === "close") process.exit(0);
  if (message.type !== "invoke") return;
  process.stdout.write(JSON.stringify({version:1,type:"result",id:message.id,result:{output:"profile:"+String(message.arguments.value),exitCode:0}})+"\\n");
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
) {
  const toolPrefix = id.replaceAll("-", "_");
  return {
    schemaVersion: 2,
    id,
    name: id === "profile-fixture" ? "Profile fixture" : `Fixture ${id}`,
    version: "1.0.0",
    description: description ?? "Installed from a controlled tarball",
    compatibility: { zenx: ">=0.1.0 <0.2.0" },
    runtime: { type: "process", entry: "runtime.mjs" },
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
