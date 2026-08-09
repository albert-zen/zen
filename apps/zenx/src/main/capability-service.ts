import path from "node:path";

import type { ToolInvocation } from "../../../../src/tool.js";
import {
  BrowserZenXCapabilityPackage,
  ElectronBrowserBackend,
  type ZenXBrowserBackend,
} from "./capabilities/browser-provider.js";
import {
  computerCapabilityManifest,
  ComputerZenXCapabilityPackage,
  ElectronMacComputerBackend,
  type ZenXComputerBackend,
} from "./capabilities/computer-provider.js";
import { JsonZenXCapabilityGrantStore } from "./capabilities/grant-store.js";
import { discoverLocalCapabilityPackages } from "./capabilities/local-package.js";
import { ZenXCapabilityRegistry } from "./capabilities/registry.js";
import type {
  ZenXCapabilityGrantStore,
  ZenXCapabilityHost,
  ZenXCapabilityHostSnapshot,
  ZenXCapabilityPackage,
  ZenXCapabilitySnapshot,
  ZenXCapabilityManifest,
} from "./capabilities/types.js";
import {
  windowsComputerCapabilityManifest,
  WinAppCliComputerBackend,
} from "./capabilities/windows-computer-provider.js";

export class ZenXCapabilityService implements ZenXCapabilityHost {
  readonly #registry: ZenXCapabilityRegistry;
  readonly #localDirectory: string;
  readonly #browserBackend: ZenXBrowserBackend;
  readonly #computerBackend: ZenXComputerBackend;
  readonly #computerManifest: ZenXCapabilityManifest;

  constructor(options: {
    userDataDirectory: string;
    grantStore?: ZenXCapabilityGrantStore;
    localDirectory?: string;
    browserBackend?: ZenXBrowserBackend;
    computerBackend?: ZenXComputerBackend;
    computerManifest?: ZenXCapabilityManifest;
  }) {
    this.#registry = new ZenXCapabilityRegistry(
      options.grantStore ??
        new JsonZenXCapabilityGrantStore(
          path.join(options.userDataDirectory, "capability-grants.json"),
        ),
    );
    this.#localDirectory =
      options.localDirectory ??
      path.join(options.userDataDirectory, "capabilities");
    this.#browserBackend =
      options.browserBackend ?? new ElectronBrowserBackend();
    const bundledComputer = defaultComputerProvider();
    this.#computerBackend = options.computerBackend ?? bundledComputer.backend;
    this.#computerManifest =
      options.computerManifest ??
      (options.computerBackend === undefined
        ? bundledComputer.manifest
        : computerCapabilityManifest);
  }

  async initialize(): Promise<void> {
    await this.#registry.initialize();
    this.#registry.register(
      new BrowserZenXCapabilityPackage(this.#browserBackend),
      "bundled",
    );
    this.#registry.register(
      new ComputerZenXCapabilityPackage(
        this.#computerBackend,
        this.#computerManifest,
      ),
      "bundled",
    );
    if (this.#computerBackend instanceof WinAppCliComputerBackend) {
      const diagnostic = await this.#computerBackend.diagnose();
      if (!diagnostic.ready) {
        this.#registry.recordDiscoveryError(
          `Windows computer provider: ${diagnostic.message}`,
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
    return this.#registry.snapshot();
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
    return this.#registry.onChange(listener);
  }

  async close(): Promise<void> {
    await this.#registry.close();
  }
}

function defaultComputerProvider(): {
  backend: ZenXComputerBackend;
  manifest: ZenXCapabilityManifest;
} {
  return process.platform === "win32"
    ? {
        backend: new WinAppCliComputerBackend(),
        manifest: windowsComputerCapabilityManifest,
      }
    : {
        backend: new ElectronMacComputerBackend(),
        manifest: computerCapabilityManifest,
      };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
