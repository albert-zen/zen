import { rm } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import { validatePluginManifest as validatePublicPluginManifest } from "@zenx/plugin-sdk";

import type { ModelTool } from "../../../../../src/model.js";
import type {
  RegisteredZenXCapability,
  ZenXAvailablePlugin,
  ZenXPluginCatalogStore,
  ZenXCapabilityHostSnapshot,
  ZenXCapabilityPackage,
  ZenXCapabilityProviderDiagnostic,
  ZenXCapabilityTool,
  ZenXCapabilityInteractionMode,
  ZenXPluginSnapshot,
  ZenXPluginSummary,
  ZenXPluginPackageDescriptor,
  ZenXPluginProfileSource,
  ZenXPluginManifestV2,
  ZenXPluginDiagnostics,
  ZenXPluginRuntimeLifecycle,
  ZenXPluginRuntimeStage,
  ZenXPluginCatalogState,
} from "./types.js";
import {
  MAX_CAPABILITY_OUTPUT_BYTES,
  MIN_CAPABILITY_OUTPUT_BYTES,
  ZENX_PLUGIN_ICON_NAMES,
} from "./types.js";
import type { PluginDiscoveryCatalog } from "../plugin-discovery.js";

export interface ZenXPluginCatalogOptions {
  allowForegroundRequired: boolean;
  platform: string;
  pluginDataDirectory?: string;
  pluginRuntimeLifecycle?: ZenXPluginRuntimeLifecycle;
}

export class ZenXPluginCatalog implements PluginDiscoveryCatalog {
  readonly #configurationStore: ZenXPluginCatalogStore;
  readonly #registered = new Map<string, RegisteredZenXCapability>();
  readonly #catalogPackages = new Map<string, RegisteredZenXCapability>();
  readonly #toolOwners = new Map<
    string,
    { capabilityId: string; tool: ZenXCapabilityTool }
  >();
  readonly #listeners = new Set<(snapshot: ZenXPluginSnapshot) => void>();
  readonly #providerDiagnostics: ZenXCapabilityProviderDiagnostic[] = [];
  readonly #discoveryErrors: string[] = [];
  readonly #options: ZenXPluginCatalogOptions;
  #allowForegroundRequired: boolean;
  #disabled = new Set<string>();
  #uninstalled = new Set<string>();
  #packageDescriptors: Record<string, ZenXPluginPackageDescriptor> = {};
  #profileGeneration: string | undefined;
  #catalogAvailable = true;
  #configurationMutationTail: Promise<void> = Promise.resolve();

  constructor(
    configurationStore: ZenXPluginCatalogStore,
    options: Partial<ZenXPluginCatalogOptions> = {},
  ) {
    this.#configurationStore = configurationStore;
    this.#options = {
      allowForegroundRequired: false,
      platform: process.platform,
      ...options,
    };
    this.#allowForegroundRequired = this.#options.allowForegroundRequired;
  }

  async initialize(): Promise<void> {
    let configuration: ZenXPluginCatalogState;
    try {
      configuration = await this.#configurationStore.load();
    } catch (error) {
      this.#catalogAvailable = false;
      // The catalog contains optional capabilities, not the core Thread
      // journal. Keep the host usable with no plugins when its persisted
      // catalog cannot be read; the diagnostic makes the loss explicit and
      // the user can reinstall the affected plugins from Settings.
      this.#discoveryErrors.push(
        `ZenX plugin catalog could not be loaded: ${describeError(error)}`,
      );
      configuration = { disabled: [], uninstalled: [], packages: {} };
    }
    this.#disabled = new Set(configuration.disabled);
    this.#uninstalled = new Set(configuration.uninstalled ?? []);
    const packageDescriptors = structuredClone(configuration.packages ?? {});
    this.#profileGeneration = configuration.profileGeneration;
    if (
      this.#profileGeneration !== undefined &&
      !/^[0-9a-f-]{36}$/u.test(this.#profileGeneration)
    ) {
      this.#discoveryErrors.push(
        "ZenX plugin profile generation is invalid; affected plugins were quarantined",
      );
      this.#profileGeneration = undefined;
    }
    this.#packageDescriptors = {};
    for (const [pluginId, descriptor] of Object.entries(packageDescriptors)) {
      try {
        if (
          descriptor.manifest.id !== pluginId ||
          descriptor.manifest.schemaVersion !== 2 ||
          (descriptor.source !== "bundled" && descriptor.source !== "local") ||
          (descriptor.profilePackageName !== undefined &&
            (descriptor.profilePackageName.length === 0 ||
              this.#profileGeneration === undefined)) ||
          (descriptor.profileSource !== undefined &&
            (!isProfileSource(descriptor.profileSource) ||
              descriptor.profilePackageName !==
                descriptor.profileSource.packageName ||
              (descriptor.profileSource.mode === "bundled") !==
                (descriptor.source === "bundled")))
        ) {
          throw new Error("descriptor shape is invalid");
        }
        validateManifest(descriptor.manifest);
        this.#packageDescriptors[pluginId] = descriptor;
      } catch (error) {
        this.#discoveryErrors.push(
          `ZenX plugin catalog descriptor ${pluginId} was quarantined: ${describeError(error)}`,
        );
      }
    }
  }

  async install(
    capabilityPackage: ZenXCapabilityPackage,
    source: "bundled" | "local" = "local",
    profile?: {
      generation: string;
      packageName: string;
      source: ZenXPluginProfileSource;
    },
    options: {
      signal?: AbortSignal;
      enterCommitPhase?: () => void;
    } = {},
  ): Promise<void> {
    await this.#serializeConfigurationMutation(async () => {
      const manifest = validateManifest(capabilityPackage.manifest);
      if (this.#catalogPackages.has(manifest.id)) {
        throw new Error(`Capability ${manifest.id} is already registered`);
      }
      const stored = this.#packageDescriptors[manifest.id];
      if (stored !== undefined) {
        if (
          stored.source !== source ||
          JSON.stringify(stored.manifest) !== JSON.stringify(manifest)
        ) {
          throw new Error(
            `Plugin ${manifest.id} does not match its installed package descriptor`,
          );
        }
        const registration = { package: capabilityPackage, source } as const;
        this.#catalogPackages.set(manifest.id, registration);
        if (
          !this.#uninstalled.has(manifest.id) &&
          !this.#disabled.has(manifest.id)
        ) {
          let runtimeStage: ZenXPluginRuntimeStage | undefined;
          try {
            this.#validateRegistration(manifest);
            runtimeStage = await this.#stagePluginRuntime(registration);
            runtimeStage?.publish();
            this.#activateRegistration(registration);
          } catch (error) {
            this.#catalogPackages.delete(manifest.id);
            await runtimeStage?.rollback();
            throw error;
          }
        }
        return;
      }
      this.#validateRegistration(manifest);
      const registration = { package: capabilityPackage, source } as const;
      const descriptor = {
        manifest: structuredClone(manifest),
        source,
        ...(profile === undefined
          ? {}
          : {
              profilePackageName: profile.packageName,
              profileSource: structuredClone(profile.source),
            }),
      } satisfies ZenXPluginPackageDescriptor;
      const nextPackages = {
        ...this.#packageDescriptors,
        [manifest.id]: descriptor,
      };
      const nextUninstalled = new Set(this.#uninstalled);
      nextUninstalled.delete(manifest.id);
      const shouldEnable = !this.#disabled.has(manifest.id);
      const runtimeStage = shouldEnable
        ? await this.#stagePluginRuntime(registration)
        : undefined;
      const nextConfiguration = this.#configuration({
        packages: nextPackages,
        uninstalled: nextUninstalled,
        ...(profile === undefined
          ? {}
          : { profileGeneration: profile.generation }),
      });
      try {
        enterCatalogCommit(options);
        await this.#configurationStore.save(nextConfiguration);
      } catch (error) {
        await runtimeStage?.rollback();
        throw error;
      }
      this.#packageDescriptors = nextPackages;
      this.#uninstalled = nextUninstalled;
      if (profile !== undefined) this.#profileGeneration = profile.generation;
      this.#catalogPackages.set(manifest.id, registration);
      if (shouldEnable) {
        runtimeStage?.publish();
        this.#activateRegistration(registration);
      }
    });
  }

  async update(
    capabilityPackage: ZenXCapabilityPackage,
    source: "bundled" | "local" = "local",
    profile?: {
      generation: string;
      packageName: string;
      source: ZenXPluginProfileSource;
    },
    options: {
      allowSameVersionDevReload?: boolean;
      allowSameVersionBundledVariant?: boolean;
      signal?: AbortSignal;
      enterCommitPhase?: () => void;
    } = {},
  ): Promise<void> {
    await this.#serializeConfigurationMutation(async () => {
      const manifest = validateManifest(capabilityPackage.manifest);
      const previous = this.#catalogPackages.get(manifest.id);
      const previousDescriptor = this.#packageDescriptors[manifest.id];
      if (previous === undefined || previousDescriptor === undefined) {
        throw new Error(`Plugin ${manifest.id} is not installed`);
      }
      if (previousDescriptor.source !== source) {
        throw new Error(`Plugin ${manifest.id} package source cannot change`);
      }
      if (
        previousDescriptor.manifest.version === manifest.version &&
        !(
          options.allowSameVersionDevReload === true &&
          profile?.source.mode === "dev-link"
        ) &&
        !(
          options.allowSameVersionBundledVariant === true &&
          source === "bundled" &&
          profile?.source.mode === "bundled"
        )
      ) {
        throw new Error(
          `Plugin ${manifest.id} is already version ${manifest.version}`,
        );
      }
      this.#validateRegistration(manifest, manifest.id);
      const replacement = { package: capabilityPackage, source } as const;
      const shouldEnable =
        !this.#uninstalled.has(manifest.id) && !this.#disabled.has(manifest.id);
      const runtimeStage = shouldEnable
        ? await this.#stagePluginRuntime(replacement, true)
        : undefined;
      const nextDescriptor = {
        ...previousDescriptor,
        manifest: structuredClone(manifest),
        source,
        ...(profile === undefined
          ? {}
          : {
              profilePackageName: profile.packageName,
              profileSource: structuredClone(profile.source),
            }),
      } satisfies ZenXPluginPackageDescriptor;
      const nextPackages = {
        ...this.#packageDescriptors,
        [manifest.id]: nextDescriptor,
      };
      const nextConfiguration = this.#configuration({
        packages: nextPackages,
        ...(profile === undefined
          ? {}
          : { profileGeneration: profile.generation }),
      });

      try {
        if (shouldEnable && profile === undefined) {
          await this.#stopPluginRuntimeWithRollback(manifest.id, previous);
        }
        enterCatalogCommit(options);
        await this.#configurationStore.save(nextConfiguration);
      } catch (error) {
        await runtimeStage?.rollback();
        if (shouldEnable && profile === undefined) {
          await this.#restorePluginRuntime(previous);
        }
        throw error;
      }

      this.#packageDescriptors = nextPackages;
      if (profile !== undefined) this.#profileGeneration = profile.generation;
      this.#catalogPackages.set(manifest.id, replacement);
      if (profile !== undefined) {
        const active = this.#registered.get(manifest.id);
        if (active !== undefined) {
          this.#unregisterCommittedProfileProjection(manifest.id, active);
        }
        if (shouldEnable) {
          runtimeStage?.publish();
          this.#activateRegistration(replacement);
        }
        return;
      }
      try {
        const active = this.#registered.get(manifest.id);
        if (active !== undefined) {
          await this.#unregisterRegistration(manifest.id, active, false);
        }
        if (shouldEnable) {
          runtimeStage?.publish();
          this.#activateRegistration(replacement);
        }
      } catch (error) {
        await runtimeStage?.rollback();
        this.#packageDescriptors = {
          ...this.#packageDescriptors,
          [manifest.id]: previousDescriptor,
        };
        this.#catalogPackages.set(manifest.id, previous);
        await this.#configurationStore.save(
          this.#configuration({ packages: this.#packageDescriptors }),
        );
        if (shouldEnable && !this.#registered.has(manifest.id)) {
          await this.#restorePluginRuntime(previous);
          this.#activateRegistration(previous);
        }
        throw error;
      }
    });
  }

  async adoptBundledProfile(
    capabilityPackage: ZenXCapabilityPackage,
    profile: {
      generation: string;
      packageName: string;
      source: ZenXPluginProfileSource;
    },
  ): Promise<void> {
    await this.#serializeConfigurationMutation(async () => {
      const manifest = validateManifest(capabilityPackage.manifest);
      const previousDescriptor = this.#packageDescriptors[manifest.id];
      if (
        previousDescriptor === undefined ||
        previousDescriptor.source !== "bundled" ||
        previousDescriptor.profilePackageName !== undefined ||
        previousDescriptor.profileSource !== undefined ||
        profile.source.mode !== "bundled" ||
        profile.source.packageName !== profile.packageName ||
        profile.source.packageVersion !== manifest.version
      ) {
        throw new Error(
          `Plugin ${manifest.id} is not an adoptable bundled Catalog package`,
        );
      }
      if (this.#catalogPackages.has(manifest.id)) {
        throw new Error(
          `Plugin ${manifest.id} bundled profile adoption requires bootstrap state`,
        );
      }
      if (!sameBundledAdoptionManifest(previousDescriptor.manifest, manifest)) {
        throw new Error(
          `Plugin ${manifest.id} bundled profile does not match its Catalog identity`,
        );
      }
      this.#validateRegistration(manifest);
      const replacement = {
        package: capabilityPackage,
        source: "bundled",
      } as const;
      const uninstalled = this.#uninstalled.has(manifest.id);
      const shouldEnable = !uninstalled && !this.#disabled.has(manifest.id);
      const runtimeStage = shouldEnable
        ? await this.#stagePluginRuntime(replacement)
        : undefined;
      const nextPackages = {
        ...this.#packageDescriptors,
        [manifest.id]: {
          manifest: structuredClone(manifest),
          source: "bundled",
          profilePackageName: profile.packageName,
          profileSource: structuredClone(profile.source),
        },
      } satisfies Record<string, ZenXPluginPackageDescriptor>;
      try {
        await this.#configurationStore.save(
          this.#configuration({
            packages: nextPackages,
            profileGeneration: profile.generation,
          }),
        );
      } catch (error) {
        await runtimeStage?.rollback();
        throw error;
      }
      this.#packageDescriptors = nextPackages;
      this.#profileGeneration = profile.generation;
      if (!uninstalled) this.#catalogPackages.set(manifest.id, replacement);
      if (shouldEnable) {
        runtimeStage?.publish();
        this.#activateRegistration(replacement);
      }
    });
  }

  async uninstall(pluginId: string, profileGeneration?: string): Promise<void> {
    await this.#serializeConfigurationMutation(async () => {
      const supplied = this.#catalogPackages.get(pluginId);
      if (
        supplied === undefined &&
        this.#packageDescriptors[pluginId] === undefined
      ) {
        throw new Error(`Unknown ZenX capability: ${pluginId}`);
      }
      if (this.#uninstalled.has(pluginId)) return;
      const hadRuntime =
        supplied !== undefined && !this.#disabled.has(pluginId);
      if (hadRuntime && supplied !== undefined) {
        await this.#stopPluginRuntimeWithRollback(pluginId, supplied);
      }
      const nextUninstalled = new Set(this.#uninstalled);
      nextUninstalled.add(pluginId);
      try {
        await this.#configurationStore.save(
          this.#configuration({
            uninstalled: nextUninstalled,
            ...(profileGeneration === undefined ? {} : { profileGeneration }),
          }),
        );
      } catch (error) {
        if (hadRuntime && supplied !== undefined) {
          await this.#restorePluginRuntime(supplied);
        }
        throw error;
      }
      const previousUninstalled = this.#uninstalled;
      this.#uninstalled = nextUninstalled;
      if (profileGeneration !== undefined) {
        this.#profileGeneration = profileGeneration;
        this.#catalogPackages.delete(pluginId);
      }
      this.#emit();
      try {
        const registered = this.#registered.get(pluginId);
        if (registered !== undefined) {
          await this.#unregisterRegistration(pluginId, registered, false);
        }
      } catch (error) {
        await this.#configurationStore.save(
          this.#configuration({ uninstalled: previousUninstalled }),
        );
        this.#uninstalled = previousUninstalled;
        if (supplied !== undefined && !this.#registered.has(pluginId)) {
          this.#validateRegistration(supplied.package.manifest);
          await this.#restorePluginRuntime(supplied);
          this.#activateRegistration(supplied);
        }
        throw error;
      }
    });
  }

  async reinstall(pluginId: string): Promise<void> {
    await this.#serializeConfigurationMutation(async () => {
      if (!this.#uninstalled.has(pluginId)) return;
      const supplied = this.#catalogPackages.get(pluginId);
      if (supplied === undefined) {
        throw new Error(
          `Plugin package ${pluginId} is not available to reinstall`,
        );
      }
      const shouldEnable = !this.#disabled.has(pluginId);
      if (shouldEnable) {
        this.#validateRegistration(supplied.package.manifest);
      }
      const runtimeStage = shouldEnable
        ? await this.#stagePluginRuntime(supplied)
        : undefined;
      const nextUninstalled = new Set(this.#uninstalled);
      nextUninstalled.delete(pluginId);
      try {
        await this.#configurationStore.save(
          this.#configuration({ uninstalled: nextUninstalled }),
        );
      } catch (error) {
        await runtimeStage?.rollback();
        throw error;
      }
      this.#uninstalled = nextUninstalled;
      if (shouldEnable) {
        try {
          runtimeStage?.publish();
          this.#activateRegistration(supplied);
        } catch (error) {
          this.#uninstalled.add(pluginId);
          await runtimeStage?.rollback();
          await this.#configurationStore.save(
            this.#configuration({ uninstalled: this.#uninstalled }),
          );
          throw error;
        }
      }
    });
  }

  async reinstallProfile(
    capabilityPackage: ZenXCapabilityPackage,
    profile: {
      generation: string;
      packageName: string;
      source: ZenXPluginProfileSource;
    },
  ): Promise<void> {
    await this.#serializeConfigurationMutation(async () => {
      const manifest = validateManifest(capabilityPackage.manifest);
      const descriptor = this.#packageDescriptors[manifest.id];
      if (descriptor === undefined || !this.#uninstalled.has(manifest.id)) {
        throw new Error(`Plugin ${manifest.id} is not uninstalled`);
      }
      if (
        descriptor.profilePackageName !== profile.packageName ||
        descriptor.profileSource === undefined
      ) {
        throw new Error(`Plugin ${manifest.id} profile source does not match`);
      }
      this.#validateRegistration(manifest);
      const registration = {
        package: capabilityPackage,
        source: descriptor.source,
      } as const;
      const shouldEnable = !this.#disabled.has(manifest.id);
      const runtimeStage = shouldEnable
        ? await this.#stagePluginRuntime(registration)
        : undefined;
      const nextUninstalled = new Set(this.#uninstalled);
      nextUninstalled.delete(manifest.id);
      const nextPackages = {
        ...this.#packageDescriptors,
        [manifest.id]: {
          ...descriptor,
          manifest: structuredClone(manifest),
          profilePackageName: profile.packageName,
          profileSource: structuredClone(profile.source),
        },
      };
      try {
        await this.#configurationStore.save(
          this.#configuration({
            uninstalled: nextUninstalled,
            packages: nextPackages,
            profileGeneration: profile.generation,
          }),
        );
      } catch (error) {
        await runtimeStage?.rollback();
        throw error;
      }
      this.#uninstalled = nextUninstalled;
      this.#packageDescriptors = nextPackages;
      this.#profileGeneration = profile.generation;
      this.#catalogPackages.set(manifest.id, registration);
      if (shouldEnable) {
        runtimeStage?.publish();
        this.#activateRegistration(registration);
      }
    });
  }

  async deleteData(pluginId: string): Promise<void> {
    await this.#serializeConfigurationMutation(async () => {
      if (!/^[a-z][a-z0-9-]{1,62}$/u.test(pluginId)) {
        throw new Error(`Invalid plugin id: ${pluginId}`);
      }
      if (this.#options.pluginDataDirectory === undefined) {
        throw new Error("Plugin data directory is not configured");
      }
      if (
        this.#packageDescriptors[pluginId] === undefined &&
        !this.#catalogPackages.has(pluginId)
      ) {
        throw new Error(`Unknown ZenX plugin: ${pluginId}`);
      }
      if (!this.#uninstalled.has(pluginId) && !this.#disabled.has(pluginId)) {
        throw new Error(
          `Disable or uninstall plugin ${pluginId} before deleting its data`,
        );
      }
      await rm(path.join(this.#options.pluginDataDirectory, pluginId), {
        recursive: true,
        force: true,
      });
    });
  }

  #validateRegistration(
    manifest: ZenXPluginManifestV2,
    replacingPluginId?: string,
  ): void {
    for (const tool of manifest.tools) {
      if (
        this.#toolOwners.has(tool.name) &&
        this.#toolOwners.get(tool.name)?.capabilityId !== replacingPluginId
      ) {
        throw new Error(`Capability tool ${tool.name} is already registered`);
      }
    }
    for (const route of [
      ...(manifest.contributions?.pages ?? []),
      ...(manifest.contributions?.subroutes ?? []),
    ]) {
      for (const registered of this.#registered.values()) {
        if (registered.package.manifest.id === replacingPluginId) continue;
        const contributions = registered.package.manifest.contributions;
        if (
          [
            ...(contributions?.pages ?? []),
            ...(contributions?.subroutes ?? []),
          ].some((candidate) => candidate.route === route.route)
        ) {
          throw new Error(
            `Plugin page route ${route.route} is already registered`,
          );
        }
      }
    }
  }

  #activateRegistration(registration: RegisteredZenXCapability): void {
    const manifest = registration.package.manifest;
    this.#registered.set(manifest.id, registration);
    for (const tool of manifest.tools) {
      this.#toolOwners.set(tool.name, { capabilityId: manifest.id, tool });
    }
    this.#emit();
  }

  async unregister(capabilityId: string): Promise<void> {
    const registered = this.#registered.get(capabilityId);
    if (registered === undefined) return;
    await this.#unregisterRegistration(capabilityId, registered);
  }

  async #unregisterRegistration(
    capabilityId: string,
    registered: RegisteredZenXCapability,
    stopRuntime = true,
  ): Promise<void> {
    if (this.#registered.get(capabilityId) !== registered) return;
    this.#registered.delete(capabilityId);
    for (const tool of registered.package.manifest.tools) {
      this.#toolOwners.delete(tool.name);
    }
    if (stopRuntime) await this.#stopPluginRuntime(capabilityId);
    this.#emit();
  }

  #unregisterCommittedProfileProjection(
    capabilityId: string,
    registered: RegisteredZenXCapability,
  ): void {
    if (this.#registered.get(capabilityId) !== registered) return;
    this.#registered.delete(capabilityId);
    for (const tool of registered.package.manifest.tools) {
      this.#toolOwners.delete(tool.name);
    }
    this.#emit();
  }

  recordDiscoveryError(message: string): void {
    this.#discoveryErrors.push(message);
    this.#emit();
  }

  recordProviderDiagnostic(diagnostic: ZenXCapabilityProviderDiagnostic): void {
    const index = this.#providerDiagnostics.findIndex(
      (candidate) =>
        candidate.capabilityId === diagnostic.capabilityId &&
        candidate.providerId === diagnostic.providerId,
    );
    if (index === -1)
      this.#providerDiagnostics.push(structuredClone(diagnostic));
    else this.#providerDiagnostics[index] = structuredClone(diagnostic);
    this.#emit();
  }

  replaceProviderDiagnostics(
    capabilityId: "browser" | "computer",
    diagnostics: readonly ZenXCapabilityProviderDiagnostic[],
  ): void {
    const next = [
      ...this.#providerDiagnostics.filter(
        (diagnostic) => diagnostic.capabilityId !== capabilityId,
      ),
      ...diagnostics.map((diagnostic) => structuredClone(diagnostic)),
    ];
    this.#providerDiagnostics.splice(
      0,
      this.#providerDiagnostics.length,
      ...next,
    );
    this.#emit();
  }

  pluginSnapshot(): ZenXPluginSnapshot {
    const catalog = new Map<
      string,
      {
        manifest: ZenXPluginManifestV2;
        source: "bundled" | "local";
        available: boolean;
      }
    >();
    for (const descriptor of Object.values(this.#packageDescriptors)) {
      catalog.set(descriptor.manifest.id, {
        ...descriptor,
        available: this.#catalogPackages.has(descriptor.manifest.id),
      });
    }
    for (const registered of this.#catalogPackages.values()) {
      if (!catalog.has(registered.package.manifest.id)) {
        catalog.set(registered.package.manifest.id, {
          manifest: registered.package.manifest,
          source: registered.source,
          available: true,
        });
      }
    }
    const plugins = [...catalog.values()].map((entry) => {
      const manifest = entry.manifest;
      const uninstalled = this.#uninstalled.has(manifest.id);
      const enabled = !uninstalled && !this.#disabled.has(manifest.id);
      const lifecycle: ZenXPluginSummary["lifecycle"] = uninstalled
        ? "uninstalled"
        : enabled
          ? "enabled"
          : "installed";
      return {
        id: manifest.id,
        displayName: manifest.name,
        version: manifest.version,
        description: manifest.description,
        compatibility: manifest.compatibility.zenx,
        source: entry.source,
        ...(this.#packageDescriptors[manifest.id]?.profileSource === undefined
          ? {}
          : {
              profileSource: structuredClone(
                this.#packageDescriptors[manifest.id]!.profileSource!,
              ),
            }),
        lifecycle,
        enabled,
        available: entry.available,
        contributionCount:
          (manifest.contributions?.sidebar?.length ?? 0) +
          (manifest.contributions?.pages?.length ?? 0) +
          (manifest.contributions?.subroutes?.length ?? 0) +
          (manifest.contributions?.settings?.length ?? 0) +
          (manifest.contributions?.panels?.length ?? 0) +
          (manifest.contributions?.commands?.length ?? 0) +
          (manifest.contributions?.menus?.length ?? 0) +
          (manifest.contributions?.resultRenderers?.length ?? 0),
      };
    });
    const enabled = [...this.#registered.values()].filter(
      (registered) =>
        !this.#uninstalled.has(registered.package.manifest.id) &&
        !this.#disabled.has(registered.package.manifest.id),
    );
    const pages = enabled.flatMap((registered) => {
      const pluginId = registered.package.manifest.id;
      return (registered.package.manifest.contributions?.pages ?? []).map(
        (page) => ({
          ...structuredClone(page),
          key: `${pluginId}:${page.id}`,
          pluginId,
        }),
      );
    });
    const sidebar = enabled
      .flatMap((registered) => {
        const pluginId = registered.package.manifest.id;
        return (registered.package.manifest.contributions?.sidebar ?? []).map(
          (contribution) => ({
            ...structuredClone(contribution),
            key: `${pluginId}:${contribution.id}`,
            pluginId,
          }),
        );
      })
      .sort(
        (left, right) =>
          (left.order ?? 0) - (right.order ?? 0) ||
          left.key.localeCompare(right.key),
      );
    const project = <T extends { id: string }>(
      select: (manifest: ZenXPluginManifestV2) => readonly T[] | undefined,
    ) =>
      enabled.flatMap((registered) => {
        const pluginId = registered.package.manifest.id;
        return (select(registered.package.manifest) ?? []).map((value) => ({
          ...structuredClone(value),
          key: `${pluginId}:${value.id}`,
          pluginId,
        }));
      });
    const bundles = enabled.flatMap((registered) => {
      const pluginId = registered.package.manifest.id;
      const manifest = registered.package.manifest;
      return (manifest.ui?.bundles ?? []).map((bundle) => ({
        ...structuredClone(bundle),
        key: `${pluginId}:${bundle.id}`,
        pluginId,
      }));
    });
    const surfaces = enabled.flatMap((registered) => {
      const pluginId = registered.package.manifest.id;
      const manifest = registered.package.manifest;
      return (manifest.ui?.surfaces ?? []).map((surface) => ({
        ...structuredClone(surface),
        key: `${pluginId}:${surface.id}`,
        pluginId,
      }));
    });
    return {
      plugins,
      bundles,
      surfaces,
      sidebar,
      pages,
      subroutes: project((manifest) => manifest.contributions?.subroutes),
      settings: project((manifest) => manifest.contributions?.settings),
      panels: project((manifest) => manifest.contributions?.panels),
      commands: project((manifest) => manifest.contributions?.commands),
      menus: project((manifest) => manifest.contributions?.menus),
      resultRenderers: project(
        (manifest) => manifest.contributions?.resultRenderers,
      ),
    };
  }

  diagnostics(): ZenXPluginDiagnostics {
    return {
      providerDiagnostics: structuredClone(this.#providerDiagnostics),
      discoveryErrors: [...this.#discoveryErrors],
    };
  }

  packageDescriptors(): Record<string, ZenXPluginPackageDescriptor> {
    return structuredClone(this.#packageDescriptors);
  }

  profileGeneration(): string | undefined {
    return this.#profileGeneration;
  }

  pluginCatalogAvailable(): boolean {
    return this.#catalogAvailable;
  }

  availablePlugins(): ZenXAvailablePlugin[] {
    return [...this.#registered.values()]
      .flatMap((registration) => {
        const manifest = registration.package.manifest;
        if (
          this.#disabled.has(manifest.id) ||
          this.#uninstalled.has(manifest.id) ||
          !this.#isProviderAvailable(manifest)
        ) {
          return [];
        }
        const tools = manifest.tools
          .filter((tool) => this.#isToolExposed(manifest.id, tool))
          .map(({ name, description, inputSchema }) => ({
            name,
            description,
            inputSchema: structuredClone(inputSchema),
          }));
        if (tools.length === 0) return [];
        return [
          {
            id: manifest.id,
            name: manifest.name,
            description: manifest.description,
            status: "enabled" as const,
            mainDocument: manifest.mainDocument,
            tools,
          },
        ];
      })
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  async setEnabled(capabilityId: string, enabled: boolean): Promise<void> {
    await this.#serializeConfigurationMutation(async () => {
      const supplied = this.#requireCapability(capabilityId);
      if (this.#uninstalled.has(capabilityId)) {
        throw new Error(`Plugin ${capabilityId} is uninstalled`);
      }
      if (enabled === !this.#disabled.has(capabilityId)) return;
      if (enabled) this.#validateRegistration(supplied.package.manifest);
      const runtimeStage = enabled
        ? await this.#stagePluginRuntime(supplied)
        : undefined;
      if (!enabled) {
        await this.#stopPluginRuntimeWithRollback(capabilityId, supplied);
      }
      const nextDisabled = new Set(this.#disabled);
      if (enabled) nextDisabled.delete(capabilityId);
      else nextDisabled.add(capabilityId);
      try {
        await this.#configurationStore.save(
          this.#configuration({ disabled: nextDisabled }),
        );
      } catch (error) {
        if (enabled) await runtimeStage?.rollback();
        else await this.#restorePluginRuntime(supplied);
        throw error;
      }
      const previousDisabled = this.#disabled;
      this.#disabled = nextDisabled;
      this.#emit();
      try {
        if (enabled) {
          runtimeStage?.publish();
          this.#activateRegistration(supplied);
        } else {
          const registered = this.#registered.get(capabilityId);
          if (registered !== undefined) {
            await this.#unregisterRegistration(capabilityId, registered, false);
          }
        }
      } catch (error) {
        await this.#configurationStore.save(
          this.#configuration({ disabled: previousDisabled }),
        );
        this.#disabled = previousDisabled;
        if (enabled) {
          await runtimeStage?.rollback();
        } else if (!this.#registered.has(capabilityId)) {
          this.#validateRegistration(supplied.package.manifest);
          await this.#restorePluginRuntime(supplied);
          this.#activateRegistration(supplied);
        }
        throw error;
      }
    });
  }

  hostSnapshot(): ZenXCapabilityHostSnapshot {
    const definitions: ModelTool[] = [];
    for (const registered of this.#registered.values()) {
      const manifest = registered.package.manifest;
      if (this.#disabled.has(manifest.id)) continue;
      if (!this.#isProviderAvailable(manifest)) continue;
      for (const tool of manifest.tools) {
        if (this.#isToolExposed(manifest.id, tool)) {
          definitions.push({
            name: tool.name,
            description: tool.description,
            inputSchema: structuredClone(tool.inputSchema),
          });
        }
      }
    }
    return { definitions, plugins: this.availablePlugins() };
  }

  setForegroundRequiredAllowed(allowed: boolean): void {
    if (allowed === this.#allowForegroundRequired) return;
    this.#allowForegroundRequired = allowed;
    this.#emit();
  }

  assertToolExposed(toolName: string): void {
    const owner = this.#toolOwners.get(toolName);
    if (owner === undefined) return;
    if (
      owner.tool.interactionMode === "foreground_required" &&
      !this.#allowForegroundRequired
    ) {
      throw new Error(
        `${toolName} is foreground_required; enable Foreground computer control in ZenX Settings before use`,
      );
    }
    if (!this.#isToolExposed(owner.capabilityId, owner.tool)) {
      throw new Error(`ZenX capability tool is unavailable: ${toolName}`);
    }
  }

  async readPluginUiHandle(
    pluginId: string,
    handleId: string,
  ): Promise<unknown> {
    await this.#configurationMutationTail;
    if (!this.#registered.has(pluginId) || this.#disabled.has(pluginId)) {
      throw new Error(`Plugin UI is not enabled: ${pluginId}`);
    }
    if (handleId !== `${pluginId}:context`) {
      throw new Error(`Unknown plugin UI handle: ${handleId}`);
    }
    return Object.freeze({ pluginId, lifecycle: "enabled" });
  }

  onChange(listener: (snapshot: ZenXPluginSnapshot) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async close(): Promise<void> {
    const failures: Error[] = [];
    for (const capabilityId of [...this.#registered.keys()]) {
      try {
        await this.unregister(capabilityId);
      } catch (error) {
        failures.push(asError(error));
      }
    }
    this.#catalogPackages.clear();
    if (failures.length > 0) {
      throw new AggregateError(failures, "Plugin Catalog shutdown failed");
    }
  }

  async resetTransient(): Promise<void> {
    this.#emit();
  }

  async #serializeConfigurationMutation<T>(
    mutation: () => Promise<T>,
  ): Promise<T> {
    const result = this.#configurationMutationTail.then(mutation);
    this.#configurationMutationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return await result;
  }

  async #stagePluginRuntime(
    registration: RegisteredZenXCapability,
    replaceCurrent = false,
  ): Promise<ZenXPluginRuntimeStage | undefined> {
    if (this.#options.pluginRuntimeLifecycle === undefined) {
      return undefined;
    }
    return await this.#options.pluginRuntimeLifecycle.stage(registration, {
      replaceCurrent,
    });
  }

  async #stopPluginRuntime(pluginId: string): Promise<void> {
    await this.#options.pluginRuntimeLifecycle?.stop(pluginId);
  }

  async #stopPluginRuntimeWithRollback(
    pluginId: string,
    registration: RegisteredZenXCapability,
  ): Promise<void> {
    try {
      await this.#stopPluginRuntime(pluginId);
    } catch (error) {
      await this.#restorePluginRuntime(registration);
      throw error;
    }
  }

  async #restorePluginRuntime(
    registration: RegisteredZenXCapability,
  ): Promise<void> {
    const stage = await this.#stagePluginRuntime(registration);
    try {
      stage?.publish();
    } catch (error) {
      await stage?.rollback();
      throw error;
    }
  }

  #isToolExposed(capabilityId: string, tool: ZenXCapabilityTool): boolean {
    return (
      !this.#disabled.has(capabilityId) &&
      this.#isProviderAvailable(
        this.#requireCapability(capabilityId).package.manifest,
      ) &&
      this.#isInteractionAllowed(tool.interactionMode)
    );
  }

  #isInteractionAllowed(mode: ZenXCapabilityInteractionMode): boolean {
    return mode !== "foreground_required" || this.#allowForegroundRequired;
  }

  #isProviderAvailable(manifest: ZenXPluginManifestV2): boolean {
    return (
      manifest.provider.platforms.includes(this.#options.platform) ||
      manifest.provider.platforms.includes("*")
    );
  }

  #requireCapability(capabilityId: string): RegisteredZenXCapability {
    const registered = this.#catalogPackages.get(capabilityId);
    if (registered === undefined) {
      throw new Error(`Unknown ZenX capability: ${capabilityId}`);
    }
    return registered;
  }

  #emit(): void {
    for (const listener of this.#listeners) {
      try {
        listener(this.pluginSnapshot());
      } catch (error) {
        console.warn(
          `ZenX Capability change listener failed after the mutation committed: ${summarize(
            describeError(error),
          )}`,
        );
      }
    }
  }

  #configuration(
    overrides: {
      disabled?: Set<string>;
      uninstalled?: Set<string>;
      packages?: Record<string, ZenXPluginPackageDescriptor>;
      profileGeneration?: string;
    } = {},
  ) {
    return {
      disabled: [...(overrides.disabled ?? this.#disabled)],
      uninstalled: [...(overrides.uninstalled ?? this.#uninstalled)],
      packages: structuredClone(overrides.packages ?? this.#packageDescriptors),
      ...((overrides.profileGeneration ?? this.#profileGeneration) === undefined
        ? {}
        : {
            profileGeneration:
              overrides.profileGeneration ?? this.#profileGeneration,
          }),
    };
  }
}

function enterCatalogCommit(options: {
  signal?: AbortSignal;
  enterCommitPhase?: () => void;
}): void {
  if (options.enterCommitPhase !== undefined) {
    options.enterCommitPhase();
    return;
  }
  options.signal?.throwIfAborted();
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function isProfileSource(value: unknown): value is ZenXPluginProfileSource {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    "mode" in value &&
    ["bundled", "npm", "git", "tarball", "local-copy", "dev-link"].includes(
      String(value.mode),
    ) &&
    "packageSpec" in value &&
    typeof value.packageSpec === "string" &&
    value.packageSpec.length > 0 &&
    "resolvedSpec" in value &&
    typeof value.resolvedSpec === "string" &&
    value.resolvedSpec.length > 0 &&
    "packageName" in value &&
    typeof value.packageName === "string" &&
    value.packageName.length > 0 &&
    "packageVersion" in value &&
    typeof value.packageVersion === "string" &&
    value.packageVersion.length > 0
  );
}

function validateManifest(
  manifest: ZenXPluginManifestV2,
): ZenXPluginManifestV2 {
  validatePublicPluginManifest(manifest);
  if (!/^[a-z][a-z0-9-]{1,62}$/u.test(manifest.id)) {
    throw new Error(`Invalid capability id: ${manifest.id}`);
  }
  const permissionIds = new Set(
    manifest.permissions.map((permission) => permission.id),
  );
  const pages = manifest.contributions?.pages ?? [];
  const pageIds = new Set<string>();
  const routeIds = new Set<string>();
  const surfaceIds = new Set(
    (manifest.ui?.surfaces ?? []).map((surface) => surface.id),
  );
  for (const page of pages) {
    if (
      typeof page.id !== "string" ||
      !isContributionId(page.id) ||
      pageIds.has(page.id)
    ) {
      throw new Error(
        `Capability ${manifest.id} has invalid or duplicate page ${page.id}`,
      );
    }
    if (
      typeof page.route !== "string" ||
      routeIds.has(page.route) ||
      !new RegExp(
        `^/plugins/${manifest.id}/[a-z][a-z0-9-]*(?:/[a-z][a-z0-9-]*)*$`,
        "u",
      ).test(page.route)
    ) {
      throw new Error(
        `Capability ${manifest.id} page ${page.id} must use a plugin route under /plugins/${manifest.id}/`,
      );
    }
    if (typeof page.title !== "string" || page.title.trim().length === 0) {
      throw new Error(`Capability ${manifest.id} page ${page.id} has no title`);
    }
    if (page.surfaceId !== undefined && !surfaceIds.has(page.surfaceId)) {
      throw new Error(
        `Capability ${manifest.id} page ${page.id} targets unknown UI surface ${page.surfaceId}`,
      );
    }
    pageIds.add(page.id);
    routeIds.add(page.route);
  }
  const subrouteIds = new Set<string>();
  for (const subroute of manifest.contributions?.subroutes ?? []) {
    if (
      !isContributionId(subroute.id) ||
      subrouteIds.has(subroute.id) ||
      !pageIds.has(subroute.pageId) ||
      routeIds.has(subroute.route) ||
      !new RegExp(
        `^/plugins/${manifest.id}/[a-z][a-z0-9-]*(?:/[a-z][a-z0-9-]*)+$`,
        "u",
      ).test(subroute.route) ||
      !surfaceIds.has(subroute.surfaceId ?? "") ||
      typeof subroute.title !== "string" ||
      subroute.title.trim().length === 0
    ) {
      throw new Error(
        `Capability ${manifest.id} has invalid or dangling subroute ${subroute.id}`,
      );
    }
    subrouteIds.add(subroute.id);
    routeIds.add(subroute.route);
  }
  const sidebarIds = new Set<string>();
  for (const contribution of manifest.contributions?.sidebar ?? []) {
    if (
      typeof contribution.id !== "string" ||
      !isContributionId(contribution.id) ||
      sidebarIds.has(contribution.id)
    ) {
      throw new Error(
        `Capability ${manifest.id} has invalid or duplicate sidebar contribution ${contribution.id}`,
      );
    }
    if (
      typeof contribution.pageId !== "string" ||
      !pageIds.has(contribution.pageId)
    ) {
      throw new Error(
        `Capability ${manifest.id} sidebar ${contribution.id} targets unknown page ${contribution.pageId}`,
      );
    }
    if (
      typeof contribution.label !== "string" ||
      contribution.label.trim().length === 0 ||
      !ZENX_PLUGIN_ICON_NAMES.includes(contribution.icon) ||
      (contribution.order !== undefined &&
        !Number.isSafeInteger(contribution.order))
    ) {
      throw new Error(
        `Capability ${manifest.id} sidebar ${contribution.id} has an invalid icon or metadata`,
      );
    }
    sidebarIds.add(contribution.id);
  }
  const validateSurfaceContributions = (
    kind: "settings" | "panel",
    values: readonly {
      id: string;
      title: string;
      surfaceId: string;
      order?: number;
    }[],
  ) => {
    const ids = new Set<string>();
    for (const value of values) {
      if (
        !isContributionId(value.id) ||
        ids.has(value.id) ||
        value.title.trim().length === 0 ||
        !surfaceIds.has(value.surfaceId) ||
        (value.order !== undefined && !Number.isSafeInteger(value.order))
      ) {
        throw new Error(
          `Capability ${manifest.id} has invalid or dangling ${kind} contribution ${value.id}`,
        );
      }
      ids.add(value.id);
    }
  };
  validateSurfaceContributions(
    "settings",
    manifest.contributions?.settings ?? [],
  );
  validateSurfaceContributions("panel", manifest.contributions?.panels ?? []);
  const commandIds = new Set<string>();
  for (const command of manifest.contributions?.commands ?? []) {
    if (
      !isContributionId(command.id) ||
      commandIds.has(command.id) ||
      command.title.trim().length === 0 ||
      !manifest.tools.some((tool) => tool.name === command.tool)
    ) {
      throw new Error(
        `Capability ${manifest.id} has invalid or dangling command ${command.id}`,
      );
    }
    commandIds.add(command.id);
  }
  const menuIds = new Set<string>();
  for (const menu of manifest.contributions?.menus ?? []) {
    if (
      !isContributionId(menu.id) ||
      menuIds.has(menu.id) ||
      menu.label.trim().length === 0 ||
      !commandIds.has(menu.commandId) ||
      !["page", "panel", "settings"].includes(menu.location) ||
      (menu.order !== undefined && !Number.isSafeInteger(menu.order))
    ) {
      throw new Error(
        `Capability ${manifest.id} has invalid or dangling menu ${menu.id}`,
      );
    }
    menuIds.add(menu.id);
  }
  const rendererIds = new Set<string>();
  const renderedContentTypes = new Set<string>();
  for (const renderer of manifest.contributions?.resultRenderers ?? []) {
    if (
      !isContributionId(renderer.id) ||
      rendererIds.has(renderer.id) ||
      !renderer.contentType.startsWith(`${manifest.id}/`) ||
      !/^[a-z][a-z0-9-]{1,62}\/[a-z][a-z0-9.-]{0,127}$/u.test(
        renderer.contentType,
      ) ||
      renderedContentTypes.has(renderer.contentType) ||
      !surfaceIds.has(renderer.surfaceId)
    ) {
      throw new Error(
        `Plugin ${manifest.id} has invalid, foreign, duplicate, or dangling result renderer ${renderer.id}`,
      );
    }
    rendererIds.add(renderer.id);
    renderedContentTypes.add(renderer.contentType);
  }
  if (permissionIds.size !== manifest.permissions.length) {
    throw new Error(`Capability ${manifest.id} has duplicate permissions`);
  }
  if (
    manifest.provider.id.length === 0 ||
    manifest.provider.platforms.length === 0 ||
    manifest.provider.interactionModes.length === 0
  ) {
    throw new Error(`Capability ${manifest.id} has invalid provider metadata`);
  }
  const toolNames = new Set<string>();
  for (const tool of manifest.tools) {
    if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/u.test(tool.name)) {
      throw new Error(`Invalid capability tool name: ${tool.name}`);
    }
    if (toolNames.has(tool.name)) {
      throw new Error(
        `Capability ${manifest.id} has duplicate tool ${tool.name}`,
      );
    }
    toolNames.add(tool.name);
    if (tool.capabilities.length === 0) {
      throw new Error(`Capability tool ${tool.name} declares no capabilities`);
    }
    if (
      tool.maxOutputBytes !== undefined &&
      (!Number.isSafeInteger(tool.maxOutputBytes) ||
        tool.maxOutputBytes < MIN_CAPABILITY_OUTPUT_BYTES ||
        tool.maxOutputBytes > MAX_CAPABILITY_OUTPUT_BYTES)
    ) {
      throw new Error(
        `Capability tool ${tool.name} maxOutputBytes must be an integer between ${String(MIN_CAPABILITY_OUTPUT_BYTES)} and ${String(MAX_CAPABILITY_OUTPUT_BYTES)}`,
      );
    }
    for (const permission of tool.permissions) {
      if (!permissionIds.has(permission)) {
        throw new Error(
          `Tool ${tool.name} requests unknown permission ${permission}`,
        );
      }
    }
  }
  return manifest;
}

function sameBundledAdoptionManifest(
  previous: ZenXPluginManifestV2,
  replacement: ZenXPluginManifestV2,
): boolean {
  if (
    previous.runtime.type !== "bundled" ||
    replacement.runtime.type !== "bundled"
  ) {
    return false;
  }
  if ((previous.storageVersion ?? 1) !== (replacement.storageVersion ?? 1)) {
    return false;
  }
  const comparable = (manifest: ZenXPluginManifestV2): unknown => {
    const { storageVersion: _storageVersion, runtime, ...identity } = manifest;
    return {
      ...identity,
      runtime: { ...runtime, entry: "<bundled-profile-entry>" },
    };
  };
  return isDeepStrictEqual(comparable(previous), comparable(replacement));
}

function isContributionId(value: string): boolean {
  return /^[a-z][a-z0-9-]{0,62}$/u.test(value);
}

function summarize(value: string): string {
  return value.length <= 512 ? value : `${value.slice(0, 509)}…`;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
