import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { packZenXFirstPartyPlugins } from "../scripts/pack-first-party-plugins.mjs";
import { ZenXCapabilityService } from "../src/main/capability-service.js";
import { ZenXTriggersCapabilityPackage } from "../src/main/capabilities/automation-control-package.js";
import type { ZenXAutomationControlPort } from "../src/main/capabilities/automation-control-package.js";
import {
  BrowserZenXCapabilityPackage,
  type ZenXBrowserBackend,
} from "../src/main/capabilities/browser-provider.js";
import type { ZenXComputerBackend } from "../src/main/capabilities/computer-provider.js";
import { JsonZenXCapabilityGrantStore } from "../src/main/capabilities/grant-store.js";
import type {
  ZenXCapabilityConfiguration,
  ZenXCapabilityConfigurationStore,
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

test("remaining first-party tarballs install, invoke, cycle lifecycle, and restart offline", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "zenx-first-party-profile-"),
  );
  const userData = path.join(root, "user-data");
  const resources = path.join(root, "resources");
  await packZenXFirstPartyPlugins({ outputDirectory: resources });
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
      localDirectory: path.join(root, "no-local"),
      bundledProvidersOnly: true,
      browserBackend: browserBackend(),
      computerBackend: computerBackend(),
      profileManagedProviders: true,
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
      await service.installBundledPluginPackage(
        path.join(resources, "plugins", definition.tarball),
        {
          pluginId: definition.pluginId,
          packageName: definition.packageName,
        },
      );
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
      service
        .snapshot()
        .capabilities.find((entry) => entry.manifest.id === "browser")?.manifest
        .provider.id,
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
      service.snapshot().discoveryErrors.join("\n"),
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

test("provider variant admission and Catalog failures retain the old backend and generation", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "zenx-provider-variant-rollback-"),
  );
  const userData = path.join(root, "user-data");
  const resources = path.join(root, "resources");
  await packZenXFirstPartyPlugins({ outputDirectory: resources });
  const oldBackend = trackedBrowserBackend("old");
  const environment: NodeJS.ProcessEnv = {
    PATH: "",
    ZENX_BROWSER_MODE: "user-session",
    ZENX_USER_BROWSER_CDP_ENDPOINT: "http://127.0.0.1:9222",
  };
  const store = new FailOnceConfigurationStore(
    new JsonZenXCapabilityGrantStore(
      path.join(userData, "capability-grants.json"),
    ),
  );
  let service!: ZenXCapabilityService;
  service = new ZenXCapabilityService({
    userDataDirectory: userData,
    resourcesDirectory: resources,
    pnpmCliPath: pnpmCli,
    grantStore: store,
    localDirectory: path.join(root, "no-local"),
    bundledProvidersOnly: true,
    computerBackend: computerBackend(),
    profileManagedProviders: true,
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

    await packZenXFirstPartyPlugins({ outputDirectory: resources });
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
      service
        .snapshot()
        .capabilities.find((entry) => entry.manifest.id === "browser")?.manifest
        .provider.id,
      "electron-dedicated-browser",
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(oldBackend.closed(), 1);
  } finally {
    await service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("remaining first-party packages adopt every legacy Catalog lifecycle through the canonical installer", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "zenx-first-party-adopt-"));
  const resources = path.join(root, "resources");
  await packZenXFirstPartyPlugins({ outputDirectory: resources });
  try {
    for (const lifecycle of ["enabled", "installed", "uninstalled"] as const) {
      await t.test(lifecycle, async () => {
        const userData = path.join(root, lifecycle);
        const legacy = firstPartyService(userData, resources);
        try {
          await legacy.initialize();
          for (const capabilityPackage of [
            await legacyV2Package(
              legacy.browserProfilePackage(),
              "../../../packages/zenx-browser-plugin/zenx.plugin.json",
            ),
            await legacyV2Package(
              legacy.computerProfilePackage(),
              "../../../packages/zenx-computer-plugin/zenx.plugin.json",
            ),
            await legacyV2Package(
              new ZenXSelfControlCapabilityPackage({
                appServer: attachedSelfControlPort(),
              }),
              "../../../packages/zenx-self-control-plugin/zenx.plugin.json",
            ),
            await legacyV2Package(
              new ZenXTriggersCapabilityPackage(automationPort()),
              "../../../packages/zenx-triggers-plugin/zenx.plugin.json",
            ),
          ]) {
            await legacy.install(capabilityPackage, "bundled");
          }
          for (const pluginId of remainingPluginIds) {
            if (lifecycle === "installed") {
              await legacy.setEnabled(pluginId, false);
            } else if (lifecycle === "uninstalled") {
              await legacy.uninstall(pluginId);
            }
          }
        } finally {
          await legacy.close();
        }

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
  await packZenXFirstPartyPlugins({ outputDirectory: resources });
  const service = new ZenXCapabilityService({
    userDataDirectory: path.join(root, "user-data"),
    pnpmCliPath: pnpmCli,
    localDirectory: path.join(root, "no-local"),
    bundledProvidersOnly: true,
    profileManagedProviders: true,
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
  await packZenXFirstPartyPlugins({ outputDirectory: resources });
  try {
    for (const platform of ["linux", "win32"] as const) {
      await t.test(platform, async () => {
        let service!: ZenXCapabilityService;
        service = new ZenXCapabilityService({
          userDataDirectory: path.join(root, platform),
          resourcesDirectory: resources,
          pnpmCliPath: pnpmCli,
          localDirectory: path.join(root, platform, "no-local"),
          bundledProvidersOnly: true,
          profileManagedProviders: true,
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
              .snapshot()
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
    localDirectory: path.join(userDataDirectory, "no-local"),
    bundledProvidersOnly: true,
    browserBackend: browserBackend(),
    computerBackend: computerBackend(),
    profileManagedProviders: true,
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

function attachedSelfControlPort(): MutableAppServerRequestPort {
  const port = new MutableAppServerRequestPort();
  void port.attach({ request: async () => ({ data: [] }) as never });
  return port;
}

async function legacyV2Package(
  capabilityPackage: ZenXCapabilityPackage,
  manifestUrl: string,
): Promise<ZenXCapabilityPackage> {
  const manifest = JSON.parse(
    await readFile(
      fileURLToPath(new URL(manifestUrl, import.meta.url)),
      "utf8",
    ),
  ) as ZenXCapabilityPackage["manifest"];
  return {
    manifest,
    storage: capabilityPackage.storage,
    start: async (sdk) => await capabilityPackage.start?.(sdk),
    invoke: async (name, invocation, sdk) =>
      await capabilityPackage.invoke(name, invocation, sdk),
    close: async () => await capabilityPackage.close?.(),
  };
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
    service
      .snapshot()
      .capabilities.find((entry) => entry.manifest.id === "browser")?.manifest
      .provider.id,
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

class FailOnceConfigurationStore implements ZenXCapabilityConfigurationStore {
  readonly #delegate: ZenXCapabilityConfigurationStore;
  #fail = false;

  constructor(delegate: ZenXCapabilityConfigurationStore) {
    this.#delegate = delegate;
  }

  failNextSave(): void {
    this.#fail = true;
  }

  async load(): Promise<ZenXCapabilityConfiguration> {
    return await this.#delegate.load();
  }

  async save(configuration: ZenXCapabilityConfiguration): Promise<void> {
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

function computerBackend(): ZenXComputerBackend {
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
    close: () => undefined,
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
