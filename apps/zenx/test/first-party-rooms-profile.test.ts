import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import type { CanonicalItem } from "../../../src/item.js";
import { packZenXRoomsPlugin } from "../scripts/pack-first-party-plugins.mjs";
import { AppServerManager } from "../src/main/app-server-manager.js";
import { createBundledAutomationPluginService } from "../src/main/automation-plugin-service.js";
import { ZenXCapabilityService } from "../src/main/capability-service.js";
import { ZENX_ROOMS_CAPABILITY_ID } from "../src/main/capabilities/automation-control-package.js";
import { JsonZenXPluginCatalogStore } from "../src/main/capabilities/plugin-catalog-store.js";
import type { ZenXPluginManifestV2 } from "../src/main/capabilities/types.js";
import {
  createZenXRoomsProfileLoader,
  ZENX_ROOMS_PACKAGE_NAME,
} from "../src/main/rooms-profile-loader.js";
import type { ZenXTriggerAppServerPort } from "../src/main/trigger-service.js";
import { ZenXTriggerStore } from "../src/main/trigger-store.js";

const pnpmCli = fileURLToPath(
  new URL("../../../node_modules/pnpm/bin/pnpm.cjs", import.meta.url),
);

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
  const tarball = await packZenXRoomsPlugin({ outputDirectory: resources });
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
      /already version 1\.0\.0/u,
    );
    const unchangedCatalog = JSON.parse(
      await readFile(path.join(userData, "capability-grants.json"), "utf8"),
    ) as { profileGeneration: string };
    assert.equal(unchangedCatalog.profileGeneration, catalog.profileGeneration);

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
    await capabilities.executePluginCommand(
      ZENX_ROOMS_CAPABILITY_ID,
      "post-message",
      { roomId: temporaryId, text: "temporary message" },
    );
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
    await capabilities.executePluginCommand(
      ZENX_ROOMS_CAPABILITY_ID,
      "post-message",
      { roomId: domain.snapshot().rooms.at(-1)!.id, text: "ready" },
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
      const restored = (await restarted.executePluginCommand(
        ZENX_ROOMS_CAPABILITY_ID,
        "list",
      )) as { rooms: Array<{ name: string }> };
      assert.equal(
        restored.rooms.some((room) => room.name === "release"),
        true,
      );
    } finally {
      await restarted.close();
    }

    await packZenXRoomsPlugin({ outputDirectory: resources });
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
      const reinstalled = (await lifecycle.executePluginCommand(
        ZENX_ROOMS_CAPABILITY_ID,
        "list",
      )) as { rooms: Array<{ name: string }> };
      assert.equal(
        reinstalled.rooms.some((room) => room.name === "release"),
        true,
      );

      await lifecycle.uninstall(ZENX_ROOMS_CAPABILITY_ID);
      await lifecycle.deletePluginData(ZENX_ROOMS_CAPABILITY_ID);
      await lifecycle.reinstall(ZENX_ROOMS_CAPABILITY_ID);
      const cleared = (await lifecycle.executePluginCommand(
        ZENX_ROOMS_CAPABILITY_ID,
        "list",
      )) as { rooms: unknown[] };
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
      const tarball = await packZenXRoomsPlugin({ outputDirectory: resources });
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
  const tarball = await packZenXRoomsPlugin({ outputDirectory: resources });
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

test("an external tarball cannot self-declare the bundled Rooms runtime or trusted UI", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-rooms-untrusted-"),
  );
  const resources = path.join(directory, "resources");
  const tarball = await packZenXRoomsPlugin({ outputDirectory: resources });
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
