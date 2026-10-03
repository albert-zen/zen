import assert from "node:assert/strict";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import type { CanonicalItem } from "../../../src/item.js";
import { ZENX_ROOMS_TARBALL } from "../scripts/pack-first-party-plugins.mjs";
import { AppServerManager } from "../src/main/app-server-manager.js";
import { createBundledAutomationPluginService } from "../src/main/automation-plugin-service.js";
import { installZenXBundledPluginsAtStartup } from "../src/main/bundled-plugin-startup.js";
import { ZenXCapabilityService } from "../src/main/capability-service.js";
import {
  ZenXTriggersCapabilityPackage,
  ZENX_ROOMS_CAPABILITY_ID,
} from "../src/main/capabilities/automation-control-package.js";
import {
  MutableAppServerRequestPort,
  ZenXSelfControlCapabilityPackage,
} from "../src/main/capabilities/self-control-package.js";
import { JsonZenXPluginCatalogStore } from "../src/main/capabilities/plugin-catalog-store.js";
import type { ZenXPluginManifestV2 } from "../src/main/capabilities/types.js";
import {
  createZenXRoomsProfileLoader,
  ZENX_ROOMS_PACKAGE_NAME,
} from "../src/main/rooms-profile-loader.js";
import type { ZenXTriggerAppServerPort } from "../src/main/trigger-service.js";
import { ZenXTriggerStore } from "../src/main/trigger-store.js";
import { createDelegatingFirstPartyProfileLoader } from "../src/main/first-party-profile-loader.js";

const pnpmCli = fileURLToPath(
  new URL("../../../node_modules/pnpm/bin/pnpm.cjs", import.meta.url),
);

// Lifecycle fixtures consume pretest output; packaging tests still build from source.
// Copy into each fixture because lifecycle assertions remove and restore tarballs.
const preparedPluginsDirectory = fileURLToPath(
  new URL("../resources/plugins/", import.meta.url),
);

async function copyPreparedRoomsPlugin(resources: string): Promise<string> {
  const pluginsDirectory = path.join(resources, "plugins");
  await mkdir(pluginsDirectory, { recursive: true });
  const tarball = path.join(pluginsDirectory, ZENX_ROOMS_TARBALL);
  await cp(path.join(preparedPluginsDirectory, ZENX_ROOMS_TARBALL), tarball);
  return tarball;
}

test("packaged Rooms installs offline through profile discovery and preserves its lifecycle data", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-rooms-profile-"),
  );
  const userData = path.join(directory, "user-data");
  const resources = path.join(directory, "resources");
  const legacyFile = path.join(userData, "trigger-registry.json");
  await new ZenXTriggerStore(legacyFile).write({
    triggers: [],
    history: [],
    rooms: [
      {
        id: "legacy-room",
        name: "legacy",
        members: [{ name: "Reviewer", threadId: "thread-reviewer" }],
        messages: [],
        createdAt: 1,
      },
    ],
  });
  const tarball = await copyPreparedRoomsPlugin(resources);
  const appServer = {
    request: async () => {
      throw new Error("Room CRUD must not start a Turn");
    },
    onNotification: () => () => {},
  } as ZenXTriggerAppServerPort;
  const domain = await createBundledAutomationPluginService({
    userDataDirectory: userData,
    appServer,
  });
  await seedLegacyRoomsCatalog(userData, domain);
  const capabilities = new ZenXCapabilityService({
    userDataDirectory: userData,
    resourcesDirectory: resources,
    pnpmCliPath: pnpmCli,
    trustedProfileLoaders: {
      [ZENX_ROOMS_CAPABILITY_ID]: createZenXRoomsProfileLoader(() => domain),
    },
    bundledProvidersOnly: true,
  });
  const manager = appServerManager(directory, userData, capabilities);
  try {
    await capabilities.initialize();
    await capabilities.installBundledPluginPackage(tarball, {
      pluginId: ZENX_ROOMS_CAPABILITY_ID,
      packageName: ZENX_ROOMS_PACKAGE_NAME,
    });
    const installed = capabilities.pluginSnapshot();
    assert.deepEqual(
      installed.plugins.map(({ id, source, lifecycle }) => ({
        id,
        source,
        lifecycle,
      })),
      [
        {
          id: ZENX_ROOMS_CAPABILITY_ID,
          source: "bundled",
          lifecycle: "enabled",
        },
      ],
    );
    assert.equal(installed.bundles[0]?.kind, "trusted");
    assert.equal(installed.bundles[0]?.entry, "zenx/bundled/rooms-ui");
    assert.equal(installed.pages[0]?.route, "/plugins/zenx-rooms/rooms");
    const catalog = JSON.parse(
      await readFile(path.join(userData, "capability-grants.json"), "utf8"),
    ) as {
      profileGeneration: string;
      packages: Record<
        string,
        {
          source: string;
          profilePackageName?: string;
          profileSource?: { mode: string; packageSpec: string };
        }
      >;
    };
    assert.equal(catalog.packages[ZENX_ROOMS_CAPABILITY_ID]?.source, "bundled");
    assert.equal(
      catalog.packages[ZENX_ROOMS_CAPABILITY_ID]?.profilePackageName,
      ZENX_ROOMS_PACKAGE_NAME,
    );
    assert.equal(
      catalog.packages[ZENX_ROOMS_CAPABILITY_ID]?.profileSource?.mode,
      "bundled",
    );
    assert.equal(
      catalog.packages[ZENX_ROOMS_CAPABILITY_ID]?.profileSource?.packageSpec,
      await realpath(tarball),
    );
    await assert.rejects(
      capabilities.installBundledPluginPackage(tarball, {
        pluginId: ZENX_ROOMS_CAPABILITY_ID,
        packageName: ZENX_ROOMS_PACKAGE_NAME,
      }),
      /already version 1\.0\.5/u,
    );
    const unchangedCatalog = JSON.parse(
      await readFile(path.join(userData, "capability-grants.json"), "utf8"),
    ) as { profileGeneration: string };
    assert.equal(unchangedCatalog.profileGeneration, catalog.profileGeneration);

    // Installed profile loader (not a source-runtime stand-in) must preserve
    // the Host-minted distinction when an Agent supplies a forged nested input.
    await assert.rejects(
      capabilities.execute(
        invocation("agent-forged-list", "zenx_rooms_list", {
          input: { cursor: 0 },
        }),
      ),
      /Trusted Room UI required/u,
    );
    const ordinaryAgentList = await capabilities.execute(
      invocation("agent-list", "zenx_rooms_list", { cursor: 0 }),
    );
    assert.equal(
      (
        JSON.parse(ordinaryAgentList.output) as {
          rooms: Array<{ operationEpoch?: string }>;
        }
      ).rooms[0]?.operationEpoch,
      undefined,
    );
    await assert.rejects(
      capabilities.execute(
        invocation("agent-prepare", "zenx_rooms_prepare_message", {
          input: {
            roomId: "legacy-room",
            operationId: `legacy:${crypto.randomUUID()}`,
            text: "forged human",
          },
        }),
      ),
      /Trusted Room UI required/u,
    );

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
      '!tool zenx_plugin {"operation":"read","pluginId":"zenx-rooms"}',
    );
    await runTurn(manager, thread.id, "!tool zenx_rooms_list {}");
    const results = (
      await journalItems(
        path.join(directory, "zen-data", "threads", `${thread.id}.jsonl`),
      )
    ).filter((item) => item.type === "tool_result");
    assert.equal(
      JSON.parse(results.at(-3)!.output).plugins[0].id,
      "zenx-rooms",
    );
    assert.match(
      JSON.parse(results.at(-2)!.output).plugin.mainDocument,
      /Rooms/u,
    );
    assert.deepEqual(
      (
        JSON.parse(results.at(-1)!.output) as { rooms: Array<{ id: string }> }
      ).rooms.map((room) => room.id),
      ["legacy-room"],
    );

    await capabilities.executePluginCommand(
      ZENX_ROOMS_CAPABILITY_ID,
      "create",
      {
        name: "temporary",
        members: [{ name: "Owner", threadId: "thread-owner" }],
      },
    );
    const temporaryId = domain.snapshot().rooms.at(-1)!.id;
    await capabilities.executePluginCommand(
      ZENX_ROOMS_CAPABILITY_ID,
      "rename",
      {
        roomId: temporaryId,
        name: "renamed",
      },
    );
    await capabilities.executePluginCommand(
      ZENX_ROOMS_CAPABILITY_ID,
      "add-member",
      { roomId: temporaryId, name: "Reviewer", threadId: "thread-reviewer-2" },
    );
    await capabilities.executePluginCommand(
      ZENX_ROOMS_CAPABILITY_ID,
      "remove-member",
      { roomId: temporaryId, threadId: "thread-reviewer-2" },
    );
    await postTrustedHuman(capabilities, temporaryId, "temporary message");
    assert.equal(
      domain.snapshot().rooms.find((room) => room.id === temporaryId)?.name,
      "renamed",
    );
    await capabilities.executePluginCommand(
      ZENX_ROOMS_CAPABILITY_ID,
      "delete",
      {
        roomId: temporaryId,
      },
    );
    assert.equal(
      domain.snapshot().rooms.some((room) => room.id === temporaryId),
      false,
    );

    await capabilities.executePluginCommand(
      ZENX_ROOMS_CAPABILITY_ID,
      "create",
      {
        name: "release",
        members: [{ name: "Builder", threadId: "thread-builder" }],
      },
    );
    await postTrustedHuman(
      capabilities,
      domain.snapshot().rooms.at(-1)!.id,
      "ready",
    );
    assert.equal(domain.snapshot().rooms.at(-1)?.messages[0]?.author, "You");

    await capabilities.setEnabled(ZENX_ROOMS_CAPABILITY_ID, false);
    assert.deepEqual(capabilities.pluginSnapshot().pages, []);
    await assert.rejects(
      capabilities.execute(invocation("disabled", "zenx_rooms_list", {})),
      /Unsupported tool/u,
    );
    await capabilities.setEnabled(ZENX_ROOMS_CAPABILITY_ID, true);
    await manager.stop();
    await capabilities.close();

    await rm(tarball, { force: true });
    const restartedDomain = await createBundledAutomationPluginService({
      userDataDirectory: userData,
      appServer,
    });
    const restarted = new ZenXCapabilityService({
      userDataDirectory: userData,
      resourcesDirectory: resources,
      pnpmCliPath: path.join(directory, "missing-pnpm.cjs"),
      trustedProfileLoaders: {
        [ZENX_ROOMS_CAPABILITY_ID]: createZenXRoomsProfileLoader(
          () => restartedDomain,
        ),
      },
      bundledProvidersOnly: true,
    });
    try {
      await restarted.initialize();
      assert.equal(restarted.pluginSnapshot().plugins[0]?.lifecycle, "enabled");
      const restored = await listAllRoomPages(restarted);
      assert.equal(
        restored.rooms.some((room) => room.name === "release"),
        true,
      );
    } finally {
      await restarted.close();
    }

    await copyPreparedRoomsPlugin(resources);
    const lifecycleDomain = await createBundledAutomationPluginService({
      userDataDirectory: userData,
      appServer,
    });
    const lifecycle = new ZenXCapabilityService({
      userDataDirectory: userData,
      resourcesDirectory: resources,
      pnpmCliPath: pnpmCli,
      trustedProfileLoaders: {
        [ZENX_ROOMS_CAPABILITY_ID]: createZenXRoomsProfileLoader(
          () => lifecycleDomain,
        ),
      },
      bundledProvidersOnly: true,
    });
    try {
      await lifecycle.initialize();
      await lifecycle.uninstall(ZENX_ROOMS_CAPABILITY_ID);
      const preserved = await readFile(
        path.join(
          userData,
          "plugin-data",
          ZENX_ROOMS_CAPABILITY_ID,
          "storage.json",
        ),
        "utf8",
      );
      assert.match(preserved, /release/u);
      await lifecycle.reinstall(ZENX_ROOMS_CAPABILITY_ID);
      const reinstalled = await listAllRoomPages(lifecycle);
      assert.equal(
        reinstalled.rooms.some((room) => room.name === "release"),
        true,
      );

      await lifecycle.uninstall(ZENX_ROOMS_CAPABILITY_ID);
      await lifecycle.deletePluginData(ZENX_ROOMS_CAPABILITY_ID);
      await lifecycle.reinstall(ZENX_ROOMS_CAPABILITY_ID);
      const cleared = await listAllRoomPages(lifecycle);
      assert.deepEqual(cleared.rooms, []);
      assert.equal(await readFile(legacyFile, "utf8").then(Boolean), true);
    } finally {
      await lifecycle.close();
    }
  } finally {
    await manager.stop();
    await capabilities.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("packaged Rooms adopts disabled and uninstalled legacy Catalog lifecycle without a second authority", async (t) => {
  for (const lifecycle of ["installed", "uninstalled"] as const) {
    await t.test(lifecycle, async () => {
      const directory = await mkdtemp(
        path.join(os.tmpdir(), `zenx-rooms-adopt-${lifecycle}-`),
      );
      const userData = path.join(directory, "user-data");
      const resources = path.join(directory, "resources");
      const tarball = await copyPreparedRoomsPlugin(resources);
      const appServer = {
        request: async () => {
          throw new Error("Room adoption must not start a Turn");
        },
        onNotification: () => () => {},
      } as ZenXTriggerAppServerPort;
      const domain = await createBundledAutomationPluginService({
        userDataDirectory: userData,
        appServer,
      });
      await seedLegacyRoomsCatalog(userData, domain, lifecycle);
      const capabilities = new ZenXCapabilityService({
        userDataDirectory: userData,
        resourcesDirectory: resources,
        pnpmCliPath: pnpmCli,
        trustedProfileLoaders: {
          [ZENX_ROOMS_CAPABILITY_ID]: createZenXRoomsProfileLoader(
            () => domain,
          ),
        },
        bundledProvidersOnly: true,
      });
      try {
        await capabilities.initialize();
        await capabilities.installBundledPluginPackage(tarball, {
          pluginId: ZENX_ROOMS_CAPABILITY_ID,
          packageName: ZENX_ROOMS_PACKAGE_NAME,
        });
        const adopted = capabilities.pluginSnapshot().plugins[0]!;
        assert.equal(adopted.lifecycle, lifecycle);
        assert.equal(adopted.profileSource?.mode, "bundled");
        assert.equal(adopted.available, lifecycle === "installed");
        const profilePackage = JSON.parse(
          await readFile(
            path.join(
              userData,
              "plugin-profile",
              "generations",
              JSON.parse(
                await readFile(
                  path.join(userData, "capability-grants.json"),
                  "utf8",
                ),
              ).profileGeneration,
              "package.json",
            ),
            "utf8",
          ),
        ) as { dependencies?: Record<string, string> };
        assert.equal(
          profilePackage.dependencies?.[ZENX_ROOMS_PACKAGE_NAME] !== undefined,
          lifecycle === "installed",
        );
        if (lifecycle === "uninstalled") {
          await capabilities.reinstall(ZENX_ROOMS_CAPABILITY_ID);
          assert.equal(
            capabilities.pluginSnapshot().plugins[0]?.lifecycle,
            "enabled",
          );
        }
      } finally {
        await capabilities.close();
        await rm(directory, { recursive: true, force: true });
      }
    });
  }
});

test("packaged Rooms refuses bundled adoption across a legacy Catalog identity mismatch", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-rooms-adopt-mismatch-"),
  );
  const userData = path.join(directory, "user-data");
  const resources = path.join(directory, "resources");
  const tarball = await copyPreparedRoomsPlugin(resources);
  const appServer = {
    request: async () => {
      throw new Error("Room adoption must not start a Turn");
    },
    onNotification: () => () => {},
  } as ZenXTriggerAppServerPort;
  const domain = await createBundledAutomationPluginService({
    userDataDirectory: userData,
    appServer,
  });
  await seedLegacyRoomsCatalog(userData, domain);
  const catalogFile = path.join(userData, "capability-grants.json");
  const catalog = JSON.parse(await readFile(catalogFile, "utf8")) as {
    packages: Record<string, { manifest: { name: string } }>;
  };
  catalog.packages[ZENX_ROOMS_CAPABILITY_ID]!.manifest.name = "Legacy Rooms";
  await writeFile(catalogFile, `${JSON.stringify(catalog, null, 2)}\n`);
  const capabilities = new ZenXCapabilityService({
    userDataDirectory: userData,
    resourcesDirectory: resources,
    pnpmCliPath: pnpmCli,
    trustedProfileLoaders: {
      [ZENX_ROOMS_CAPABILITY_ID]: createZenXRoomsProfileLoader(() => domain),
    },
    bundledProvidersOnly: true,
  });
  try {
    await capabilities.initialize();
    await assert.rejects(
      capabilities.installBundledPluginPackage(tarball, {
        pluginId: ZENX_ROOMS_CAPABILITY_ID,
        packageName: ZENX_ROOMS_PACKAGE_NAME,
      }),
      /does not match its Catalog identity/u,
    );
    assert.equal(
      capabilities.pluginSnapshot().plugins[0]?.profileSource,
      undefined,
    );
  } finally {
    await capabilities.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("packaged startup isolates a Rooms identity mismatch and starts with a later first-party plugin", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-bundled-startup-isolation-"),
  );
  const userData = path.join(directory, "user-data");
  const resources = path.join(directory, "resources");
  await cp(preparedPluginsDirectory, path.join(resources, "plugins"), {
    recursive: true,
  });
  const appServer = {
    request: async () => {
      throw new Error("Startup fixture must not start an automation Turn");
    },
    onNotification: () => () => {},
  } as ZenXTriggerAppServerPort;
  const domain = await createBundledAutomationPluginService({
    userDataDirectory: userData,
    appServer,
  });
  const selfControlPort = new MutableAppServerRequestPort();
  const selfControlPackage = new ZenXSelfControlCapabilityPackage({
    appServer: selfControlPort,
  });
  await seedLegacyRoomsCatalog(userData, domain);
  const catalogFile = path.join(userData, "capability-grants.json");
  const catalog = JSON.parse(await readFile(catalogFile, "utf8")) as {
    packages: Record<
      string,
      { manifest: ZenXPluginManifestV2 & { resources?: unknown[] } }
    >;
  };
  catalog.packages[ZENX_ROOMS_CAPABILITY_ID]!.manifest.resources = [];
  await writeFile(catalogFile, `${JSON.stringify(catalog, null, 2)}\n`);
  const triggersPackage = new ZenXTriggersCapabilityPackage(domain);
  const capabilities = new ZenXCapabilityService({
    userDataDirectory: userData,
    resourcesDirectory: resources,
    pnpmCliPath: pnpmCli,
    trustedProfileLoaders: {
      [ZENX_ROOMS_CAPABILITY_ID]: createZenXRoomsProfileLoader(() => domain),
      "zenx-triggers": createDelegatingFirstPartyProfileLoader(
        () => triggersPackage,
      ),
      "zenx-self-control": createDelegatingFirstPartyProfileLoader(
        () => selfControlPackage,
      ),
    },
    bundledProvidersOnly: true,
  });
  const manager = appServerManager(directory, userData, capabilities);
  try {
    await selfControlPort.attach(manager);
    await capabilities.initialize();
    await installZenXBundledPluginsAtStartup(capabilities, resources);

    const plugins = capabilities.pluginSnapshot().plugins;
    assert.equal(
      plugins.find((plugin) => plugin.id === ZENX_ROOMS_CAPABILITY_ID)
        ?.profileSource,
      undefined,
    );
    assert.equal(
      plugins.find((plugin) => plugin.id === "zenx-triggers")?.profileSource
        ?.mode,
      "bundled",
    );
    assert.match(
      capabilities.diagnostics().discoveryErrors.join("\n"),
      /zenx-rooms: .*does not match its Catalog identity/u,
    );

    await manager.start();
    assert.equal(manager.status.type, "ready");
    assert.equal(
      typeof (await manager.request("thread/start", {})).thread.id,
      "string",
    );
  } finally {
    await manager.stop();
    await capabilities.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("an external tarball cannot self-declare the bundled Rooms runtime or trusted UI", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-rooms-untrusted-"),
  );
  const resources = path.join(directory, "resources");
  const tarball = await copyPreparedRoomsPlugin(resources);
  const capabilities = new ZenXCapabilityService({
    userDataDirectory: path.join(directory, "user-data"),
    pnpmCliPath: pnpmCli,
    bundledProvidersOnly: true,
  });
  try {
    await capabilities.initialize();
    await assert.rejects(
      capabilities.installPluginTarball(tarball),
      /bundled runtime is not admitted by App Resources|UI must use the isolated host/u,
    );
    assert.deepEqual(capabilities.pluginSnapshot().plugins, []);
  } finally {
    await capabilities.close();
    await rm(directory, { recursive: true, force: true });
  }
});

function appServerManager(
  directory: string,
  userData: string,
  capabilities: ZenXCapabilityService,
): AppServerManager {
  return new AppServerManager({
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
}

async function seedLegacyRoomsCatalog(
  userDataDirectory: string,
  _domain: Awaited<ReturnType<typeof createBundledAutomationPluginService>>,
  lifecycle: "enabled" | "installed" | "uninstalled" = "enabled",
): Promise<void> {
  const manifest = JSON.parse(
    await readFile(
      fileURLToPath(
        new URL(
          "../../../packages/zenx-rooms-plugin/zenx.plugin.json",
          import.meta.url,
        ),
      ),
      "utf8",
    ),
  ) as ZenXPluginManifestV2;
  await new JsonZenXPluginCatalogStore(
    path.join(userDataDirectory, "capability-grants.json"),
  ).save({
    disabled: lifecycle === "installed" ? [ZENX_ROOMS_CAPABILITY_ID] : [],
    uninstalled: lifecycle === "uninstalled" ? [ZENX_ROOMS_CAPABILITY_ID] : [],
    packages: {
      [ZENX_ROOMS_CAPABILITY_ID]: { manifest, source: "bundled" },
    },
  });
}

function invocation(
  callId: string,
  name: string,
  arguments_: Record<string, unknown>,
) {
  return {
    callId,
    name,
    arguments: arguments_,
    cwd: process.cwd(),
    signal: new AbortController().signal,
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
            () => reject(new Error("Timed out waiting for Room Turn")),
            10_000,
          )),
      ),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    dispose();
  }
}

async function journalItems(filename: string): Promise<CanonicalItem[]> {
  return (await readFile(filename, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as CanonicalItem);
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function listAllRoomPages(
  capabilities: ZenXCapabilityService,
): Promise<{ rooms: Array<{ name: string }> }> {
  const rooms: Array<{ name: string }> = [];
  let cursor: number | null = 0;
  while (cursor !== null) {
    const page = (await capabilities.executePluginCommand(
      ZENX_ROOMS_CAPABILITY_ID,
      "list",
      { cursor },
    )) as { rooms: Array<{ name: string }>; nextCursor: number | null };
    rooms.push(...page.rooms);
    cursor = page.nextCursor;
  }
  return { rooms };
}

async function postTrustedHuman(
  capabilities: ZenXCapabilityService,
  roomId: string,
  text: string,
): Promise<void> {
  let cursor: number | null = 0;
  let operationEpoch: string | undefined;
  while (cursor !== null) {
    const page = (await capabilities.executePluginCommand(
      ZENX_ROOMS_CAPABILITY_ID,
      "list",
      { cursor },
    )) as {
      rooms: Array<{ id: string; operationEpoch?: string }>;
      nextCursor: number | null;
    };
    operationEpoch = page.rooms.find(
      (room) => room.id === roomId,
    )?.operationEpoch;
    if (operationEpoch) break;
    cursor = page.nextCursor;
  }
  if (!operationEpoch) throw new Error("Room send epoch not found");
  const operationId = `${operationEpoch}:${crypto.randomUUID()}`;
  await capabilities.executePluginCommand(
    ZENX_ROOMS_CAPABILITY_ID,
    "prepare-message",
    { roomId, operationId, text },
  );
  await capabilities.executePluginCommand(
    ZENX_ROOMS_CAPABILITY_ID,
    "post-message",
    { roomId, operationId, text },
  );
}

test("normal bundled profile upgrades 1.0.3 to Companion notebook tools without losing Room data", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-rooms-upgrade-"),
  );
  const userData = path.join(directory, "user-data");
  const resources = path.join(directory, "resources");
  const tarball = await copyPreparedRoomsPlugin(resources);
  const oldDirectory = path.join(directory, "old-package");
  await mkdir(oldDirectory, { recursive: true });
  const run = promisify(execFile);
  // A synthetic previous package advertises the 1.0.3 tool surface. It uses
  // known local runtime bytes; this proves real profile admission/upgrade, not
  // a direct source-runtime substitute or an ignored cached archive.
  await run("tar", ["-xzf", tarball, "-C", oldDirectory]);
  const oldPackage = path.join(oldDirectory, "package");
  const oldManifestFile = path.join(oldPackage, "zenx.plugin.json");
  const oldPackageFile = path.join(oldPackage, "package.json");
  const oldManifest = JSON.parse(await readFile(oldManifestFile, "utf8"));
  oldManifest.version = "1.0.3";
  oldManifest.tools = oldManifest.tools.filter(
    (tool: { name: string }) =>
      !["zenx_rooms_workspace", "zenx_rooms_update_workspace"].includes(
        tool.name,
      ),
  );
  oldManifest.contributions.commands =
    oldManifest.contributions.commands.filter(
      (command: { id: string }) =>
        !["workspace", "update-workspace"].includes(command.id),
    );
  const oldPackageJson = JSON.parse(await readFile(oldPackageFile, "utf8"));
  oldPackageJson.version = "1.0.3";
  await writeFile(oldManifestFile, JSON.stringify(oldManifest));
  await writeFile(oldPackageFile, JSON.stringify(oldPackageJson));
  const oldTarball = path.join(
    resources,
    "plugins",
    "zenx-rooms-plugin-1.0.3.tgz",
  );
  await run("tar", ["-czf", oldTarball, "-C", oldDirectory, "package"]);
  await new ZenXTriggerStore(
    path.join(userData, "trigger-registry.json"),
  ).write({
    triggers: [],
    history: [],
    rooms: [
      {
        id: "companion-room",
        name: "User chosen name",
        members: [{ name: "Aster", threadId: "assistant-thread" }],
        assistant: { threadId: "assistant-thread", triggerId: "owned-trigger" },
        messages: [],
        createdAt: 1,
      },
    ],
  });
  const domain = await createBundledAutomationPluginService({
    userDataDirectory: userData,
    appServer: {
      request: async () => {
        throw Error("Notebook tools must not call a model");
      },
      onNotification: () => () => {},
    } as never,
  });
  const options = {
    userDataDirectory: userData,
    resourcesDirectory: resources,
    pnpmCliPath: pnpmCli,
    trustedProfileLoaders: {
      [ZENX_ROOMS_CAPABILITY_ID]: createZenXRoomsProfileLoader(() => domain),
    },
    bundledProvidersOnly: true,
  };
  const capabilities = new ZenXCapabilityService(options);
  try {
    await capabilities.initialize();
    await capabilities.installBundledPluginPackage(oldTarball, {
      pluginId: ZENX_ROOMS_CAPABILITY_ID,
      packageName: ZENX_ROOMS_PACKAGE_NAME,
    });
    assert.equal(
      capabilities
        .pluginSnapshot()
        .plugins.find((plugin) => plugin.id === ZENX_ROOMS_CAPABILITY_ID)
        ?.version,
      "1.0.3",
    );
    await assert.rejects(
      capabilities.executePluginCommand(ZENX_ROOMS_CAPABILITY_ID, "workspace", {
        roomId: "companion-room",
      }),
    );
    await installZenXBundledPluginsAtStartup(capabilities, resources);
    assert.equal(
      capabilities
        .pluginSnapshot()
        .plugins.find((plugin) => plugin.id === ZENX_ROOMS_CAPABILITY_ID)
        ?.version,
      "1.0.5",
    );
    const before = await capabilities.executePluginCommand(
      ZENX_ROOMS_CAPABILITY_ID,
      "workspace",
      { roomId: "companion-room" },
    );
    assert.deepEqual(before, {
      revision: 0,
      updatedAt: 0,
      matters: [],
      memory: [],
    });
    const saved = (await capabilities.executePluginCommand(
      ZENX_ROOMS_CAPABILITY_ID,
      "update-workspace",
      {
        roomId: "companion-room",
        expectedRevision: 0,
        matters: [],
        memory: [
          {
            id: "decision",
            title: "User decision",
            text: "Inspectable after package restart",
          },
        ],
      },
    )) as { revision: number };
    assert.equal(saved.revision, 1);
    assert.equal(domain.snapshot().rooms[0]?.name, "User chosen name");
    assert.equal(domain.snapshot().rooms[0]?.members[0]?.name, "Aster");
    await capabilities.setEnabled(ZENX_ROOMS_CAPABILITY_ID, false);
    await capabilities.setEnabled(ZENX_ROOMS_CAPABILITY_ID, true);
    const reloaded = (await capabilities.executePluginCommand(
      ZENX_ROOMS_CAPABILITY_ID,
      "workspace",
      { roomId: "companion-room" },
    )) as { revision: number; memory: Array<{ text: string }> };
    assert.equal(reloaded.revision, 1);
    assert.equal(reloaded.memory[0]?.text, "Inspectable after package restart");
  } finally {
    await capabilities.close();
    await rm(directory, { recursive: true, force: true });
  }
});
