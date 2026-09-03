import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { ZenXCapabilityService } from "../src/main/capability-service.js";
import { ZenXTriggersCapabilityPackage } from "../src/main/capabilities/automation-control-package.js";
import type { ZenXAutomationControlPort } from "../src/main/capabilities/automation-control-package.js";
import {
  BrowserZenXCapabilityPackage,
  type ZenXBrowserBackend,
} from "../src/main/capabilities/browser-provider.js";
import type { ZenXComputerBackend } from "../src/main/capabilities/computer-provider.js";
import { JsonZenXPluginCatalogStore } from "../src/main/capabilities/plugin-catalog-store.js";
import type {
  ZenXPluginCatalogState,
  ZenXPluginCatalogStore,
  ZenXCapabilityPackage,
} from "../src/main/capabilities/types.js";
import {
  MutableAppServerRequestPort,
  ZenXSelfControlCapabilityPackage,
} from "../src/main/capabilities/self-control-package.js";
import {
  createDelegatingFirstPartyProfileLoader,
  FIRST_PARTY_PLUGIN_PACKAGES,
} from "../src/main/first-party-profile-loader.js";

const pnpmCli = fileURLToPath(
  new URL("../../../node_modules/pnpm/bin/pnpm.cjs", import.meta.url),
);
const preparedPluginsDirectory = fileURLToPath(
  new URL("../resources/plugins/", import.meta.url),
);

async function copyPreparedFirstPartyPlugins(
  outputDirectory: string,
): Promise<void> {
  await cp(preparedPluginsDirectory, path.join(outputDirectory, "plugins"), {
    recursive: true,
  });
}

test("remaining first-party tarballs install, invoke, cycle lifecycle, and restart offline", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "zenx-first-party-profile-"),
  );
  const userData = path.join(root, "user-data");
  const resources = path.join(root, "resources");
  await copyPreparedFirstPartyPlugins(resources);
  const selfPort = new MutableAppServerRequestPort();
  await selfPort.attach({ request: async () => ({ data: [] }) as never });
  const self = new ZenXSelfControlCapabilityPackage({ appServer: selfPort });
  const triggers = new ZenXTriggersCapabilityPackage(automationPort());
  let service!: ZenXCapabilityService;
  const create = (missingPnpm = false) => {
    service = new ZenXCapabilityService({
      userDataDirectory: userData,
      resourcesDirectory: resources,
      pnpmCliPath: missingPnpm ? path.join(root, "missing-pnpm.cjs") : pnpmCli,
      bundledProvidersOnly: true,
      browserBackend: browserBackend(),
      computerBackend: computerBackend(),
      providerCatalogOptions: { platform: "darwin" },
      trustedProfileLoaders: {
        browser: createDelegatingFirstPartyProfileLoader(() =>
          service.browserProfilePackage(),
        ),
        computer: createDelegatingFirstPartyProfileLoader(() =>
          service.computerProfilePackage(),
        ),
        "zenx-self-control": createDelegatingFirstPartyProfileLoader(
          () => self,
        ),
        "zenx-triggers": createDelegatingFirstPartyProfileLoader(
          () => triggers,
        ),
      },
    });
    return service;
  };
  try {
    await create().initialize();
    for (const definition of [
      FIRST_PARTY_PLUGIN_PACKAGES.browser,
      FIRST_PARTY_PLUGIN_PACKAGES.computer,
      FIRST_PARTY_PLUGIN_PACKAGES.selfControl,
      FIRST_PARTY_PLUGIN_PACKAGES.triggers,
    ]) {
      await service.installBuiltInPlugin(definition.pluginId);
    }
    assert.deepEqual(
      service
        .pluginSnapshot()
        .plugins.map((plugin) => plugin.id)
        .sort(),
      ["browser", "computer", "zenx-self-control", "zenx-triggers"],
    );
    assert.deepEqual(
      await call(service, "browser_list_tabs", { sessionId: "test" }),
      [],
    );
    assert.equal(
      (
        (await call(service, "computer_inspect", {
          target: { pid: 1, windowTitle: "Fixture" },
        })) as { observationId: string }
      ).observationId,
      "computer-observation",
    );
    assert.equal(
      service
        .hostSnapshot()
        .definitions.some((tool) =>
          tool.name.startsWith("computer_foreground_"),
        ),
      false,
    );
    await assert.rejects(
      call(service, "computer_foreground_click", { x: 10, y: 20 }),
      /foreground_required/u,
    );
    service.setForegroundRequiredAllowed(true);
    assert.equal(
      service
        .hostSnapshot()
        .definitions.some((tool) =>
          tool.name.startsWith("computer_foreground_"),
        ),
      true,
    );
    service.setForegroundRequiredAllowed(false);
    assert.equal(
      service
        .hostSnapshot()
        .definitions.some((tool) =>
          tool.name.startsWith("computer_foreground_"),
        ),
      false,
    );
    await assert.rejects(
      call(service, "computer_foreground_click", { x: 10, y: 20 }),
      /foreground_required/u,
    );
    assert.deepEqual(
      (
        (await call(service, "zenx_projects_list", {})) as {
          projects: unknown[];
        }
      ).projects,
      [],
    );
    assert.deepEqual(
      (
        (await call(service, "zenx_triggers_list", {})) as {
          triggers: unknown[];
        }
      ).triggers,
      [],
    );
    const playwrightCandidate = await browserCandidate(
      "../../../packages/zenx-browser-plugin/variants/playwright.zenx.plugin.json",
      browserBackend("playwright"),
    );
    await service.replaceBundledProviderVariant(
      path.join(
        resources,
        "plugins",
        "zenx-browser-plugin-playwright-1.0.0.tgz",
      ),
      { pluginId: "browser", packageName: "@zenx/browser-plugin" },
      playwrightCandidate,
    );
    assert.equal(
      service.browserProfilePackage().manifest.provider.id,
      "playwright-cli",
    );
    assert.equal(
      (
        (await call(service, "browser_list_tabs", { sessionId: "test" })) as [
          { title: string },
        ]
      )[0].title,
      "playwright",
    );
    const electronCandidate = await browserCandidate(
      "../../../packages/zenx-browser-plugin/zenx.plugin.json",
      browserBackend("electron"),
    );
    await service.replaceBundledProviderVariant(
      path.join(resources, "plugins", "zenx-browser-plugin-electron-1.0.0.tgz"),
      { pluginId: "browser", packageName: "@zenx/browser-plugin" },
      electronCandidate,
    );
    for (const pluginId of [
      "browser",
      "computer",
      "zenx-self-control",
      "zenx-triggers",
    ]) {
      await service.setEnabled(pluginId, false);
      assert.equal(
        service
          .pluginSnapshot()
          .plugins.find((plugin) => plugin.id === pluginId)?.lifecycle,
        "installed",
      );
      await service.setEnabled(pluginId, true);
      await service.uninstall(pluginId);
      assert.equal(
        service
          .pluginSnapshot()
          .plugins.find((plugin) => plugin.id === pluginId)?.lifecycle,
        "uninstalled",
      );
      await service.deletePluginData(pluginId);
      await service.reinstall(pluginId);
      assert.equal(
        service
          .pluginSnapshot()
          .plugins.find((plugin) => plugin.id === pluginId)?.lifecycle,
        "enabled",
      );
    }
    await service.close();
    await rm(path.join(resources, "plugins"), { recursive: true, force: true });
    await create(true).initialize();
    assert.deepEqual(
      service
        .pluginSnapshot()
        .plugins.map((plugin) => plugin.id)
        .sort(),
      ["browser", "computer", "zenx-self-control", "zenx-triggers"],
    );
    assert.equal(
      service.pluginSnapshot().plugins.find((plugin) => plugin.id === "browser")
        ?.available,
      true,
      service.diagnostics().discoveryErrors.join("\n"),
    );
    assert.deepEqual(
      await call(service, "browser_list_tabs", { sessionId: "restart" }),
      [],
    );
  } finally {
    await service?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("an uninstalled Browser reinstalls the current Host-selected App Resource variant", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "zenx-browser-marketplace-reinstall-"),
  );
  const resources = path.join(root, "resources");
  const userData = path.join(root, "user-data");
  await copyPreparedFirstPartyPlugins(resources);
  const environment: NodeJS.ProcessEnv = {
    PATH: "",
    ZENX_BROWSER_MODE: "user-session",
    ZENX_USER_BROWSER_CDP_ENDPOINT: "http://127.0.0.1:9222",
  };
  const initial = trackedBrowserBackend("user-session");
  const first = selectorBrowserService({
    userData,
    resources,
    store: new JsonZenXPluginCatalogStore(
      path.join(userData, "capability-grants.json"),
    ),
    environment,
    connectorBackend: initial.backend,
  });
  try {
    await first.initialize();
    await first.installBuiltInPlugin("browser");
    await first.uninstall("browser");
  } finally {
    await first.close();
  }

  environment.ZENX_BROWSER_MODE = "isolated";
  delete environment.ZENX_USER_BROWSER_CDP_ENDPOINT;
  const selected = trackedBrowserBackend("electron-selected");
  const restarted = selectorBrowserService({
    userData,
    resources,
    store: new JsonZenXPluginCatalogStore(
      path.join(userData, "capability-grants.json"),
    ),
    environment,
    connectorBackend: selected.backend,
    electronBrowserFactory: () => selected.backend,
  });
  try {
    await restarted.initialize();
    assert.equal(
      restarted.browserProfilePackage().manifest.provider.id,
      "electron-dedicated-browser",
    );
    await restarted.reinstall("browser");
    const browser = restarted
      .pluginSnapshot()
      .plugins.find((plugin) => plugin.id === "browser");
    assert.equal(browser?.lifecycle, "enabled");
    assert.equal(
      path.basename(browser?.profileSource?.packageSpec ?? ""),
      "zenx-browser-plugin-electron-1.0.0.tgz",
    );
    assert.equal(
      (
        (await call(restarted, "browser_list_tabs", {
          sessionId: "marketplace-reinstall",
        })) as [{ title: string }]
      )[0].title,
      "electron-selected",
    );
  } finally {
    await restarted.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("provider variant admission and Catalog failures retain the old backend and generation", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "zenx-provider-variant-rollback-"),
  );
  const userData = path.join(root, "user-data");
  const resources = path.join(root, "resources");
  await copyPreparedFirstPartyPlugins(resources);
  const oldBackend = trackedBrowserBackend("old");
  const environment: NodeJS.ProcessEnv = {
    PATH: "",
    ZENX_BROWSER_MODE: "user-session",
    ZENX_USER_BROWSER_CDP_ENDPOINT: "http://127.0.0.1:9222",
  };
  const store = new FailOnceConfigurationStore(
    new JsonZenXPluginCatalogStore(
      path.join(userData, "capability-grants.json"),
    ),
  );
  let service!: ZenXCapabilityService;
  service = new ZenXCapabilityService({
    userDataDirectory: userData,
    resourcesDirectory: resources,
    pnpmCliPath: pnpmCli,
    catalogStore: store,
    bundledProvidersOnly: true,
    computerBackend: computerBackend(),
    providerCatalogOptions: {
      environment,
      platform: "darwin",
      userBrowserConnector: async () => ({
        backend: oldBackend.backend,
        product: "Fixture/1.0",
      }),
    },
    trustedProfileLoaders: {
      browser: createDelegatingFirstPartyProfileLoader(() =>
        service.browserProfilePackage(),
      ),
      computer: createDelegatingFirstPartyProfileLoader(() =>
        service.computerProfilePackage(),
      ),
    },
  });
  const electronTarball = path.join(
    resources,
    "plugins",
    "zenx-browser-plugin-electron-1.0.0.tgz",
  );
  try {
    await service.initialize();
    await service.installBundledPluginPackage(
      path.join(
        resources,
        "plugins",
        "zenx-browser-plugin-user-session-1.0.0.tgz",
      ),
      { pluginId: "browser", packageName: "@zenx/browser-plugin" },
    );
    const committed = await committedGeneration(userData);
    environment.ZENX_BROWSER_MODE = "isolated";
    delete environment.ZENX_USER_BROWSER_CDP_ENDPOINT;

    await writeFile(electronTarball, "not an npm archive");
    await assert.rejects(service.resetTransient());
    await assertOldProvider(service, userData, committed, "user-browser-cdp");

    await copyPreparedFirstPartyPlugins(resources);
    store.failNextSave();
    await assert.rejects(
      service.resetTransient(),
      /fixture Catalog save failure/u,
    );
    await assertOldProvider(service, userData, committed, "user-browser-cdp");

    await service.resetTransient();
    assert.deepEqual(
      await call(service, "browser_list_tabs", { sessionId: "test" }),
      [],
    );
    assert.equal(
      service.browserProfilePackage().manifest.provider.id,
      "electron-dedicated-browser",
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(oldBackend.closed(), 1);
  } finally {
    await service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("restart keeps a committed Browser backend isolated from a different current selector", async (t) => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "zenx-browser-restart-variant-"),
  );
  const resources = path.join(root, "resources");
  await copyPreparedFirstPartyPlugins(resources);
  try {
    for (const direction of [
      {
        name: "user-session-to-electron",
        initialMode: "user-session",
        selectedMode: "isolated",
        initialTarball: "zenx-browser-plugin-user-session-1.0.0.tgz",
      },
      {
        name: "electron-to-user-session",
        initialMode: "isolated",
        selectedMode: "user-session",
        initialTarball: "zenx-browser-plugin-electron-1.0.0.tgz",
      },
    ] as const) {
      for (const outcome of [
        "success",
        "runtime-admission-failure",
        "catalog-failure",
      ] as const) {
        await t.test(`${direction.name}/${outcome}`, async () => {
          const userData = path.join(root, direction.name, outcome);
          const store = new FailOnceConfigurationStore(
            new JsonZenXPluginCatalogStore(
              path.join(userData, "capability-grants.json"),
            ),
          );
          const environment: NodeJS.ProcessEnv = {
            PATH: "",
            ZENX_BROWSER_MODE: direction.initialMode,
            ZENX_USER_BROWSER_CDP_ENDPOINT: "http://127.0.0.1:9222",
          };
          const seeded = trackedBrowserBackend("seeded");
          const first = selectorBrowserService({
            userData,
            resources,
            store,
            environment,
            connectorBackend: seeded.backend,
            electronBrowserFactory: () => seeded.backend,
          });
          try {
            await first.initialize();
            await first.installBundledPluginPackage(
              path.join(resources, "plugins", direction.initialTarball),
              { pluginId: "browser", packageName: "@zenx/browser-plugin" },
            );
          } finally {
            await first.close();
          }
          assert.equal(seeded.closed(), 1);

          environment.ZENX_BROWSER_MODE = direction.selectedMode;
          const committed = trackedBrowserBackend("committed-restart");
          const candidate = trackedBrowserBackend("selected-candidate");
          const restarted = selectorBrowserService({
            userData,
            resources,
            store,
            environment,
            connectorBackend:
              direction.selectedMode === "user-session"
                ? candidate.backend
                : committed.backend,
            electronBrowserFactory: () =>
              direction.selectedMode === "isolated"
                ? candidate.backend
                : committed.backend,
            failBrowserLoadAt:
              outcome === "runtime-admission-failure" ? 2 : undefined,
          });
          try {
            await restarted.initialize();
            assert.equal(
              (
                (await call(restarted, "browser_list_tabs", {
                  sessionId: "before-sync",
                })) as [{ title: string }]
              )[0].title,
              "committed-restart",
            );
            assert.equal(committed.closed(), 0);
            assert.equal(candidate.closed(), 0);
            const generation = await committedGeneration(userData);
            if (outcome !== "success") {
              if (outcome === "catalog-failure") store.failNextSave();
              await assert.rejects(
                restarted.syncProfileManagedProviderVariants(),
                outcome === "catalog-failure"
                  ? /fixture Catalog save failure/u
                  : /fixture Browser runtime admission failure/u,
              );
              assert.equal(await committedGeneration(userData), generation);
              assert.equal(
                (
                  (await call(restarted, "browser_list_tabs", {
                    sessionId: "after-failure",
                  })) as [{ title: string }]
                )[0].title,
                "committed-restart",
              );
              assert.equal(committed.closed(), 0);
              assert.equal(candidate.closed(), 1);
            } else {
              await restarted.syncProfileManagedProviderVariants();
              assert.notEqual(await committedGeneration(userData), generation);
              assert.equal(
                (
                  (await call(restarted, "browser_list_tabs", {
                    sessionId: "after-sync",
                  })) as [{ title: string }]
                )[0].title,
                "selected-candidate",
              );
              await new Promise((resolve) => setImmediate(resolve));
              assert.equal(committed.closed(), 1);
              assert.equal(candidate.closed(), 0);
            }
          } finally {
            await restarted.close();
          }
          assert.equal(committed.closed(), 1);
          assert.equal(candidate.closed(), 1);
        });
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("remaining first-party packages adopt every legacy Catalog lifecycle through the canonical installer", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "zenx-first-party-adopt-"));
  const resources = path.join(root, "resources");
  await copyPreparedFirstPartyPlugins(resources);
  try {
    for (const lifecycle of ["enabled", "installed", "uninstalled"] as const) {
      await t.test(lifecycle, async () => {
        const userData = path.join(root, lifecycle);
        await seedPreProfileFirstPartyCatalog(userData, lifecycle);

        const adopted = firstPartyService(userData, resources);
        try {
          await adopted.initialize();
          for (const definition of remainingDefinitions) {
            await adopted.installBundledPluginPackage(
              path.join(resources, "plugins", definition.tarball),
              {
                pluginId: definition.pluginId,
                packageName: definition.packageName,
              },
            );
          }
          for (const pluginId of remainingPluginIds) {
            const plugin = adopted
              .pluginSnapshot()
              .plugins.find((candidate) => candidate.id === pluginId);
            assert.equal(plugin?.lifecycle, lifecycle);
            assert.equal(plugin?.profileSource?.mode, "bundled");
            assert.equal(plugin?.available, lifecycle !== "uninstalled");
          }
          const catalog = JSON.parse(
            await readFile(
              path.join(userData, "capability-grants.json"),
              "utf8",
            ),
          ) as { profileGeneration?: string };
          assert.match(catalog.profileGeneration ?? "", /^[0-9a-f-]{36}$/u);
          if (lifecycle === "uninstalled") {
            for (const pluginId of remainingPluginIds) {
              await adopted.reinstall(pluginId);
            }
            assert.equal(
              adopted
                .pluginSnapshot()
                .plugins.every((plugin) => plugin.lifecycle === "enabled"),
              true,
            );
          }
        } finally {
          await adopted.close();
        }
      });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ordinary tarballs cannot claim any remaining first-party trusted runtime", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "zenx-first-party-untrusted-"),
  );
  const resources = path.join(root, "resources");
  await copyPreparedFirstPartyPlugins(resources);
  const service = new ZenXCapabilityService({
    userDataDirectory: path.join(root, "user-data"),
    pnpmCliPath: pnpmCli,
    bundledProvidersOnly: true,
  });
  try {
    await service.initialize();
    for (const definition of remainingDefinitions) {
      await assert.rejects(
        service.installPluginTarball(
          path.join(resources, "plugins", definition.tarball),
        ),
        /bundled runtime is not admitted by App Resources|UI must use the isolated host/u,
      );
    }
    assert.deepEqual(service.pluginSnapshot().plugins, []);
  } finally {
    await service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("profile-managed Computer remains absent on Linux and unavailable Windows providers", async (t) => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "zenx-computer-profile-gates-"),
  );
  const resources = path.join(root, "resources");
  await copyPreparedFirstPartyPlugins(resources);
  try {
    for (const platform of ["linux", "win32"] as const) {
      await t.test(platform, async () => {
        let service!: ZenXCapabilityService;
        service = new ZenXCapabilityService({
          userDataDirectory: path.join(root, platform),
          resourcesDirectory: resources,
          pnpmCliPath: pnpmCli,
          bundledProvidersOnly: true,
          providerCatalogOptions: { platform, environment: { PATH: "" } },
          trustedProfileLoaders: {
            computer: createDelegatingFirstPartyProfileLoader(() =>
              service.computerProfilePackage(),
            ),
          },
        });
        try {
          await service.initialize();
          assert.throws(
            () => service.computerProfilePackage(),
            /Computer provider is unavailable/u,
          );
          assert.equal(
            service
              .diagnostics()
              .providerDiagnostics.some(
                (diagnostic) =>
                  diagnostic.capabilityId === "computer" &&
                  diagnostic.status === "unavailable",
              ),
            true,
          );
          await assert.rejects(
            service.installBundledPluginPackage(
              path.join(
                resources,
                "plugins",
                platform === "win32"
                  ? "zenx-computer-plugin-win32-1.1.0.tgz"
                  : "zenx-computer-plugin-macos-1.0.0.tgz",
              ),
              { pluginId: "computer", packageName: "@zenx/computer-plugin" },
            ),
            /Computer provider is unavailable/u,
          );
          assert.equal(
            service
              .pluginSnapshot()
              .plugins.some((plugin) => plugin.id === "computer"),
            false,
          );
          assert.deepEqual(
            service.marketplaceBuiltIns().map((entry) => ({
              id: entry.pluginId,
              available: entry.available,
              reason: entry.unavailableReason,
            })),
            [
              { id: "browser", available: true, reason: undefined },
              {
                id: "computer",
                available: false,
                reason:
                  platform === "linux"
                    ? "No computer provider is available for this platform"
                    : "Packaged WinApp provider manifest trust anchor is missing",
              },
              { id: "zenx-rooms", available: true, reason: undefined },
              {
                id: "zenx-self-control",
                available: true,
                reason: undefined,
              },
              { id: "zenx-triggers", available: true, reason: undefined },
            ],
          );
        } finally {
          await service.close();
        }
      });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const remainingDefinitions = [
  FIRST_PARTY_PLUGIN_PACKAGES.browser,
  FIRST_PARTY_PLUGIN_PACKAGES.computer,
  FIRST_PARTY_PLUGIN_PACKAGES.selfControl,
  FIRST_PARTY_PLUGIN_PACKAGES.triggers,
] as const;
const remainingPluginIds = remainingDefinitions.map(
  (definition) => definition.pluginId,
);

test("CapabilityService close attempts browser and computer owners after one rejects", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "zenx-close-all-"));
  const closed: string[] = [];
  const service = new ZenXCapabilityService({
    userDataDirectory: root,
    bundledProvidersOnly: true,
    browserBackend: browserBackend(undefined, () => {
      closed.push("browser");
      throw new Error("browser close failed");
    }),
    computerBackend: computerBackend(() => closed.push("computer")),
    providerCatalogOptions: { platform: "darwin" },
  });
  try {
    await service.initialize();
    await assert.rejects(service.close(), /ZenX Capability shutdown failed/u);
    assert.deepEqual(closed.sort(), ["browser", "computer"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function firstPartyService(
  userDataDirectory: string,
  resourcesDirectory: string,
): ZenXCapabilityService {
  const self = new ZenXSelfControlCapabilityPackage({
    appServer: attachedSelfControlPort(),
  });
  const triggers = new ZenXTriggersCapabilityPackage(automationPort());
  let service!: ZenXCapabilityService;
  service = new ZenXCapabilityService({
    userDataDirectory,
    resourcesDirectory,
    pnpmCliPath: pnpmCli,
    bundledProvidersOnly: true,
    browserBackend: browserBackend(),
    computerBackend: computerBackend(),
    trustedProfileLoaders: {
      browser: createDelegatingFirstPartyProfileLoader(() =>
        service.browserProfilePackage(),
      ),
      computer: createDelegatingFirstPartyProfileLoader(() =>
        service.computerProfilePackage(),
      ),
      "zenx-self-control": createDelegatingFirstPartyProfileLoader(() => self),
      "zenx-triggers": createDelegatingFirstPartyProfileLoader(() => triggers),
    },
  });
  return service;
}

function selectorBrowserService(options: {
  userData: string;
  resources: string;
  store: ZenXPluginCatalogStore;
  environment: NodeJS.ProcessEnv;
  connectorBackend: ZenXBrowserBackend;
  electronBrowserFactory?: () => ZenXBrowserBackend;
  failBrowserLoadAt?: number;
}): ZenXCapabilityService {
  let service!: ZenXCapabilityService;
  let browserLoadCount = 0;
  const browserLoader = createDelegatingFirstPartyProfileLoader(() =>
    service.browserProfilePackage(),
  );
  service = new ZenXCapabilityService({
    userDataDirectory: options.userData,
    resourcesDirectory: options.resources,
    pnpmCliPath: pnpmCli,
    catalogStore: options.store,
    computerBackend: computerBackend(),
    providerCatalogOptions: {
      environment: options.environment,
      platform: "darwin",
      userBrowserConnector: async () => ({
        backend: options.connectorBackend,
        product: "Fixture/1.0",
      }),
      electronBrowserFactory: options.electronBrowserFactory,
    },
    trustedProfileLoaders: {
      browser: (module) => {
        browserLoadCount += 1;
        if (browserLoadCount === options.failBrowserLoadAt) {
          throw new Error("fixture Browser runtime admission failure");
        }
        return browserLoader(module);
      },
      computer: createDelegatingFirstPartyProfileLoader(() =>
        service.computerProfilePackage(),
      ),
    },
  });
  return service;
}

function attachedSelfControlPort(): MutableAppServerRequestPort {
  const port = new MutableAppServerRequestPort();
  void port.attach({ request: async () => ({ data: [] }) as never });
  return port;
}

async function seedPreProfileFirstPartyCatalog(
  userDataDirectory: string,
  lifecycle: "enabled" | "installed" | "uninstalled",
): Promise<void> {
  const manifestUrls = [
    "../../../packages/zenx-browser-plugin/zenx.plugin.json",
    "../../../packages/zenx-computer-plugin/zenx.plugin.json",
    "../../../packages/zenx-self-control-plugin/zenx.plugin.json",
    "../../../packages/zenx-triggers-plugin/zenx.plugin.json",
  ];
  const manifests = await Promise.all(
    manifestUrls.map(
      async (manifestUrl) =>
        JSON.parse(
          await readFile(
            fileURLToPath(new URL(manifestUrl, import.meta.url)),
            "utf8",
          ),
        ) as ZenXCapabilityPackage["manifest"],
    ),
  );
  const store = new JsonZenXPluginCatalogStore(
    path.join(userDataDirectory, "capability-grants.json"),
  );
  await store.save({
    disabled: lifecycle === "installed" ? [...remainingPluginIds] : [],
    uninstalled: lifecycle === "uninstalled" ? [...remainingPluginIds] : [],
    packages: Object.fromEntries(
      manifests.map((manifest) => [
        manifest.id,
        { manifest, source: "bundled" as const },
      ]),
    ),
  });
}

async function browserCandidate(
  manifestUrl: string,
  backend: ZenXBrowserBackend,
): Promise<ZenXCapabilityPackage> {
  const manifest = JSON.parse(
    await readFile(
      fileURLToPath(new URL(manifestUrl, import.meta.url)),
      "utf8",
    ),
  ) as ZenXCapabilityPackage["manifest"];
  return new BrowserZenXCapabilityPackage(backend, manifest);
}

function trackedBrowserBackend(title: string): {
  backend: ZenXBrowserBackend;
  closed(): number;
} {
  let closeCount = 0;
  return {
    backend: browserBackend(title, () => {
      closeCount += 1;
    }),
    closed: () => closeCount,
  };
}

async function assertOldProvider(
  service: ZenXCapabilityService,
  userData: string,
  generation: string,
  providerId = "electron-dedicated-browser",
): Promise<void> {
  assert.equal(await committedGeneration(userData), generation);
  assert.equal(
    service.browserProfilePackage().manifest.provider.id,
    providerId,
  );
  assert.equal(
    (
      (await call(service, "browser_list_tabs", { sessionId: "test" })) as [
        { title: string },
      ]
    )[0].title,
    "old",
  );
}

async function committedGeneration(userData: string): Promise<string> {
  const catalog = JSON.parse(
    await readFile(path.join(userData, "capability-grants.json"), "utf8"),
  ) as { profileGeneration?: string };
  assert.match(catalog.profileGeneration ?? "", /^[0-9a-f-]{36}$/u);
  return catalog.profileGeneration!;
}

class FailOnceConfigurationStore implements ZenXPluginCatalogStore {
  readonly #delegate: ZenXPluginCatalogStore;
  #fail = false;

  constructor(delegate: ZenXPluginCatalogStore) {
    this.#delegate = delegate;
  }

  failNextSave(): void {
    this.#fail = true;
  }

  async load(): Promise<ZenXPluginCatalogState> {
    return await this.#delegate.load();
  }

  async save(configuration: ZenXPluginCatalogState): Promise<void> {
    if (this.#fail) {
      this.#fail = false;
      throw new Error("fixture Catalog save failure");
    }
    await this.#delegate.save(configuration);
  }
}

async function call(
  service: ZenXCapabilityService,
  name: string,
  arguments_: Record<string, unknown>,
) {
  const result = await service.execute({
    callId: `call-${name}`,
    name,
    arguments: arguments_,
    cwd: process.cwd(),
    signal: new AbortController().signal,
  });
  return JSON.parse(result.output) as unknown;
}

function browserBackend(
  title?: string,
  onClose: () => void = () => undefined,
): ZenXBrowserBackend {
  return {
    listTabs: async (sessionId) =>
      title === undefined
        ? []
        : [
            {
              sessionId,
              tabId: "fixture-tab",
              title,
              url: "https://example.test/",
              loading: false,
            },
          ],
    open: async () => {
      throw new Error("unused");
    },
    navigate: async () => {
      throw new Error("unused");
    },
    inspect: async () => {
      throw new Error("unused");
    },
    click: async () => {
      throw new Error("unused");
    },
    type: async () => {
      throw new Error("unused");
    },
    closeTab: () => undefined,
    closeSession: () => 0,
    close: onClose,
  };
}

function computerBackend(
  onClose: () => void = () => undefined,
): ZenXComputerBackend {
  const target = { pid: 1, applicationName: "Fixture", windowTitle: "Fixture" };
  return {
    inspect: async () => ({
      platform: "darwin",
      observationId: "computer-observation",
      target,
      controls: [],
      truncated: false,
    }),
    press: async (_target, control) => ({ target, control }),
    setValue: async (_target, control, value) => ({
      target,
      control,
      characterCount: value.length,
    }),
    screenshot: async () => ({
      artifactPath: "/tmp/fixture.png",
      target,
      width: 1,
      height: 1,
      bytes: 1,
      expiresAt: new Date(0).toISOString(),
    }),
    foregroundClick: async () => undefined,
    foregroundKeyPress: async () => undefined,
    foregroundScroll: async () => undefined,
    close: onClose,
  };
}

function automationPort(): ZenXAutomationControlPort {
  const unsupported = async () => {
    throw new Error("unused");
  };
  return {
    snapshot: () => ({ triggers: [], history: [], rooms: [] }),
    create: unsupported,
    update: unsupported,
    cancel: unsupported,
    delete: unsupported,
    signal: unsupported,
    createRoom: unsupported,
    renameRoom: unsupported,
    deleteRoom: unsupported,
    addRoomMember: unsupported,
    removeRoomMember: unsupported,
    postAgentRoomMessage: unsupported,
  } as ZenXAutomationControlPort;
}
