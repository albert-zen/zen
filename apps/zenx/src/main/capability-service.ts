import path from "node:path";
import {
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";

import { ToolEnvironment, type ToolInvocation } from "../../../../src/tool.js";
import {
  BrowserZenXCapabilityPackage,
  type ZenXBrowserBackend,
} from "./capabilities/browser-provider.js";
import {
  ComputerZenXCapabilityPackage,
  type ZenXComputerBackend,
} from "./capabilities/computer-provider.js";
import { JsonZenXCapabilityGrantStore } from "./capabilities/grant-store.js";
import {
  discoverLocalCapabilityPackages,
  loadLocalCapabilityPackage,
} from "./capabilities/local-package.js";
import { ZenXCapabilityRegistry } from "./capabilities/registry.js";
import {
  selectBrowserProvider,
  selectComputerProvider,
} from "./capabilities/provider-catalog.js";
import { WinAppCliComputerBackend } from "./capabilities/windows-computer-provider.js";
import {
  bundledPackageRegistration,
  CatalogPluginRuntimeLifecycle,
  PluginRuntimeSupervisor,
} from "./plugin-runtime.js";
import type {
  ZenXCapabilityDisposer,
  ZenXCapabilityGrantStore,
  ZenXCapabilityHost,
  ZenXCapabilityHostSnapshot,
  ZenXCapabilityPackage,
  ZenXCapabilitySnapshot,
  ZenXCapabilityManifest,
  ZenXPluginSnapshot,
  ZenXPluginPackageSource,
} from "./capabilities/types.js";
import type { PluginHostUiPort } from "./plugin-host-sdk.js";
import { createZenXPluginHostSdk } from "./plugin-host-sdk.js";
import {
  cleanupUnreferencedProfileGenerations,
  discardStagedProfileGeneration,
  loadProfilePluginPackage,
  pluginProfilePaths,
  resolveBundledPnpmCli,
  stagePluginPackage,
  stagePluginRemoval,
  type ZenXTrustedProfilePluginLoader,
} from "./plugin-profile.js";

export class ZenXCapabilityService implements ZenXCapabilityHost {
  readonly #registry: ZenXCapabilityRegistry;
  readonly #pluginToolEnvironment: ToolEnvironment;
  readonly #pluginRuntimeSupervisor: PluginRuntimeSupervisor;
  readonly #userDataDirectory: string;
  readonly #localDirectory: string;
  readonly #browserBackend?: ZenXBrowserBackend;
  readonly #computerBackend?: ZenXComputerBackend;
  readonly #computerManifest?: ZenXCapabilityManifest;
  readonly #bundledProvidersOnly: boolean;
  readonly #resourcesDirectory?: string;
  readonly #bundledManifestSha256?: string;
  readonly #pnpmCliPath?: string;
  readonly #pnpmEnvironment?: NodeJS.ProcessEnv;
  readonly #removeProfileGeneration?: (directory: string) => Promise<void>;
  readonly #trustedProfileLoaders: Readonly<
    Record<string, ZenXTrustedProfilePluginLoader>
  >;
  #serviceMutationTail: Promise<void> = Promise.resolve();
  #browserRegistration: ZenXCapabilityDisposer | undefined;
  #computerRegistered = false;

  constructor(options: {
    userDataDirectory: string;
    grantStore?: ZenXCapabilityGrantStore;
    localDirectory?: string;
    browserBackend?: ZenXBrowserBackend;
    computerBackend?: ZenXComputerBackend;
    computerManifest?: ZenXCapabilityManifest;
    bundledProvidersOnly?: boolean;
    resourcesDirectory?: string;
    bundledManifestSha256?: string;
    pnpmCliPath?: string;
    pnpmEnvironment?: NodeJS.ProcessEnv;
    removeProfileGeneration?: (directory: string) => Promise<void>;
    trustedProfileLoaders?: Readonly<
      Record<string, ZenXTrustedProfilePluginLoader>
    >;
  }) {
    this.#pluginToolEnvironment = new ToolEnvironment();
    this.#pluginRuntimeSupervisor = new PluginRuntimeSupervisor(
      this.#pluginToolEnvironment,
    );
    this.#registry = new ZenXCapabilityRegistry(
      options.grantStore ??
        new JsonZenXCapabilityGrantStore(
          path.join(options.userDataDirectory, "capability-grants.json"),
        ),
      {
        pluginDataDirectory: path.join(
          options.userDataDirectory,
          "plugin-data",
        ),
        pluginRuntimeLifecycle: new CatalogPluginRuntimeLifecycle({
          supervisor: this.#pluginRuntimeSupervisor,
          registrationFor: bundledPackageRegistration,
          hostSdkFor: async (registration) => {
            const manifest = registration.package.manifest;
            if (manifest.schemaVersion !== 2)
              throw new Error("Plugin Host SDK requires manifest v2");
            const storage = registration.package.storage;
            const storageFile = path.join(
              options.userDataDirectory,
              "plugin-data",
              manifest.id,
              "storage.json",
            );
            let previousStorage: Buffer | undefined;
            try {
              previousStorage = await readFile(storageFile);
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT")
                throw error;
            }
            const sdk = await createZenXPluginHostSdk({
              pluginId: manifest.id,
              storageRoot: path.join(options.userDataDirectory, "plugin-data"),
              storageVersion: storage?.version ?? manifest.storageVersion ?? 1,
              migrations: storage?.migrations,
              initialStorage: storage?.initialValue,
              queryProjects: async () => [],
              appServer: {
                startTurn: async () => {
                  throw new Error("Plugin AppServer actions are not attached");
                },
                readThread: async () => {
                  throw new Error("Plugin AppServer actions are not attached");
                },
              },
            });
            return {
              sdk,
              rollback: async () => {
                if (previousStorage === undefined) {
                  await rm(storageFile, { force: true });
                  return;
                }
                await mkdir(path.dirname(storageFile), {
                  recursive: true,
                  mode: 0o700,
                });
                const temporary = `${storageFile}.${String(process.pid)}.rollback`;
                await writeFile(temporary, previousStorage, { mode: 0o600 });
                await rename(temporary, storageFile);
              },
            };
          },
        }),
      },
    );
    this.#userDataDirectory = options.userDataDirectory;
    this.#localDirectory =
      options.localDirectory ??
      path.join(options.userDataDirectory, "capabilities");
    this.#browserBackend = options.browserBackend;
    this.#computerBackend = options.computerBackend;
    this.#computerManifest = options.computerManifest;
    this.#bundledProvidersOnly = options.bundledProvidersOnly ?? false;
    this.#resourcesDirectory = options.resourcesDirectory;
    this.#bundledManifestSha256 = options.bundledManifestSha256;
    this.#pnpmCliPath = options.pnpmCliPath;
    this.#pnpmEnvironment = options.pnpmEnvironment;
    this.#removeProfileGeneration = options.removeProfileGeneration;
    this.#trustedProfileLoaders = Object.freeze({
      ...(options.trustedProfileLoaders ?? {}),
    });
  }

  async initialize(): Promise<void> {
    await this.#registry.initialize();
    await this.#loadCommittedProfile();
    await this.#mountBrowser();
    await this.#mountComputer();
    const configuredManifestPaths = new Set<string>();
    for (const descriptor of Object.values(
      this.#registry.packageDescriptors(),
    )) {
      if (
        descriptor.source !== "local" ||
        descriptor.manifestPath === undefined
      )
        continue;
      configuredManifestPaths.add(descriptor.manifestPath);
      try {
        await this.#registry.install(
          await loadLocalCapabilityPackage(descriptor.manifestPath),
          "local",
        );
      } catch (error) {
        this.#registry.recordDiscoveryError(
          `${descriptor.manifest.id}: ${describeError(error)}`,
        );
      }
    }
    const discovered = await discoverLocalCapabilityPackages(
      this.#localDirectory,
    );
    for (const capabilityPackage of discovered.packages) {
      if (
        capabilityPackage.manifestPath !== undefined &&
        configuredManifestPaths.has(capabilityPackage.manifestPath)
      )
        continue;
      try {
        if (capabilityPackage.manifest.schemaVersion === 2) {
          await this.#registry.install(capabilityPackage, "local");
        } else {
          this.#registry.register(capabilityPackage, "local");
        }
      } catch (error) {
        this.#registry.recordDiscoveryError(describeError(error));
      }
    }
    for (const error of discovered.errors) {
      this.#registry.recordDiscoveryError(error);
    }
  }

  async #loadCommittedProfile(): Promise<void> {
    const generation = this.#registry.profileGeneration();
    if (generation === undefined) {
      await this.#cleanupProfileGenerations();
      return;
    }
    const generationDirectory = path.join(
      pluginProfilePaths(this.#userDataDirectory).generations,
      generation,
    );
    const lifecycle = new Map(
      this.#registry
        .pluginSnapshot()
        .plugins.map((plugin) => [plugin.id, plugin.lifecycle] as const),
    );
    for (const descriptor of Object.values(
      this.#registry.packageDescriptors(),
    )) {
      if (descriptor.profilePackageName === undefined) continue;
      if (lifecycle.get(descriptor.manifest.id) === "uninstalled") continue;
      try {
        const capabilityPackage = await loadProfilePluginPackage(
          generationDirectory,
          descriptor.profilePackageName,
          {
            allowExternalLink: descriptor.profileSource?.mode === "dev-link",
            sourceMode: descriptor.profileSource?.mode,
            trustedLoaders: this.#trustedProfileLoaders,
          },
        );
        if (
          JSON.stringify(capabilityPackage.manifest) !==
          JSON.stringify(descriptor.manifest)
        ) {
          throw new Error(
            `Committed profile package ${descriptor.profilePackageName} does not match its Catalog descriptor`,
          );
        }
        await this.#registry.install(capabilityPackage, descriptor.source);
      } catch (error) {
        this.#registry.recordDiscoveryError(
          `${descriptor.manifest.id}: ${describeError(error)}`,
        );
      }
    }
    await this.#cleanupProfileGenerations(generation);
  }

  async #cleanupProfileGenerations(
    committedGeneration?: string,
  ): Promise<void> {
    try {
      await cleanupUnreferencedProfileGenerations({
        userDataDirectory: this.#userDataDirectory,
        committedGeneration,
        removeGeneration: this.#removeProfileGeneration,
      });
    } catch {
      // Cleanup cannot affect the Catalog-selected generation.
    }
  }

  async #mountBrowser(): Promise<void> {
    if (this.#browserRegistration !== undefined) {
      throw new Error("Browser capability is already mounted");
    }
    const browser =
      this.#browserBackend === undefined
        ? await selectBrowserProvider({
            userDataDirectory: this.#userDataDirectory,
            bundledProvidersOnly: this.#bundledProvidersOnly,
            resourcesDirectory: this.#resourcesDirectory,
            bundledManifestSha256: this.#bundledManifestSha256,
          })
        : {
            backend: this.#browserBackend,
            manifest: undefined,
            diagnostics: [],
          };
    if (browser.backend !== undefined) {
      this.#browserRegistration = this.#registry.register(
        new BrowserZenXCapabilityPackage(browser.backend, browser.manifest),
        "bundled",
      );
    }
    for (const diagnostic of browser.diagnostics) {
      this.#registry.recordProviderDiagnostic(diagnostic);
    }
    if (browser.backend === undefined) {
      this.#registry.recordDiscoveryError(
        `Browser provider: ${browser.diagnostics[0]?.reason ?? "unavailable"}`,
      );
    }
  }

  async #unmountBrowser(): Promise<void> {
    const dispose = this.#browserRegistration;
    this.#browserRegistration = undefined;
    await dispose?.();
  }

  async #resetBrowser(): Promise<void> {
    if (this.#browserBackend !== undefined) return;
    await this.#unmountBrowser();
    await this.#mountBrowser();
  }

  async #mountComputer(): Promise<void> {
    const computer =
      this.#computerBackend === undefined
        ? await selectComputerProvider({
            userDataDirectory: this.#userDataDirectory,
            bundledProvidersOnly: this.#bundledProvidersOnly,
            resourcesDirectory: this.#resourcesDirectory,
            bundledManifestSha256: this.#bundledManifestSha256,
          })
        : {
            backend: this.#computerBackend,
            manifest: this.#computerManifest,
            diagnostics: [],
          };
    let registerComputer = computer.backend !== undefined;
    if (
      this.#computerBackend !== undefined &&
      computer.backend instanceof WinAppCliComputerBackend
    ) {
      const diagnostic = await computer.backend.diagnose();
      if (!diagnostic.ready) {
        registerComputer = false;
        this.#registry.recordDiscoveryError(
          `Windows computer provider: ${diagnostic.message}`,
        );
      }
    }
    if (registerComputer && computer.backend !== undefined) {
      this.#registry.register(
        new ComputerZenXCapabilityPackage(computer.backend, computer.manifest),
        "bundled",
      );
      this.#computerRegistered = true;
    }
    for (const diagnostic of computer.diagnostics) {
      this.#registry.recordProviderDiagnostic(diagnostic);
      if (
        diagnostic.providerId === "microsoft-winapp-cli" &&
        diagnostic.status === "unavailable"
      ) {
        this.#registry.recordDiscoveryError(
          `Windows computer provider: ${diagnostic.reason ?? "unavailable"}`,
        );
      }
    }
  }

  snapshot(): ZenXCapabilitySnapshot {
    return this.#registry.snapshot();
  }

  pluginSnapshot(): ZenXPluginSnapshot {
    return this.#registry.pluginSnapshot();
  }

  register(
    capabilityPackage: ZenXCapabilityPackage,
    source: "bundled" | "local" = "bundled",
  ): ZenXCapabilityDisposer {
    return this.#registry.register(capabilityPackage, source);
  }

  async install(
    capabilityPackage: ZenXCapabilityPackage,
    source: "bundled" | "local" = "local",
  ): Promise<ZenXPluginSnapshot> {
    return await this.#serializeServiceMutation(async () => {
      await this.#registry.install(capabilityPackage, source);
      return this.pluginSnapshot();
    });
  }

  async update(
    capabilityPackage: ZenXCapabilityPackage,
    source: "bundled" | "local" = "local",
  ): Promise<ZenXPluginSnapshot> {
    return await this.#serializeServiceMutation(async () => {
      await this.#registry.update(capabilityPackage, source);
      return this.pluginSnapshot();
    });
  }

  async installLocalPackage(
    manifestPath: string,
    expectedPluginId?: string,
  ): Promise<ZenXPluginSnapshot> {
    return await this.#serializeServiceMutation(async () => {
      const capabilityPackage = await loadLocalCapabilityPackage(manifestPath);
      const pluginId = capabilityPackage.manifest.id;
      if (expectedPluginId !== undefined && pluginId !== expectedPluginId) {
        throw new Error(
          `Selected package is ${pluginId}; choose an update for ${expectedPluginId}`,
        );
      }
      const current = this.pluginSnapshot().plugins.find(
        (plugin) => plugin.id === pluginId,
      );
      if (current === undefined) {
        await this.#registry.install(capabilityPackage, "local");
      } else if (current.source !== "local") {
        throw new Error(
          `Bundled plugin ${pluginId} cannot be replaced by a local package`,
        );
      } else if (current.version !== capabilityPackage.manifest.version) {
        await this.#registry.update(capabilityPackage, "local");
        if (current.lifecycle === "uninstalled")
          await this.#registry.reinstall(pluginId);
      } else if (current.lifecycle === "uninstalled" || !current.available) {
        await this.#registry.install(capabilityPackage, "local");
        if (current.lifecycle === "uninstalled")
          await this.#registry.reinstall(pluginId);
      } else {
        throw new Error(
          `Plugin ${pluginId} is already version ${current.version}`,
        );
      }
      return this.pluginSnapshot();
    });
  }

  async installPluginTarball(tarballPath: string): Promise<ZenXPluginSnapshot> {
    return await this.installPluginPackage({
      mode: "tarball",
      packageSpec: tarballPath,
    });
  }

  async installPluginPackage(
    source: ZenXPluginPackageSource,
    expectedPluginId?: string,
  ): Promise<ZenXPluginSnapshot> {
    if (source.mode === "bundled") {
      throw new Error("Bundled plugin sources are owned by App Resources");
    }
    return await this.#serializeServiceMutation(
      async () => await this.#mutatePluginPackage(source, expectedPluginId),
    );
  }

  async installBundledPluginPackage(
    tarballPath: string,
    expected: { pluginId: string; packageName: string },
  ): Promise<ZenXPluginSnapshot> {
    const source = await this.#trustedBundledSource(tarballPath);
    return await this.#serializeServiceMutation(
      async () =>
        await this.#mutatePluginPackage(
          source,
          expected.pluginId,
          expected.packageName,
        ),
    );
  }

  async #mutatePluginPackage(
    source: ZenXPluginPackageSource,
    expectedPluginId?: string,
    expectedPackageName?: string,
  ): Promise<ZenXPluginSnapshot> {
    const pnpmCliPath = await resolveBundledPnpmCli({
      resourcesDirectory: this.#resourcesDirectory,
      overridePath: this.#pnpmCliPath,
    });
    const expectedDescriptor =
      expectedPluginId === undefined
        ? undefined
        : this.#registry.packageDescriptors()[expectedPluginId];
    const staged = await stagePluginPackage({
      userDataDirectory: this.#userDataDirectory,
      source,
      pnpmCliPath,
      pnpmEnvironment: this.#pnpmEnvironment,
      currentGeneration: this.#registry.profileGeneration(),
      expectedPackageName: expectedDescriptor?.profilePackageName,
      removeGeneration: this.#removeProfileGeneration,
      trustedLoaders: this.#trustedProfileLoaders,
    });
    try {
      const pluginId = staged.capabilityPackage.manifest.id;
      if (expectedPluginId !== undefined && pluginId !== expectedPluginId) {
        throw new Error(
          `Resolved package is ${pluginId}; expected ${expectedPluginId}`,
        );
      }
      if (
        expectedPackageName !== undefined &&
        staged.packageName !== expectedPackageName
      ) {
        throw new Error(
          `Resolved package is ${staged.packageName}; expected ${expectedPackageName}`,
        );
      }
      const current = this.pluginSnapshot().plugins.find(
        (plugin) => plugin.id === pluginId,
      );
      const profile = {
        generation: staged.generation,
        packageName: staged.packageName,
        source: staged.source,
      };
      const catalogSource = source.mode === "bundled" ? "bundled" : "local";
      if (current === undefined) {
        await this.#registry.install(
          staged.capabilityPackage,
          catalogSource,
          profile,
        );
      } else {
        if (current.lifecycle === "uninstalled") {
          throw new Error(
            `Plugin ${pluginId} is uninstalled; use reinstall instead`,
          );
        }
        await this.#registry.update(
          staged.capabilityPackage,
          catalogSource,
          profile,
        );
      }
    } catch (error) {
      await discardStagedProfileGeneration(
        staged.generationDirectory,
        this.#removeProfileGeneration,
      );
      throw error;
    }
    return this.pluginSnapshot();
  }

  async updatePluginPackage(
    pluginId: string,
    source?: ZenXPluginPackageSource,
  ): Promise<ZenXPluginSnapshot> {
    if (source?.mode === "bundled") {
      throw new Error(
        "Bundled plugin updates use their committed App Resource source",
      );
    }
    return await this.#serializeServiceMutation(async () => {
      const descriptor = this.#registry.packageDescriptors()[pluginId];
      const stored = descriptor?.profileSource;
      if (stored === undefined && source === undefined) {
        throw new Error(`Plugin ${pluginId} has no reusable profile source`);
      }
      const selected = source ?? {
        mode: stored!.mode,
        packageSpec: stored!.packageSpec,
      };
      return await this.#mutatePluginPackage(
        selected.mode === "bundled"
          ? await this.#trustedBundledSource(selected.packageSpec)
          : selected,
        pluginId,
      );
    });
  }

  async uninstall(pluginId: string): Promise<ZenXPluginSnapshot> {
    return await this.#serializeServiceMutation(async () => {
      const descriptor = this.#registry.packageDescriptors()[pluginId];
      if (
        descriptor?.profilePackageName === undefined ||
        this.pluginSnapshot().plugins.find((plugin) => plugin.id === pluginId)
          ?.lifecycle === "uninstalled"
      ) {
        await this.#registry.uninstall(pluginId);
        return this.pluginSnapshot();
      }
      const generation = this.#registry.profileGeneration();
      if (generation === undefined) {
        throw new Error(
          `Plugin ${pluginId} has no committed profile generation`,
        );
      }
      const pnpmCliPath = await this.#resolvePnpm();
      const staged = await stagePluginRemoval({
        userDataDirectory: this.#userDataDirectory,
        packageName: descriptor.profilePackageName,
        pnpmCliPath,
        pnpmEnvironment: this.#pnpmEnvironment,
        currentGeneration: generation,
        removeGeneration: this.#removeProfileGeneration,
      });
      try {
        await this.#registry.uninstall(pluginId, staged.generation);
      } catch (error) {
        await discardStagedProfileGeneration(
          staged.generationDirectory,
          this.#removeProfileGeneration,
        );
        throw error;
      }
      return this.pluginSnapshot();
    });
  }

  async reinstall(pluginId: string): Promise<ZenXPluginSnapshot> {
    return await this.#serializeServiceMutation(async () => {
      const descriptor = this.#registry.packageDescriptors()[pluginId];
      if (descriptor?.profileSource === undefined) {
        await this.#registry.reinstall(pluginId);
        return this.pluginSnapshot();
      }
      const storedSource: ZenXPluginPackageSource = {
        mode: descriptor.profileSource.mode,
        packageSpec: descriptor.profileSource.packageSpec,
      };
      const source =
        storedSource.mode === "bundled"
          ? await this.#trustedBundledSource(storedSource.packageSpec)
          : storedSource;
      const staged = await stagePluginPackage({
        userDataDirectory: this.#userDataDirectory,
        source,
        pnpmCliPath: await this.#resolvePnpm(),
        pnpmEnvironment: this.#pnpmEnvironment,
        currentGeneration: this.#registry.profileGeneration(),
        expectedPackageName: descriptor.profilePackageName,
        removeGeneration: this.#removeProfileGeneration,
        trustedLoaders: this.#trustedProfileLoaders,
      });
      try {
        if (staged.capabilityPackage.manifest.id !== pluginId) {
          throw new Error(
            `Resolved package is ${staged.capabilityPackage.manifest.id}; expected ${pluginId}`,
          );
        }
        await this.#registry.reinstallProfile(staged.capabilityPackage, {
          generation: staged.generation,
          packageName: staged.packageName,
          source: staged.source,
        });
      } catch (error) {
        await discardStagedProfileGeneration(
          staged.generationDirectory,
          this.#removeProfileGeneration,
        );
        throw error;
      }
      return this.pluginSnapshot();
    });
  }

  async #trustedBundledSource(
    packageSpec: string,
  ): Promise<ZenXPluginPackageSource> {
    if (this.#resourcesDirectory === undefined) {
      throw new Error("Bundled plugin App Resources are not configured");
    }
    const pluginResources = await realpath(
      path.join(this.#resourcesDirectory, "plugins"),
    );
    const trustedPackage = await realpath(packageSpec);
    if (!trustedPackage.startsWith(`${pluginResources}${path.sep}`)) {
      throw new Error("Bundled plugin source must be an App Resource package");
    }
    return { mode: "bundled", packageSpec: trustedPackage };
  }

  async deletePluginData(pluginId: string): Promise<void> {
    await this.#serializeServiceMutation(
      async () => await this.#registry.deleteData(pluginId),
    );
  }

  async unregister(capabilityId: string): Promise<void> {
    await this.#registry.unregister(capabilityId);
  }

  async resetTransient(): Promise<void> {
    await this.#registry.resetTransient();
    await this.#resetBrowser();
    if (this.#computerBackend !== undefined) return;
    await this.#registry.unregister("computer");
    this.#computerRegistered = false;
    await this.#mountComputer();
  }

  hostSnapshot(): ZenXCapabilityHostSnapshot {
    return this.#registry.hostSnapshot();
  }

  async execute(invocation: ToolInvocation) {
    const plugin = this.#registry
      .availablePlugins()
      .find((candidate) =>
        candidate.tools.some((tool) => tool.name === invocation.name),
      );
    if (plugin !== undefined) {
      const prepared = this.#pluginToolEnvironment.prepare(invocation);
      return await this.#pluginToolEnvironment.execute(prepared);
    }
    return await this.#registry.execute(invocation);
  }

  async executePluginCommand(
    pluginId: string,
    commandId: string,
    input?: unknown,
  ): Promise<unknown> {
    return await this.#pluginUiPort(pluginId).executeCommand(commandId, input);
  }

  async readPluginUiHandle(
    pluginId: string,
    handleId: string,
  ): Promise<unknown> {
    return await this.#pluginUiPort(pluginId).readHandle(handleId);
  }

  #pluginUiPort(pluginId: string): PluginHostUiPort {
    return Object.freeze({
      executeCommand: async (commandId: string, input?: unknown) =>
        await this.#registry.executePluginCommand(pluginId, commandId, input),
      readHandle: async (handleId: string) =>
        await this.#registry.readPluginUiHandle(pluginId, handleId),
    });
  }

  async grant(
    capabilityId: string,
    permissionIds?: readonly string[],
  ): Promise<ZenXCapabilitySnapshot> {
    await this.#registry.grant(capabilityId, permissionIds);
    return this.snapshot();
  }

  async revoke(
    capabilityId: string,
    permissionIds?: readonly string[],
  ): Promise<ZenXCapabilitySnapshot> {
    await this.#registry.revoke(capabilityId, permissionIds);
    return this.snapshot();
  }

  async setEnabled(
    capabilityId: string,
    enabled: boolean,
  ): Promise<ZenXPluginSnapshot> {
    return await this.#serializeServiceMutation(async () => {
      await this.#registry.setEnabled(capabilityId, enabled);
      return this.pluginSnapshot();
    });
  }

  onChange(listener: (snapshot: ZenXCapabilitySnapshot) => void): () => void {
    return this.#registry.onChange(listener);
  }

  async close(): Promise<void> {
    await this.#unmountBrowser();
    await this.#registry.close();
    await this.#pluginRuntimeSupervisor.close();
    if (!this.#computerRegistered) await this.#computerBackend?.close();
  }

  async #resolvePnpm(): Promise<string> {
    return await resolveBundledPnpmCli({
      resourcesDirectory: this.#resourcesDirectory,
      overridePath: this.#pnpmCliPath,
    });
  }

  async #serializeServiceMutation<T>(mutation: () => Promise<T>): Promise<T> {
    const result = this.#serviceMutationTail.then(mutation);
    this.#serviceMutationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return await result;
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
