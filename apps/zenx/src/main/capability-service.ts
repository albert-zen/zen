import path from "node:path";
import { randomUUID } from "node:crypto";
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
import { JsonZenXPluginCatalogStore } from "./capabilities/plugin-catalog-store.js";
import { ZenXPluginCatalog } from "./capabilities/plugin-catalog.js";
import {
  selectBrowserProvider,
  selectBrowserProviderVariant,
  selectComputerProvider,
  type ZenXCapabilityProviderCatalogOptions,
} from "./capabilities/provider-catalog.js";
import { WinAppCliComputerBackend } from "./capabilities/windows-computer-provider.js";
import {
  bundledPackageRegistration,
  CatalogPluginRuntimeLifecycle,
  PluginRuntimeSupervisor,
} from "./plugin-runtime.js";
import type {
  ZenXPluginCatalogStore,
  ZenXCapabilityHost,
  ZenXCapabilityHostSnapshot,
  ZenXCapabilityPackage,
  ZenXPluginManifestV2,
  ZenXPluginDiagnostics,
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
import {
  FIRST_PARTY_MARKETPLACE_ENTRIES,
  FIRST_PARTY_PLUGIN_PACKAGES,
  firstPartyProviderTarball,
} from "./first-party-profile-loader.js";
import type { MarketplaceBuiltInEntry } from "../marketplace.js";
import {
  ZENX_ROOMS_PACKAGE_NAME,
  ZENX_ROOMS_TARBALL,
} from "./rooms-profile-loader.js";

export class ZenXCapabilityService implements ZenXCapabilityHost {
  readonly #registry: ZenXPluginCatalog;
  readonly #pluginToolEnvironment: ToolEnvironment;
  readonly #pluginRuntimeSupervisor: PluginRuntimeSupervisor;
  readonly #userDataDirectory: string;
  readonly #browserBackend?: ZenXBrowserBackend;
  readonly #computerBackend?: ZenXComputerBackend;
  readonly #computerManifest?: ZenXPluginManifestV2;
  readonly #bundledProvidersOnly: boolean;
  readonly #resourcesDirectory?: string;
  readonly #bundledManifestSha256?: string;
  readonly #pnpmCliPath?: string;
  readonly #pnpmEnvironment?: NodeJS.ProcessEnv;
  readonly #removeProfileGeneration?: (directory: string) => Promise<void>;
  readonly #trustedProfileLoaders: Readonly<
    Record<string, ZenXTrustedProfilePluginLoader>
  >;
  readonly #providerCatalogOptions: Pick<
    ZenXCapabilityProviderCatalogOptions,
    | "environment"
    | "platform"
    | "runner"
    | "winAppRunner"
    | "userBrowserConnector"
    | "electronBrowserFactory"
  >;
  #browserProfilePackage: ZenXCapabilityPackage | undefined;
  #computerProfilePackage: ZenXCapabilityPackage | undefined;
  #stagedBrowserProfilePackage: ZenXCapabilityPackage | undefined;
  #stagedComputerProfilePackage: ZenXCapabilityPackage | undefined;
  #pendingBrowserProfileSelection:
    | {
        capabilityPackage?: ZenXCapabilityPackage;
        diagnostics: ZenXPluginDiagnostics["providerDiagnostics"];
      }
    | undefined;
  #serviceMutationTail: Promise<void> = Promise.resolve();

  constructor(options: {
    userDataDirectory: string;
    catalogStore?: ZenXPluginCatalogStore;
    browserBackend?: ZenXBrowserBackend;
    computerBackend?: ZenXComputerBackend;
    computerManifest?: ZenXPluginManifestV2;
    bundledProvidersOnly?: boolean;
    resourcesDirectory?: string;
    bundledManifestSha256?: string;
    pnpmCliPath?: string;
    pnpmEnvironment?: NodeJS.ProcessEnv;
    removeProfileGeneration?: (directory: string) => Promise<void>;
    trustedProfileLoaders?: Readonly<
      Record<string, ZenXTrustedProfilePluginLoader>
    >;
    providerCatalogOptions?: Pick<
      ZenXCapabilityProviderCatalogOptions,
      | "environment"
      | "platform"
      | "runner"
      | "winAppRunner"
      | "userBrowserConnector"
      | "electronBrowserFactory"
    >;
  }) {
    this.#pluginToolEnvironment = new ToolEnvironment();
    this.#pluginRuntimeSupervisor = new PluginRuntimeSupervisor(
      this.#pluginToolEnvironment,
    );
    this.#registry = new ZenXPluginCatalog(
      options.catalogStore ??
        new JsonZenXPluginCatalogStore(
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
    this.#providerCatalogOptions = Object.freeze({
      ...(options.providerCatalogOptions ?? {}),
    });
  }

  async initialize(): Promise<void> {
    await this.#registry.initialize();
    await this.#initializeBrowserProfileProvider();
    await this.#selectComputerProfileProvider();
    await this.#loadCommittedProfile();
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

  async #initializeBrowserProfileProvider(): Promise<void> {
    const selected = await this.#resolveBrowserProfileProvider();
    const descriptor = this.#registry.packageDescriptors().browser;
    if (
      descriptor?.source !== "bundled" ||
      descriptor.profileSource?.mode !== "bundled"
    ) {
      this.#pendingBrowserProfileSelection = undefined;
      this.#publishBrowserProfileSelection(selected);
      return;
    }
    const committedProviderId = descriptor.manifest.provider.id;
    if (
      selected.capabilityPackage?.manifest.provider.id === committedProviderId
    ) {
      this.#pendingBrowserProfileSelection = undefined;
      this.#publishBrowserProfileSelection(selected);
      return;
    }
    const lifecycle = this.#registry
      .pluginSnapshot()
      .plugins.find((plugin) => plugin.id === "browser")?.lifecycle;
    if (lifecycle === "uninstalled") {
      this.#pendingBrowserProfileSelection = undefined;
      this.#publishBrowserProfileSelection(selected);
      return;
    }
    const committed =
      await this.#resolveBrowserProfileProviderVariant(committedProviderId);
    this.#pendingBrowserProfileSelection = selected;
    this.#publishBrowserProfileSelection(committed);
  }

  #publishBrowserProfileSelection(selection: {
    capabilityPackage?: ZenXCapabilityPackage;
    diagnostics: ZenXPluginDiagnostics["providerDiagnostics"];
  }): void {
    this.#browserProfilePackage = selection.capabilityPackage;
    this.#registry.replaceProviderDiagnostics("browser", selection.diagnostics);
    if (selection.capabilityPackage === undefined)
      this.#registry.recordDiscoveryError(
        `Browser provider: ${selection.diagnostics[0]?.reason ?? "unavailable"}`,
      );
  }

  async #resolveBrowserProfileProvider(): Promise<{
    capabilityPackage?: ZenXCapabilityPackage;
    diagnostics: ZenXPluginDiagnostics["providerDiagnostics"];
  }> {
    const selection =
      this.#browserBackend === undefined
        ? await selectBrowserProvider({
            ...this.#providerCatalogOptions,
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
    return {
      capabilityPackage:
        selection.backend === undefined
          ? undefined
          : new BrowserZenXCapabilityPackage(
              selection.backend,
              selection.manifest,
            ),
      diagnostics: selection.diagnostics,
    };
  }

  async #resolveBrowserProfileProviderVariant(providerId: string): Promise<{
    capabilityPackage?: ZenXCapabilityPackage;
    diagnostics: ZenXPluginDiagnostics["providerDiagnostics"];
  }> {
    const selection = await selectBrowserProviderVariant(providerId, {
      ...this.#providerCatalogOptions,
      userDataDirectory: this.#userDataDirectory,
      bundledProvidersOnly: this.#bundledProvidersOnly,
      resourcesDirectory: this.#resourcesDirectory,
      bundledManifestSha256: this.#bundledManifestSha256,
    });
    return {
      capabilityPackage:
        selection.backend === undefined
          ? undefined
          : new BrowserZenXCapabilityPackage(
              selection.backend,
              selection.manifest,
            ),
      diagnostics: selection.diagnostics,
    };
  }

  async #selectComputerProfileProvider(): Promise<void> {
    const selection = await this.#resolveComputerProfileProvider();
    this.#computerProfilePackage = selection.capabilityPackage;
    this.#registry.replaceProviderDiagnostics(
      "computer",
      selection.diagnostics,
    );
  }

  async #resolveComputerProfileProvider(): Promise<{
    capabilityPackage?: ZenXCapabilityPackage;
    diagnostics: ZenXPluginDiagnostics["providerDiagnostics"];
  }> {
    const selection =
      this.#computerBackend === undefined
        ? await selectComputerProvider({
            ...this.#providerCatalogOptions,
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
    let backend = selection.backend;
    let diagnostics = selection.diagnostics;
    if (
      this.#computerBackend !== undefined &&
      backend instanceof WinAppCliComputerBackend
    ) {
      const diagnostic = await backend.diagnose();
      if (!diagnostic.ready) {
        diagnostics = [
          {
            capabilityId: "computer",
            providerId: "microsoft-winapp-cli",
            status: "unavailable",
            interactionModes: ["background_safe"],
            capabilities: [
              "uia.inspect",
              "uia.invoke",
              "uia.set_value",
              "wgc.capture",
            ],
            reason: diagnostic.message,
            executable: diagnostic.executable,
          },
        ];
        await backend.close();
        backend = undefined;
      }
    }
    return {
      capabilityPackage:
        backend === undefined
          ? undefined
          : new ComputerZenXCapabilityPackage(backend, selection.manifest),
      diagnostics,
    };
  }

  browserProfilePackage(): ZenXCapabilityPackage {
    const capabilityPackage =
      this.#stagedBrowserProfilePackage ?? this.#browserProfilePackage;
    if (capabilityPackage === undefined)
      throw new Error("Browser provider is unavailable");
    return capabilityPackage;
  }

  computerProfilePackage(): ZenXCapabilityPackage {
    const capabilityPackage =
      this.#stagedComputerProfilePackage ?? this.#computerProfilePackage;
    if (capabilityPackage === undefined)
      throw new Error("Computer provider is unavailable");
    return capabilityPackage;
  }

  pluginSnapshot(): ZenXPluginSnapshot {
    return this.#registry.pluginSnapshot();
  }

  diagnostics(): ZenXPluginDiagnostics {
    return this.#registry.diagnostics();
  }

  marketplaceBuiltIns(): MarketplaceBuiltInEntry[] {
    const diagnostics = this.#registry.diagnostics().providerDiagnostics;
    return FIRST_PARTY_MARKETPLACE_ENTRIES.map((entry) => {
      const available =
        entry.pluginId === "browser"
          ? this.#browserProfilePackage !== undefined
          : entry.pluginId === "computer"
            ? this.#computerProfilePackage !== undefined
            : true;
      const diagnostic = diagnostics.find(
        (candidate) =>
          candidate.capabilityId === entry.pluginId &&
          candidate.status === "unavailable",
      );
      return {
        ...entry,
        available,
        ...(available || diagnostic?.reason === undefined
          ? {}
          : { unavailableReason: diagnostic.reason }),
      };
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

  async devPluginPackage(
    projectDirectory: string,
    expected: { pluginId: string; packageName: string },
    options: {
      signal?: AbortSignal;
      pnpmAbortGraceMs?: number;
      enterCommitPhase?: () => void;
      allowSameVersionBundledVariant?: boolean;
    } = {},
  ): Promise<{
    snapshot: ZenXPluginSnapshot;
    generation: string;
    packageName: string;
    pluginId: string;
  }> {
    return await this.#serializeServiceMutation(async () => {
      const snapshot = await this.#mutatePluginPackage(
        { mode: "dev-link", packageSpec: projectDirectory },
        expected.pluginId,
        expected.packageName,
        options,
      );
      const generation = this.#registry.profileGeneration();
      if (generation === undefined) {
        throw new Error("Plugin dev-link mutation did not commit a generation");
      }
      return {
        snapshot,
        generation,
        packageName: expected.packageName,
        pluginId: expected.pluginId,
      };
    });
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

  async installBuiltInPlugin(pluginId: string): Promise<ZenXPluginSnapshot> {
    const definition = this.#builtInPackageDefinition(pluginId);
    if (
      this.pluginSnapshot().plugins.some((plugin) => plugin.id === pluginId)
    ) {
      throw new Error(`Plugin ${pluginId} already has Catalog lifecycle state`);
    }
    return await this.installBundledPluginPackage(definition.tarballPath, {
      pluginId,
      packageName: definition.packageName,
    });
  }

  async replaceBundledProviderVariant(
    tarballPath: string,
    expected: { pluginId: "browser" | "computer"; packageName: string },
    candidatePackage?: ZenXCapabilityPackage,
  ): Promise<ZenXPluginSnapshot> {
    return await this.#serializeServiceMutation(async () => {
      const descriptor = this.#registry.packageDescriptors()[expected.pluginId];
      if (
        descriptor?.source !== "bundled" ||
        descriptor.profileSource?.mode !== "bundled" ||
        descriptor.profilePackageName !== expected.packageName
      ) {
        throw new Error(
          `Plugin ${expected.pluginId} is not a bundled provider package`,
        );
      }
      const source = await this.#trustedBundledSource(tarballPath);
      const previous =
        expected.pluginId === "browser"
          ? this.#browserProfilePackage
          : this.#computerProfilePackage;
      const candidate = candidatePackage ?? previous;
      if (candidate === undefined) {
        throw new Error(`${expected.pluginId} provider is unavailable`);
      }
      const selectedTarball = firstPartyProviderTarball(
        expected.pluginId,
        candidate.manifest.provider.id,
      );
      if (path.basename(source.packageSpec) !== selectedTarball) {
        throw new Error(
          `${expected.pluginId} provider candidate does not match ${path.basename(source.packageSpec)}`,
        );
      }
      this.#setStagedProviderPackage(expected.pluginId, candidate);
      try {
        const snapshot = await this.#mutatePluginPackage(
          source,
          expected.pluginId,
          expected.packageName,
          { allowSameVersionBundledVariant: true },
        );
        this.#commitProviderPackage(expected.pluginId, candidate);
        if (previous !== undefined && previous !== candidate) {
          this.#retireProviderPackage(expected.pluginId, previous);
        }
        return snapshot;
      } catch (error) {
        if (candidate !== previous) {
          await this.#discardProviderCandidate(expected.pluginId, candidate);
        }
        throw error;
      } finally {
        this.#setStagedProviderPackage(expected.pluginId, undefined);
      }
    });
  }

  #setStagedProviderPackage(
    pluginId: "browser" | "computer",
    capabilityPackage: ZenXCapabilityPackage | undefined,
  ): void {
    if (pluginId === "browser") {
      this.#stagedBrowserProfilePackage = capabilityPackage;
    } else {
      this.#stagedComputerProfilePackage = capabilityPackage;
    }
  }

  #commitProviderPackage(
    pluginId: "browser" | "computer",
    capabilityPackage: ZenXCapabilityPackage,
  ): void {
    if (pluginId === "browser") {
      this.#browserProfilePackage = capabilityPackage;
    } else {
      this.#computerProfilePackage = capabilityPackage;
    }
  }

  async #discardProviderCandidate(
    pluginId: "browser" | "computer",
    capabilityPackage: ZenXCapabilityPackage,
  ): Promise<void> {
    try {
      await capabilityPackage.close?.();
    } catch (error) {
      console.warn(
        `${pluginId} provider candidate cleanup failed: ${describeError(error)}`,
      );
    }
  }

  #retireProviderPackage(
    pluginId: "browser" | "computer",
    capabilityPackage: ZenXCapabilityPackage,
  ): void {
    void Promise.resolve()
      .then(async () => await capabilityPackage.close?.())
      .catch((error: unknown) => {
        console.warn(
          `${pluginId} provider cleanup failed after variant commit: ${describeError(error)}`,
        );
      });
  }

  async #mutatePluginPackage(
    source: ZenXPluginPackageSource,
    expectedPluginId?: string,
    expectedPackageName?: string,
    options: {
      signal?: AbortSignal;
      pnpmAbortGraceMs?: number;
      enterCommitPhase?: () => void;
      allowSameVersionBundledVariant?: boolean;
    } = {},
  ): Promise<ZenXPluginSnapshot> {
    options.signal?.throwIfAborted();
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
      signal: options.signal,
      pnpmAbortGraceMs: options.pnpmAbortGraceMs,
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
      const adoptsLegacyBundledCatalog =
        source.mode === "bundled" &&
        expectedPluginId === pluginId &&
        expectedPackageName === staged.packageName &&
        expectedDescriptor?.source === "bundled" &&
        expectedDescriptor.profilePackageName === undefined &&
        expectedDescriptor.profileSource === undefined;
      if (adoptsLegacyBundledCatalog) {
        let generation = staged.generation;
        let generationDirectory: string | undefined;
        if (current?.lifecycle === "uninstalled") {
          const removed = await stagePluginRemoval({
            userDataDirectory: this.#userDataDirectory,
            packageName: staged.packageName,
            pnpmCliPath,
            pnpmEnvironment: this.#pnpmEnvironment,
            currentGeneration: staged.generation,
            removeGeneration: this.#removeProfileGeneration,
          });
          generation = removed.generation;
          generationDirectory = removed.generationDirectory;
          await discardStagedProfileGeneration(
            staged.generationDirectory,
            this.#removeProfileGeneration,
          );
        }
        try {
          await this.#registry.adoptBundledProfile(staged.capabilityPackage, {
            generation,
            packageName: staged.packageName,
            source: staged.source,
          });
        } catch (error) {
          if (generationDirectory !== undefined) {
            await discardStagedProfileGeneration(
              generationDirectory,
              this.#removeProfileGeneration,
            );
          }
          throw error;
        }
        return this.pluginSnapshot();
      }
      const profile = {
        generation: staged.generation,
        packageName: staged.packageName,
        source: staged.source,
      };
      options.signal?.throwIfAborted();
      const catalogSource = source.mode === "bundled" ? "bundled" : "local";
      if (current === undefined) {
        await this.#registry.install(
          staged.capabilityPackage,
          catalogSource,
          profile,
          {
            signal: options.signal,
            enterCommitPhase: options.enterCommitPhase,
          },
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
          {
            allowSameVersionDevReload: source.mode === "dev-link",
            allowSameVersionBundledVariant:
              options.allowSameVersionBundledVariant === true &&
              source.mode === "bundled",
            signal: options.signal,
            enterCommitPhase: options.enterCommitPhase,
          },
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
          ? await this.#trustedBundledSource(
              this.#builtInPackageDefinition(pluginId).tarballPath,
            )
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

  #builtInPackageDefinition(pluginId: string): {
    packageName: string;
    tarballPath: string;
  } {
    if (this.#resourcesDirectory === undefined) {
      throw new Error("Bundled plugin App Resources are not configured");
    }
    let packageName: string;
    let tarball: string;
    switch (pluginId) {
      case "browser":
        packageName = FIRST_PARTY_PLUGIN_PACKAGES.browser.packageName;
        tarball = firstPartyProviderTarball(
          pluginId,
          this.browserProfilePackage().manifest.provider.id,
        );
        break;
      case "computer":
        packageName = FIRST_PARTY_PLUGIN_PACKAGES.computer.packageName;
        tarball = firstPartyProviderTarball(
          pluginId,
          this.computerProfilePackage().manifest.provider.id,
        );
        break;
      case "zenx-rooms":
        packageName = ZENX_ROOMS_PACKAGE_NAME;
        tarball = ZENX_ROOMS_TARBALL;
        break;
      case "zenx-self-control":
        packageName = FIRST_PARTY_PLUGIN_PACKAGES.selfControl.packageName;
        tarball = FIRST_PARTY_PLUGIN_PACKAGES.selfControl.tarball;
        break;
      case "zenx-triggers":
        packageName = FIRST_PARTY_PLUGIN_PACKAGES.triggers.packageName;
        tarball = FIRST_PARTY_PLUGIN_PACKAGES.triggers.tarball;
        break;
      default:
        throw new Error(`Plugin ${pluginId} is not built into ZenX`);
    }
    return {
      packageName,
      tarballPath: path.join(this.#resourcesDirectory, "plugins", tarball),
    };
  }

  async deletePluginData(pluginId: string): Promise<void> {
    await this.#serializeServiceMutation(
      async () => await this.#registry.deleteData(pluginId),
    );
  }

  async resetTransient(): Promise<void> {
    await this.#registry.resetTransient();
    if (this.#browserBackend === undefined) {
      await this.#discardPendingBrowserProfileSelection();
      await this.#applySelectedProviderCandidate(
        "browser",
        await this.#resolveBrowserProfileProvider(),
      );
    } else {
      await this.#syncProviderVariant("browser", this.#browserProfilePackage);
    }
    if (this.#computerBackend === undefined) {
      await this.#applySelectedProviderCandidate(
        "computer",
        await this.#resolveComputerProfileProvider(),
      );
    } else {
      await this.#syncProviderVariant("computer", this.#computerProfilePackage);
    }
  }

  async syncProfileManagedProviderVariants(): Promise<void> {
    const pendingBrowser = this.#pendingBrowserProfileSelection;
    this.#pendingBrowserProfileSelection = undefined;
    if (pendingBrowser !== undefined) {
      await this.#applySelectedProviderCandidate("browser", pendingBrowser);
    } else {
      await this.#serializeServiceMutation(
        async () =>
          await this.#syncProviderVariant(
            "browser",
            this.#browserProfilePackage,
          ),
      );
    }
    await this.#serializeServiceMutation(
      async () =>
        await this.#syncProviderVariant(
          "computer",
          this.#computerProfilePackage,
        ),
    );
  }

  async #discardPendingBrowserProfileSelection(): Promise<void> {
    const pending = this.#pendingBrowserProfileSelection;
    this.#pendingBrowserProfileSelection = undefined;
    if (pending?.capabilityPackage !== undefined) {
      await this.#discardProviderCandidate(
        "browser",
        pending.capabilityPackage,
      );
    }
  }

  async #applySelectedProviderCandidate(
    pluginId: "browser" | "computer",
    selection: {
      capabilityPackage?: ZenXCapabilityPackage;
      diagnostics: ZenXPluginDiagnostics["providerDiagnostics"];
    },
  ): Promise<void> {
    const candidate = selection.capabilityPackage;
    if (candidate === undefined || this.#resourcesDirectory === undefined) {
      this.#registry.recordDiscoveryError(
        `${pluginId === "browser" ? "Browser" : "Computer"} provider: ${selection.diagnostics[0]?.reason ?? "unavailable"}`,
      );
      return;
    }
    const tarball = firstPartyProviderTarball(
      pluginId,
      candidate.manifest.provider.id,
    );
    const selected = path.join(this.#resourcesDirectory, "plugins", tarball);
    const descriptor = this.#registry.packageDescriptors()[pluginId];
    if (
      descriptor?.profileSource?.mode !== "bundled" ||
      descriptor.profilePackageName === undefined
    ) {
      await this.#discardProviderCandidate(pluginId, candidate);
      return;
    }
    if ((await realpath(selected)) === descriptor.profileSource.packageSpec) {
      await this.#discardProviderCandidate(pluginId, candidate);
      this.#registry.replaceProviderDiagnostics(
        pluginId,
        selection.diagnostics,
      );
      return;
    }
    try {
      await this.replaceBundledProviderVariant(
        selected,
        {
          pluginId,
          packageName: descriptor.profilePackageName,
        },
        candidate,
      );
      this.#registry.replaceProviderDiagnostics(
        pluginId,
        selection.diagnostics,
      );
    } catch (error) {
      this.#registry.recordDiscoveryError(
        `${pluginId === "browser" ? "Browser" : "Computer"} provider variant: ${describeError(error)}`,
      );
      throw error;
    }
  }

  async #syncProviderVariant(
    pluginId: "browser" | "computer",
    capabilityPackage: ZenXCapabilityPackage | undefined,
  ): Promise<void> {
    if (
      capabilityPackage === undefined ||
      this.#resourcesDirectory === undefined
    )
      return;
    const descriptor = this.#registry.packageDescriptors()[pluginId];
    if (descriptor?.profileSource?.mode !== "bundled") return;
    const selected = path.join(
      this.#resourcesDirectory,
      "plugins",
      firstPartyProviderTarball(
        pluginId,
        capabilityPackage.manifest.provider.id,
      ),
    );
    if ((await realpath(selected)) === descriptor.profileSource.packageSpec)
      return;
    await this.#mutatePluginPackage(
      await this.#trustedBundledSource(selected),
      pluginId,
      descriptor.profilePackageName,
      { allowSameVersionBundledVariant: true },
    );
  }

  hostSnapshot(): ZenXCapabilityHostSnapshot {
    return this.#registry.hostSnapshot();
  }

  async execute(invocation: ToolInvocation) {
    const prepared = this.#pluginToolEnvironment.prepare(invocation);
    return await this.#pluginToolEnvironment.execute(prepared);
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
      executeCommand: async (commandId: string, input?: unknown) => {
        const command = this.#registry
          .pluginSnapshot()
          .commands.find(
            (candidate) =>
              candidate.pluginId === pluginId && candidate.id === commandId,
          );
        if (command === undefined) {
          throw new Error(`Unknown plugin command: ${pluginId}:${commandId}`);
        }
        const result = await this.#pluginRuntimeSupervisor.invoke(pluginId, {
          invocationId: `ui-${randomUUID()}`,
          tool: command.tool,
          arguments: {
            ...(command.input ?? {}),
            ...(input === undefined ? {} : { input: structuredClone(input) }),
          },
          context: { callId: `ui-${randomUUID()}`, cwd: process.cwd() },
          signal: new AbortController().signal,
        });
        return JSON.parse(result.output) as unknown;
      },
      readHandle: async (handleId: string) =>
        await this.#registry.readPluginUiHandle(pluginId, handleId),
    });
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

  onChange(listener: (snapshot: ZenXPluginSnapshot) => void): () => void {
    return this.#registry.onChange(listener);
  }

  async close(): Promise<void> {
    await this.#discardPendingBrowserProfileSelection();
    await this.#registry.close();
    await this.#pluginRuntimeSupervisor.close();
    await this.#browserProfilePackage?.close?.();
    await this.#computerProfilePackage?.close?.();
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
