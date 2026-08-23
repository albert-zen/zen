import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import path from "node:path";

import type { ModelTool } from "../../../../../src/model.js";
import type {
  ToolExecutionResult,
  ToolInvocation,
} from "../../../../../src/tool.js";
import type {
  RegisteredZenXCapability,
  ZenXAvailablePlugin,
  ZenXCapabilityAuditRecord,
  ZenXCapabilityDisposer,
  ZenXCapabilityGrant,
  ZenXCapabilityConfigurationStore,
  ZenXCapabilityHost,
  ZenXCapabilityHostSnapshot,
  ZenXCapabilityManifest,
  ZenXCapabilityPackage,
  ZenXCapabilityProviderDiagnostic,
  ZenXCapabilitySnapshot,
  ZenXCapabilityScreenshotArtifact,
  ZenXCapabilityTool,
  ZenXCapabilityInteractionMode,
  ZenXPluginSnapshot,
  ZenXPluginSummary,
  ZenXPluginPackageDescriptor,
  ZenXPluginManifestV2,
  ZenXPluginRuntimeLifecycle,
  ZenXPluginRuntimeStage,
} from "./types.js";
import {
  MAX_CAPABILITY_OUTPUT_BYTES,
  MIN_CAPABILITY_OUTPUT_BYTES,
} from "./types.js";
import type { PluginDiscoveryCatalog } from "../plugin-discovery.js";

export const CAPABILITY_RESOURCE_TOOL = "zenx_capability_resource";
const DEFAULT_MAX_OUTPUT_BYTES = 16 * 1024;
const MAX_AUDIT_RECORDS = 100;

export interface ZenXCapabilityRegistryOptions {
  allowForegroundRequired: boolean;
  platform: string;
  pluginDataDirectory?: string;
  pluginRuntimeLifecycle?: ZenXPluginRuntimeLifecycle;
}

interface ActiveCapabilityInvocation {
  capabilityId: string;
  controller: AbortController;
  settled: Promise<void>;
  resolveSettled(): void;
}

export class ZenXCapabilityRegistry
  implements ZenXCapabilityHost, PluginDiscoveryCatalog
{
  readonly #configurationStore: ZenXCapabilityConfigurationStore;
  readonly #registered = new Map<string, RegisteredZenXCapability>();
  readonly #catalogPackages = new Map<string, RegisteredZenXCapability>();
  readonly #toolOwners = new Map<
    string,
    { capabilityId: string; tool: ZenXCapabilityTool }
  >();
  readonly #listeners = new Set<(snapshot: ZenXCapabilitySnapshot) => void>();
  readonly #audit: ZenXCapabilityAuditRecord[] = [];
  #currentScreenshot: ZenXCapabilityScreenshotArtifact | undefined;
  #browserProjectionSequence = 0;
  readonly #browserInvocationSequences = new Map<string, number>();
  readonly #providerDiagnostics: ZenXCapabilityProviderDiagnostic[] = [];
  readonly #discoveryErrors: string[] = [];
  readonly #options: ZenXCapabilityRegistryOptions;
  #grants: Record<string, ZenXCapabilityGrant[]> = {};
  #disabled = new Set<string>();
  #uninstalled = new Set<string>();
  #packageDescriptors: Record<string, ZenXPluginPackageDescriptor> = {};
  #configurationMutationTail: Promise<void> = Promise.resolve();
  readonly #activeInvocations = new Set<ActiveCapabilityInvocation>();

  constructor(
    configurationStore: ZenXCapabilityConfigurationStore,
    options: Partial<ZenXCapabilityRegistryOptions> = {},
  ) {
    this.#configurationStore = configurationStore;
    this.#options = {
      allowForegroundRequired: true,
      platform: process.platform,
      ...options,
    };
  }

  async initialize(): Promise<void> {
    const configuration = await this.#configurationStore.load();
    this.#grants = configuration.grants;
    this.#disabled = new Set(configuration.disabled);
    this.#uninstalled = new Set(configuration.uninstalled ?? []);
    this.#packageDescriptors = structuredClone(configuration.packages ?? {});
    for (const [pluginId, descriptor] of Object.entries(
      this.#packageDescriptors,
    )) {
      if (
        descriptor.manifest.id !== pluginId ||
        descriptor.manifest.schemaVersion !== 2 ||
        (descriptor.source !== "bundled" && descriptor.source !== "local")
      ) {
        throw new Error(
          `ZenX plugin catalog descriptor ${pluginId} is invalid`,
        );
      }
      validateManifest(descriptor.manifest);
    }
  }

  register(
    capabilityPackage: ZenXCapabilityPackage,
    source: "bundled" | "local" = "bundled",
  ): ZenXCapabilityDisposer {
    const manifest = validateManifest(capabilityPackage.manifest);
    if (
      manifest.schemaVersion === 2 &&
      this.#options.pluginRuntimeLifecycle !== undefined
    ) {
      throw new Error(
        `Plugin ${manifest.id} must use the asynchronous install lifecycle`,
      );
    }
    if (this.#catalogPackages.has(manifest.id)) {
      throw new Error(`Capability ${manifest.id} is already registered`);
    }
    const registration = { package: capabilityPackage, source } as const;
    this.#catalogPackages.set(manifest.id, registration);
    if (
      this.#uninstalled.has(manifest.id) ||
      (manifest.schemaVersion === 2 && this.#disabled.has(manifest.id))
    ) {
      return async () => {
        if (this.#catalogPackages.get(manifest.id) === registration) {
          this.#catalogPackages.delete(manifest.id);
        }
      };
    }
    try {
      this.#validateRegistration(manifest);
      this.#activateRegistration(registration);
    } catch (error) {
      this.#catalogPackages.delete(manifest.id);
      throw error;
    }
    let disposing: Promise<void> | undefined;
    return () => {
      disposing ??= this.#removeSuppliedPackage(manifest.id, registration);
      return disposing;
    };
  }

  async install(
    capabilityPackage: ZenXCapabilityPackage,
    source: "bundled" | "local" = "local",
  ): Promise<void> {
    await this.#serializeConfigurationMutation(async () => {
      const manifest = validateManifest(capabilityPackage.manifest);
      if (manifest.schemaVersion !== 2) {
        throw new Error(`Plugin install requires a manifest v2 package`);
      }
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
            await runtimeStage?.publish();
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
      } satisfies ZenXPluginPackageDescriptor;
      const nextPackages = {
        ...this.#packageDescriptors,
        [manifest.id]: descriptor,
      };
      const nextUninstalled = new Set(this.#uninstalled);
      nextUninstalled.delete(manifest.id);
      const previousConfiguration = this.#configuration();
      const shouldEnable = !this.#disabled.has(manifest.id);
      const runtimeStage = shouldEnable
        ? await this.#stagePluginRuntime(registration)
        : undefined;
      try {
        await this.#configurationStore.save(
          this.#configuration({
            packages: nextPackages,
            uninstalled: nextUninstalled,
          }),
        );
      } catch (error) {
        await runtimeStage?.rollback();
        throw error;
      }
      this.#packageDescriptors = nextPackages;
      this.#uninstalled = nextUninstalled;
      this.#catalogPackages.set(manifest.id, registration);
      try {
        if (shouldEnable) {
          await runtimeStage?.publish();
          this.#activateRegistration(registration);
        }
      } catch (error) {
        this.#catalogPackages.delete(manifest.id);
        this.#packageDescriptors = previousConfiguration.packages ?? {};
        this.#uninstalled = new Set(previousConfiguration.uninstalled ?? []);
        await runtimeStage?.rollback();
        await this.#configurationStore.save(previousConfiguration);
        throw error;
      }
    });
  }

  async uninstall(pluginId: string): Promise<void> {
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
        supplied?.package.manifest.schemaVersion === 2 &&
        !this.#disabled.has(pluginId);
      if (hadRuntime && supplied !== undefined) {
        await this.#stopPluginRuntimeWithRollback(pluginId, supplied);
      }
      const nextUninstalled = new Set(this.#uninstalled);
      nextUninstalled.add(pluginId);
      try {
        await this.#configurationStore.save(
          this.#configuration({ uninstalled: nextUninstalled }),
        );
      } catch (error) {
        if (hadRuntime && supplied !== undefined) {
          await this.#restorePluginRuntime(supplied);
        }
        throw error;
      }
      const previousUninstalled = this.#uninstalled;
      this.#uninstalled = nextUninstalled;
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
          await runtimeStage?.publish();
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

  async deleteData(pluginId: string): Promise<void> {
    if (!/^[a-z][a-z0-9-]{1,62}$/u.test(pluginId)) {
      throw new Error(`Invalid plugin id: ${pluginId}`);
    }
    if (this.#options.pluginDataDirectory === undefined) {
      throw new Error("Plugin data directory is not configured");
    }
    await rm(path.join(this.#options.pluginDataDirectory, pluginId), {
      recursive: true,
      force: true,
    });
  }

  async #removeSuppliedPackage(
    capabilityId: string,
    registration: RegisteredZenXCapability,
  ): Promise<void> {
    if (this.#catalogPackages.get(capabilityId) !== registration) return;
    this.#catalogPackages.delete(capabilityId);
    const active = this.#registered.get(capabilityId);
    if (active === registration) {
      await this.#unregisterRegistration(capabilityId, registration);
    }
  }

  #validateRegistration(manifest: ZenXCapabilityManifest): void {
    for (const tool of manifest.tools) {
      if (
        tool.name === CAPABILITY_RESOURCE_TOOL ||
        this.#toolOwners.has(tool.name)
      ) {
        throw new Error(`Capability tool ${tool.name} is already registered`);
      }
    }
    for (const route of [
      ...(manifest.contributions?.pages ?? []),
      ...(manifest.contributions?.subroutes ?? []),
    ]) {
      for (const registered of this.#registered.values()) {
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
    if (capabilityId === "browser") this.#clearBrowserProjection();
    for (const tool of registered.package.manifest.tools) {
      this.#toolOwners.delete(tool.name);
    }
    if (stopRuntime) await this.#stopPluginRuntime(capabilityId);
    await registered.package.close?.();
    this.#emit();
  }

  recordDiscoveryError(message: string): void {
    this.#discoveryErrors.push(message);
    this.#emit();
  }

  recordProviderDiagnostic(diagnostic: ZenXCapabilityProviderDiagnostic): void {
    if (
      diagnostic.capabilityId === "browser" &&
      diagnostic.status !== "selected"
    ) {
      this.#clearBrowserProjection();
    }
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

  async grant(
    capabilityId: string,
    permissionIds?: readonly string[],
  ): Promise<void> {
    await this.#serializeConfigurationMutation(async () => {
      const manifest = this.#requireCapability(capabilityId).package.manifest;
      const selected =
        permissionIds === undefined
          ? manifest.permissions
          : permissionIds.map((permissionId) => {
              const permission = manifest.permissions.find(
                (candidate) => candidate.id === permissionId,
              );
              if (permission === undefined) {
                throw new Error(
                  `Capability ${capabilityId} does not request ${permissionId}`,
                );
              }
              return permission;
            });
      const existing = new Map(
        (this.#grants[capabilityId] ?? []).map((grant) => [
          grant.permissionId,
          grant,
        ]),
      );
      for (const permission of selected) {
        existing.set(permission.id, {
          permissionId: permission.id,
          scope: permission.scope,
        });
      }
      const nextGrants = {
        ...this.#grants,
        [capabilityId]: [...existing.values()],
      };
      await this.#configurationStore.save({
        ...this.#configuration(),
        grants: structuredClone(nextGrants),
      });
      this.#grants = nextGrants;
      this.#emit();
    });
  }

  async revoke(
    capabilityId: string,
    permissionIds?: readonly string[],
  ): Promise<void> {
    await this.#serializeConfigurationMutation(async () => {
      this.#requireCapability(capabilityId);
      let nextGrants: Record<string, ZenXCapabilityGrant[]>;
      if (permissionIds === undefined) {
        const { [capabilityId]: _removed, ...remaining } = this.#grants;
        nextGrants = remaining;
      } else {
        const revoked = new Set(permissionIds);
        nextGrants = {
          ...this.#grants,
          [capabilityId]: (this.#grants[capabilityId] ?? []).filter(
            (grant) => !revoked.has(grant.permissionId),
          ),
        };
      }
      await this.#configurationStore.save({
        ...this.#configuration(),
        grants: structuredClone(nextGrants),
      });
      this.#grants = nextGrants;
      if (capabilityId === "browser") this.#clearBrowserProjection();
      this.#emit();
    });
  }

  snapshot(): ZenXCapabilitySnapshot {
    return {
      capabilities: [...this.#registered.values()].map((registered) => {
        const manifest = registered.package.manifest;
        return {
          manifest: {
            ...manifest,
            resources: manifest.resources.map(
              ({ content: _content, ...resource }) => resource,
            ),
          },
          source: registered.source,
          enabled: !this.#disabled.has(manifest.id),
          available: this.#isProviderAvailable(manifest),
          ...(this.#isProviderAvailable(manifest)
            ? {}
            : {
                unavailableReason: `Provider ${manifest.provider.id} does not support ${this.#options.platform}`,
              }),
          granted: structuredClone(this.#grants[manifest.id] ?? []),
          enabledTools: manifest.tools
            .filter((tool) => this.#isToolExposed(manifest.id, tool))
            .map((tool) => tool.name),
          blockedTools: this.#disabled.has(manifest.id)
            ? []
            : manifest.tools
                .filter(
                  (tool) =>
                    this.#hasPermissions(manifest.id, tool.permissions) &&
                    !this.#isInteractionAllowed(tool.interactionMode),
                )
                .map((tool) => tool.name),
        };
      }),
      recentInvocations: structuredClone(this.#audit),
      ...(this.#currentScreenshot === undefined
        ? {}
        : { currentScreenshot: structuredClone(this.#currentScreenshot) }),
      providerDiagnostics: structuredClone(this.#providerDiagnostics),
      discoveryErrors: [...this.#discoveryErrors],
    };
  }

  pluginSnapshot(): ZenXPluginSnapshot {
    const catalog = new Map<
      string,
      {
        manifest: ZenXCapabilityManifest;
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
        displayName: manifestName(manifest),
        version: manifest.version,
        source: entry.source,
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
          (manifest.contributions?.menus?.length ?? 0),
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
      select: (manifest: ZenXCapabilityManifest) => readonly T[] | undefined,
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
      return manifest.schemaVersion === 2
        ? (manifest.ui?.bundles ?? []).map((bundle) => ({
            ...structuredClone(bundle),
            key: `${pluginId}:${bundle.id}`,
            pluginId,
          }))
        : [];
    });
    const surfaces = enabled.flatMap((registered) => {
      const pluginId = registered.package.manifest.id;
      const manifest = registered.package.manifest;
      return manifest.schemaVersion === 2
        ? (manifest.ui?.surfaces ?? []).map((surface) => ({
            ...structuredClone(surface),
            key: `${pluginId}:${surface.id}`,
            pluginId,
          }))
        : [];
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
    };
  }

  availablePlugins(): ZenXAvailablePlugin[] {
    return [...this.#registered.values()]
      .flatMap((registration) => {
        const manifest = registration.package.manifest;
        if (
          manifest.schemaVersion !== 2 ||
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
      if (enabled && supplied.package.manifest.schemaVersion === 2) {
        this.#validateRegistration(supplied.package.manifest);
      }
      const runtimeStage =
        enabled && supplied.package.manifest.schemaVersion === 2
          ? await this.#stagePluginRuntime(supplied)
          : undefined;
      if (!enabled && supplied.package.manifest.schemaVersion === 2) {
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
      if (!enabled && capabilityId === "browser") {
        this.#clearBrowserProjection();
      }
      this.#emit();
      if (supplied.package.manifest.schemaVersion !== 2) {
        if (!enabled) await this.#cancelAndSettle(capabilityId);
        return;
      }
      try {
        if (enabled) {
          await runtimeStage?.publish();
          this.#activateRegistration(supplied);
        } else {
          await this.#cancelAndSettle(capabilityId);
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
    const resources: string[] = [];
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
      if (
        manifest.schemaVersion === 1 &&
        manifest.resources.length > 0 &&
        this.#hasPermissions(
          manifest.id,
          manifest.permissions.map((permission) => permission.id),
        )
      ) {
        resources.push(
          ...manifest.resources.map(
            (resource) =>
              `${manifest.id}/${resource.id} (${resource.kind}): ${resource.description}`,
          ),
        );
      }
    }
    if (resources.length > 0) {
      definitions.push({
        name: CAPABILITY_RESOURCE_TOOL,
        description: `Read an installed ZenX capability skill or prompt resource. Available resources: ${resources.join("; ")}`,
        inputSchema: {
          type: "object",
          properties: {
            capabilityId: { type: "string" },
            resourceId: { type: "string" },
          },
          required: ["capabilityId", "resourceId"],
          additionalProperties: false,
        },
      });
    }
    return { definitions, plugins: this.availablePlugins() };
  }

  async execute(invocation: ToolInvocation): Promise<ToolExecutionResult> {
    const configurationReady = this.#configurationMutationTail;
    await configurationReady;
    const audit = this.#startAudit(invocation);
    try {
      const output =
        invocation.name === CAPABILITY_RESOURCE_TOOL
          ? this.#readResource(invocation.arguments)
          : await this.#executeProvider(invocation);
      invocation.signal.throwIfAborted();
      const result = boundedResult(
        invocation.name,
        output.value,
        output.maxOutputBytes,
        output.capabilityId,
        output.provider,
        output.interactionMode,
        output.capabilities,
      );
      this.#finishAudit(audit, "completed", summarize(result));
      return { output: result, exitCode: 0 };
    } catch (error) {
      const cancelled = invocation.signal.aborted || isAbortError(error);
      const owner = this.#toolOwners.get(invocation.name);
      if (owner?.capabilityId === "browser") {
        this.#clearBrowserProjection(
          this.#browserInvocationSequences.get(invocation.callId),
        );
      }
      this.#finishAudit(
        audit,
        cancelled ? "cancelled" : "failed",
        describeError(error),
      );
      throw error;
    } finally {
      this.#browserInvocationSequences.delete(invocation.callId);
    }
  }

  async executePluginCommand(
    pluginId: string,
    commandId: string,
    input?: unknown,
  ): Promise<unknown> {
    await this.#configurationMutationTail;
    const registered = this.#registered.get(pluginId);
    if (
      registered === undefined ||
      this.#disabled.has(pluginId) ||
      this.#uninstalled.has(pluginId)
    ) {
      throw new Error(`Plugin UI is not enabled: ${pluginId}`);
    }
    const command = registered.package.manifest.contributions?.commands?.find(
      (candidate) => candidate.id === commandId,
    );
    if (command === undefined) {
      throw new Error(`Unknown plugin command: ${pluginId}:${commandId}`);
    }
    const result = await this.execute({
      callId: `ui-${randomUUID()}`,
      name: command.tool,
      arguments: {
        ...(command.input ?? {}),
        ...(input === undefined ? {} : { input: structuredClone(input) }),
      },
      cwd: process.cwd(),
      signal: new AbortController().signal,
    });
    return JSON.parse(result.output) as unknown;
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

  onChange(listener: (snapshot: ZenXCapabilitySnapshot) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async close(): Promise<void> {
    for (const capabilityId of [...this.#registered.keys()]) {
      await this.unregister(capabilityId);
    }
    this.#catalogPackages.clear();
  }

  async resetTransient(): Promise<void> {
    this.#clearBrowserProjection();
    this.#emit();
  }

  async #executeProvider(invocation: ToolInvocation): Promise<{
    value: unknown;
    maxOutputBytes: number;
    capabilityId: string;
    provider: { id: string; platforms: string[] };
    interactionMode: ZenXCapabilityInteractionMode;
    capabilities: string[];
  }> {
    const owner = this.#toolOwners.get(invocation.name);
    if (owner === undefined) {
      throw new Error(`Unsupported ZenX capability tool: ${invocation.name}`);
    }
    if (this.#disabled.has(owner.capabilityId)) {
      throw new Error(`Capability ${owner.capabilityId} is disabled`);
    }
    if (!this.#hasPermissions(owner.capabilityId, owner.tool.permissions)) {
      throw new Error(
        `Capability ${owner.capabilityId} is not granted for ${invocation.name}`,
      );
    }
    const registered = this.#requireCapability(owner.capabilityId);
    if (!this.#isProviderAvailable(registered.package.manifest)) {
      throw new Error(
        `Capability provider ${registered.package.manifest.provider.id} does not support ${this.#options.platform}`,
      );
    }
    if (!this.#isInteractionAllowed(owner.tool.interactionMode)) {
      throw new Error(
        `ZenX blocked ${invocation.name}: this operation is foreground_required and could move the global pointer, synthesize foreground keyboard input, or change app/workspace focus. This host is configured for background-safe execution only; granting capability permissions does not override that execution restriction.`,
      );
    }
    invocation.signal.throwIfAborted();
    const active = activeInvocation(owner.capabilityId);
    const forwardAbort = (): void => {
      active.controller.abort(invocation.signal.reason);
    };
    if (invocation.signal.aborted) forwardAbort();
    else
      invocation.signal.addEventListener("abort", forwardAbort, { once: true });
    this.#activeInvocations.add(active);
    try {
      const effectiveInvocation = {
        ...invocation,
        signal: active.controller.signal,
      };
      const value = await this.#invokeProvider(
        registered.package,
        effectiveInvocation,
      );
      effectiveInvocation.signal.throwIfAborted();
      return {
        value,
        maxOutputBytes: owner.tool.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
        capabilityId: owner.capabilityId,
        provider: {
          id: registered.package.manifest.provider.id,
          platforms: [...registered.package.manifest.provider.platforms],
        },
        interactionMode: owner.tool.interactionMode,
        capabilities: [...owner.tool.capabilities],
      };
    } catch (error) {
      active.controller.signal.throwIfAborted();
      throw error;
    } finally {
      invocation.signal.removeEventListener("abort", forwardAbort);
      this.#activeInvocations.delete(active);
      active.resolveSettled();
    }
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

  async #cancelAndSettle(capabilityId: string): Promise<void> {
    const active = [...this.#activeInvocations].filter(
      (invocation) => invocation.capabilityId === capabilityId,
    );
    for (const invocation of active) {
      invocation.controller.abort(
        new DOMException(
          `Capability ${capabilityId} is disabled`,
          "AbortError",
        ),
      );
    }
    await Promise.all(
      active.map(async (invocation) => await invocation.settled),
    );
  }

  async #stagePluginRuntime(
    registration: RegisteredZenXCapability,
  ): Promise<ZenXPluginRuntimeStage | undefined> {
    if (
      registration.package.manifest.schemaVersion !== 2 ||
      this.#options.pluginRuntimeLifecycle === undefined
    ) {
      return undefined;
    }
    return await this.#options.pluginRuntimeLifecycle.stage(registration);
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
      await stage?.publish();
    } catch (error) {
      await stage?.rollback();
      throw error;
    }
  }

  async #invokeProvider(
    capabilityPackage: ZenXCapabilityPackage,
    invocation: ToolInvocation,
  ): Promise<unknown> {
    const isBrowser = capabilityPackage.manifest.id === "browser";
    const sequence = isBrowser ? ++this.#browserProjectionSequence : undefined;
    if (isBrowser) {
      this.#currentScreenshot = undefined;
      this.#browserInvocationSequences.set(invocation.callId, sequence!);
    }
    try {
      const value = await capabilityPackage.invoke(invocation.name, invocation);
      if (isBrowser && sequence === this.#browserProjectionSequence) {
        invocation.signal.throwIfAborted();
        const screenshot = browserScreenshotFrom(value);
        if (screenshot !== undefined) this.#currentScreenshot = screenshot;
      }
      return value;
    } catch (error) {
      if (isBrowser && sequence === this.#browserProjectionSequence) {
        this.#currentScreenshot = undefined;
      }
      throw error;
    }
  }

  #clearBrowserProjection(sequence?: number): void {
    if (sequence !== undefined && sequence !== this.#browserProjectionSequence)
      return;
    this.#browserProjectionSequence += 1;
    this.#currentScreenshot = undefined;
  }

  #readResource(arguments_: Record<string, unknown>): {
    value: unknown;
    maxOutputBytes: number;
    capabilityId: string;
    provider: { id: string; platforms: string[] };
    interactionMode: ZenXCapabilityInteractionMode;
    capabilities: string[];
  } {
    const capabilityId = requiredString(arguments_, "capabilityId");
    const resourceId = requiredString(arguments_, "resourceId");
    const manifest = this.#requireCapability(capabilityId).package.manifest;
    if (this.#disabled.has(capabilityId)) {
      throw new Error(`Capability ${capabilityId} is disabled`);
    }
    if (!this.#isProviderAvailable(manifest)) {
      throw new Error(
        `Capability provider ${manifest.provider.id} does not support ${this.#options.platform}`,
      );
    }
    if (
      !this.#hasPermissions(
        capabilityId,
        manifest.permissions.map((permission) => permission.id),
      )
    ) {
      throw new Error(`Capability ${capabilityId} is not fully granted`);
    }
    const resource = manifest.resources.find(
      (candidate) => candidate.id === resourceId,
    );
    if (resource === undefined) {
      throw new Error(
        `Unknown capability resource ${capabilityId}/${resourceId}`,
      );
    }
    return {
      value: {
        capabilityId,
        resourceId,
        kind: resource.kind,
        title: resource.title,
        content: resource.content,
      },
      maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
      capabilityId,
      provider: {
        id: manifest.provider.id,
        platforms: [...manifest.provider.platforms],
      },
      interactionMode: "background_safe",
      capabilities: ["skill_prompt.read"],
    };
  }

  #isToolExposed(capabilityId: string, tool: ZenXCapabilityTool): boolean {
    return (
      !this.#disabled.has(capabilityId) &&
      this.#isProviderAvailable(
        this.#requireCapability(capabilityId).package.manifest,
      ) &&
      this.#hasPermissions(capabilityId, tool.permissions) &&
      this.#isInteractionAllowed(tool.interactionMode)
    );
  }

  #isInteractionAllowed(mode: ZenXCapabilityInteractionMode): boolean {
    return (
      mode !== "foreground_required" || this.#options.allowForegroundRequired
    );
  }

  #isProviderAvailable(manifest: ZenXCapabilityManifest): boolean {
    return (
      manifest.provider.platforms.includes(this.#options.platform) ||
      manifest.provider.platforms.includes("*")
    );
  }

  #hasPermissions(capabilityId: string, required: readonly string[]): boolean {
    const granted = new Set(
      (this.#grants[capabilityId] ?? []).map((grant) => grant.permissionId),
    );
    return required.every((permission) => granted.has(permission));
  }

  #requireCapability(capabilityId: string): RegisteredZenXCapability {
    const registered = this.#catalogPackages.get(capabilityId);
    if (registered === undefined) {
      throw new Error(`Unknown ZenX capability: ${capabilityId}`);
    }
    return registered;
  }

  #startAudit(invocation: ToolInvocation): ZenXCapabilityAuditRecord {
    const owner = this.#toolOwners.get(invocation.name);
    const record: ZenXCapabilityAuditRecord = {
      id: randomUUID(),
      capabilityId:
        invocation.name === CAPABILITY_RESOURCE_TOOL
          ? String(invocation.arguments.capabilityId ?? "unknown")
          : (owner?.capabilityId ?? "unknown"),
      providerId:
        owner === undefined
          ? invocation.name === CAPABILITY_RESOURCE_TOOL
            ? (this.#registered.get(
                String(invocation.arguments.capabilityId ?? "unknown"),
              )?.package.manifest.provider.id ?? "unknown")
            : "unknown"
          : (this.#registered.get(owner.capabilityId)?.package.manifest.provider
              .id ?? "unknown"),
      toolName: invocation.name,
      callId: invocation.callId,
      cwd: invocation.cwd,
      interactionMode:
        invocation.name === CAPABILITY_RESOURCE_TOOL
          ? "background_safe"
          : (owner?.tool.interactionMode ?? "background_safe"),
      startedAt: new Date().toISOString(),
      status: "running",
    };
    this.#audit.unshift(record);
    this.#audit.splice(MAX_AUDIT_RECORDS);
    this.#emit();
    return record;
  }

  #finishAudit(
    record: ZenXCapabilityAuditRecord,
    status: Exclude<ZenXCapabilityAuditRecord["status"], "running">,
    summary: string,
  ): void {
    record.status = status;
    record.completedAt = new Date().toISOString();
    record.summary = summarize(summary);
    this.#emit();
  }

  #emit(): void {
    for (const listener of this.#listeners) {
      try {
        listener(this.snapshot());
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
    } = {},
  ) {
    return {
      grants: structuredClone(this.#grants),
      disabled: [...(overrides.disabled ?? this.#disabled)],
      uninstalled: [...(overrides.uninstalled ?? this.#uninstalled)],
      packages: structuredClone(overrides.packages ?? this.#packageDescriptors),
    };
  }
}

function validateManifest(
  manifest: ZenXCapabilityManifest,
): ZenXCapabilityManifest {
  if (manifest.schemaVersion !== 1 && manifest.schemaVersion !== 2) {
    throw new Error(
      `Unsupported capability manifest version: ${String((manifest as { schemaVersion?: unknown }).schemaVersion)}`,
    );
  }
  if (manifest.schemaVersion === 2) validatePluginManifestV2(manifest);
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
    manifest.schemaVersion === 2
      ? (manifest.ui?.surfaces ?? []).map((surface) => surface.id)
      : [],
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
      typeof contribution.icon !== "string" ||
      contribution.icon.trim().length === 0 ||
      (contribution.order !== undefined &&
        !Number.isSafeInteger(contribution.order))
    ) {
      throw new Error(
        `Capability ${manifest.id} sidebar ${contribution.id} is invalid`,
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

function validatePluginManifestV2(manifest: ZenXPluginManifestV2): void {
  if (manifest.name.trim().length === 0) {
    throw new Error(`Plugin ${manifest.id} has no name`);
  }
  if (manifest.compatibility.zenx !== ">=0.1.0 <0.2.0") {
    throw new Error(
      `Plugin ${manifest.id} is incompatible with this ZenX host`,
    );
  }
  if (manifest.mainDocument.trim().length === 0) {
    throw new Error(`Plugin ${manifest.id} has no main document`);
  }
  if (manifest.description.trim().length === 0) {
    throw new Error(`Plugin ${manifest.id} has no short description`);
  }
  if (manifest.tools.length === 0) {
    throw new Error(`Plugin ${manifest.id} declares no tools`);
  }
  const toolPrefix = `${manifest.id.replaceAll("-", "_")}_`;
  for (const tool of manifest.tools) {
    if (!tool.name.startsWith(toolPrefix)) {
      throw new Error(
        `Plugin tool ${tool.name} must be namespaced with ${toolPrefix}`,
      );
    }
    if (
      typeof tool.description !== "string" ||
      tool.description.trim().length === 0
    ) {
      throw new Error(`Plugin tool ${tool.name} has no description`);
    }
    if (
      typeof tool.inputSchema !== "object" ||
      tool.inputSchema === null ||
      Array.isArray(tool.inputSchema)
    ) {
      throw new Error(`Plugin tool ${tool.name} has no input schema`);
    }
  }
  if (
    (manifest.runtime.type === "http"
      ? manifest.runtime.url
      : manifest.runtime.entry
    ).trim().length === 0
  ) {
    throw new Error(
      `Plugin ${manifest.id} has no runtime ${manifest.runtime.type === "http" ? "URL" : "entry"}`,
    );
  }
  const bundleIds = new Set<string>();
  for (const bundle of manifest.ui?.bundles ?? []) {
    if (
      !isContributionId(bundle.id) ||
      bundleIds.has(bundle.id) ||
      bundle.apiVersion !== 1 ||
      (bundle.kind !== "trusted" && bundle.kind !== "isolated") ||
      typeof bundle.entry !== "string" ||
      bundle.entry.trim().length === 0
    ) {
      throw new Error(
        `Plugin ${manifest.id} has invalid UI bundle ${bundle.id}`,
      );
    }
    bundleIds.add(bundle.id);
  }
  const surfaceIds = new Set<string>();
  for (const surface of manifest.ui?.surfaces ?? []) {
    if (
      !isContributionId(surface.id) ||
      surfaceIds.has(surface.id) ||
      !bundleIds.has(surface.bundleId) ||
      typeof surface.exportName !== "string" ||
      !isContributionId(surface.exportName)
    ) {
      throw new Error(
        `Plugin ${manifest.id} has invalid or dangling UI surface ${surface.id}`,
      );
    }
    surfaceIds.add(surface.id);
  }
}

function manifestName(manifest: ZenXCapabilityManifest): string {
  return manifest.schemaVersion === 2 ? manifest.name : manifest.displayName;
}

function isContributionId(value: string): boolean {
  return /^[a-z][a-z0-9-]{0,62}$/u.test(value);
}

function activeInvocation(capabilityId: string): ActiveCapabilityInvocation {
  let resolveSettled!: () => void;
  const settled = new Promise<void>((resolve) => {
    resolveSettled = resolve;
  });
  return {
    capabilityId,
    controller: new AbortController(),
    settled,
    resolveSettled,
  };
}

function boundedResult(
  toolName: string,
  value: unknown,
  maxBytes: number,
  capabilityId: string,
  provider: { id: string; platforms: readonly string[] },
  interactionMode: ZenXCapabilityInteractionMode,
  capabilities: readonly string[],
): string {
  const envelope = {
    capabilityId,
    provider,
    tool: toolName,
    interactionMode,
    capabilities,
    result: value,
  };
  const serialized = JSON.stringify(envelope);
  if (Buffer.byteLength(serialized, "utf8") <= maxBytes) return serialized;
  let preview = JSON.stringify(value);
  const truncated = (): string =>
    JSON.stringify({
      capabilityId,
      provider,
      tool: toolName,
      interactionMode,
      capabilities,
      resultPreview: preview,
      truncated: true,
      originalBytes: Buffer.byteLength(serialized, "utf8"),
    });
  let output = truncated();
  while (Buffer.byteLength(output, "utf8") > maxBytes && preview.length > 0) {
    const excess = Buffer.byteLength(output, "utf8") - maxBytes;
    preview = preview.slice(0, Math.max(0, preview.length - excess));
    output = truncated();
  }
  if (Buffer.byteLength(output, "utf8") <= maxBytes) return output;
  return JSON.stringify({
    tool: toolName.slice(0, 64),
    truncated: true,
    error: "Result metadata exceeded the configured output bound",
  });
}

function requiredString(value: Record<string, unknown>, key: string): string {
  const candidate = value[key];
  if (typeof candidate !== "string" || candidate.length === 0) {
    throw new Error(`${key} must be a non-empty string`);
  }
  return candidate;
}

function summarize(value: string): string {
  return value.length <= 512 ? value : `${value.slice(0, 509)}…`;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function browserScreenshotFrom(
  value: unknown,
): ZenXCapabilityScreenshotArtifact | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const screenshot = (value as Record<string, unknown>).screenshot;
  if (
    typeof screenshot !== "object" ||
    screenshot === null ||
    Array.isArray(screenshot)
  ) {
    return undefined;
  }
  const record = screenshot as Record<string, unknown>;
  if (
    typeof record.artifactPath !== "string" ||
    typeof record.width !== "number" ||
    typeof record.height !== "number" ||
    typeof record.bytes !== "number" ||
    typeof record.expiresAt !== "string" ||
    (record.status !== "captured" && record.status !== "fallback")
  ) {
    return undefined;
  }
  return {
    artifactPath: record.artifactPath,
    ...(typeof record.observationId === "string"
      ? { observationId: record.observationId }
      : {}),
    status: record.status,
    ...(typeof record.reason === "string" ? { reason: record.reason } : {}),
    width: record.width,
    height: record.height,
    bytes: record.bytes,
    expiresAt: record.expiresAt,
  };
}
