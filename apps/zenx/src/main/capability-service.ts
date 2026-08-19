import path from "node:path";

import type { ToolInvocation } from "../../../../src/tool.js";
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
  JsonZenXCapabilityContributionStore,
  type ZenXCapabilityContributionStore,
} from "./capabilities/contribution-store.js";
import { discoverLocalCapabilityPackages } from "./capabilities/local-package.js";
import { ZenXCapabilityRegistry } from "./capabilities/registry.js";
import {
  selectBrowserProvider,
  selectComputerProvider,
} from "./capabilities/provider-catalog.js";
import { WinAppCliComputerBackend } from "./capabilities/windows-computer-provider.js";
import type {
  ZenXCapabilityGrantStore,
  ZenXCapabilityHost,
  ZenXCapabilityHostSnapshot,
  ZenXCapabilityPackage,
  ZenXCapabilitySnapshot,
  ZenXCapabilityManifest,
  ZenXCapabilityUiContributionSummary,
} from "./capabilities/types.js";

export class ZenXCapabilityService implements ZenXCapabilityHost {
  readonly #registry: ZenXCapabilityRegistry;
  readonly #contributionStore: ZenXCapabilityContributionStore;
  readonly #userDataDirectory: string;
  readonly #localDirectory: string;
  readonly #browserBackend?: ZenXBrowserBackend;
  readonly #computerBackend?: ZenXComputerBackend;
  readonly #computerManifest?: ZenXCapabilityManifest;
  readonly #bundledProvidersOnly: boolean;
  readonly #resourcesDirectory?: string;
  readonly #bundledManifestSha256?: string;
  #computerRegistered = false;
  #contributionEnabled: Record<string, boolean> = {};
  readonly #listeners = new Set<(snapshot: ZenXCapabilitySnapshot) => void>();

  constructor(options: {
    userDataDirectory: string;
    grantStore?: ZenXCapabilityGrantStore;
    contributionStore?: ZenXCapabilityContributionStore;
    localDirectory?: string;
    browserBackend?: ZenXBrowserBackend;
    computerBackend?: ZenXComputerBackend;
    computerManifest?: ZenXCapabilityManifest;
    bundledProvidersOnly?: boolean;
    resourcesDirectory?: string;
    bundledManifestSha256?: string;
  }) {
    this.#registry = new ZenXCapabilityRegistry(
      options.grantStore ??
        new JsonZenXCapabilityGrantStore(
          path.join(options.userDataDirectory, "capability-grants.json"),
        ),
    );
    this.#contributionStore =
      options.contributionStore ??
      new JsonZenXCapabilityContributionStore(
        path.join(options.userDataDirectory, "ui-contributions.json"),
      );
    this.#registry.onChange(() => this.#emit());
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
  }

  async initialize(): Promise<void> {
    await this.#registry.initialize();
    this.#contributionEnabled = await this.#contributionStore.load();
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
      this.#registry.register(
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
    const discovered = await discoverLocalCapabilityPackages(
      this.#localDirectory,
    );
    for (const capabilityPackage of discovered.packages) {
      try {
        this.#registry.register(capabilityPackage, "local");
      } catch (error) {
        this.#registry.recordDiscoveryError(describeError(error));
      }
    }
    for (const error of discovered.errors) {
      this.#registry.recordDiscoveryError(error);
    }
  }

  snapshot(): ZenXCapabilitySnapshot {
    const snapshot = this.#registry.snapshot();
    return {
      ...snapshot,
      contributions: projectUiContributions(
        snapshot,
        this.#contributionEnabled,
      ),
    };
  }

  async setContributionEnabled(
    capabilityId: string,
    contributionId: string,
    enabled: boolean,
  ): Promise<ZenXCapabilitySnapshot> {
    const key = contributionKey(capabilityId, contributionId);
    const exists = this.snapshot().contributions.some(
      (contribution) =>
        contribution.capabilityId === capabilityId &&
        contribution.id === contributionId,
    );
    if (!exists) throw new Error(`Unknown ZenX UI contribution: ${key}`);
    this.#contributionEnabled = { ...this.#contributionEnabled, [key]: enabled };
    await this.#contributionStore.save(this.#contributionEnabled);
    this.#emit();
    return this.snapshot();
  }

  register(
    capabilityPackage: ZenXCapabilityPackage,
    source: "bundled" | "local" = "bundled",
  ): void {
    this.#registry.register(capabilityPackage, source);
  }

  async unregister(capabilityId: string): Promise<void> {
    await this.#registry.unregister(capabilityId);
  }

  async resetTransient(): Promise<void> {
    await this.#registry.resetTransient();
    if (
      this.#browserBackend !== undefined ||
      this.#computerBackend !== undefined
    ) {
      return;
    }
    await this.#registry.unregister("browser");
    await this.#registry.unregister("computer");
    this.#computerRegistered = false;
    const browser = await selectBrowserProvider({
      userDataDirectory: this.#userDataDirectory,
      bundledProvidersOnly: this.#bundledProvidersOnly,
      resourcesDirectory: this.#resourcesDirectory,
      bundledManifestSha256: this.#bundledManifestSha256,
    });
    if (browser.backend !== undefined) {
      this.#registry.register(
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
    const computer = await selectComputerProvider({
      userDataDirectory: this.#userDataDirectory,
      bundledProvidersOnly: this.#bundledProvidersOnly,
      resourcesDirectory: this.#resourcesDirectory,
      bundledManifestSha256: this.#bundledManifestSha256,
    });
    if (computer.backend !== undefined) {
      this.#registry.register(
        new ComputerZenXCapabilityPackage(computer.backend, computer.manifest),
        "bundled",
      );
      this.#computerRegistered = true;
    }
    for (const diagnostic of computer.diagnostics) {
      this.#registry.recordProviderDiagnostic(diagnostic);
    }
  }

  hostSnapshot(): ZenXCapabilityHostSnapshot {
    return this.#registry.hostSnapshot();
  }

  async execute(invocation: ToolInvocation) {
    return await this.#registry.execute(invocation);
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

  onChange(listener: (snapshot: ZenXCapabilitySnapshot) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async close(): Promise<void> {
    await this.#registry.close();
    if (!this.#computerRegistered) await this.#computerBackend?.close();
  }

  #emit(): void {
    const snapshot = this.snapshot();
    for (const listener of this.#listeners) listener(snapshot);
  }
}

export function projectUiContributions(
  snapshot: Pick<ZenXCapabilitySnapshot, "capabilities">,
  enabled: Readonly<Record<string, boolean>>,
): ZenXCapabilityUiContributionSummary[] {
  return snapshot.capabilities
    .flatMap((capability) =>
      (capability.manifest.ui?.contributions ?? []).map((contribution) => ({
        ...contribution,
        capabilityId: capability.manifest.id,
        available: capability.available,
        enabled:
          enabled[contributionKey(capability.manifest.id, contribution.id)] ??
          true,
      })),
    )
    .sort(
      (left, right) =>
        left.order - right.order || left.id.localeCompare(right.id),
    );
}

function contributionKey(capabilityId: string, contributionId: string): string {
  return `${capabilityId}:${contributionId}`;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
