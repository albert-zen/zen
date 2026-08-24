import type { ZenXCapabilityPackage } from "./capabilities/types.js";
import type { ZenXTrustedProfilePluginLoader } from "./plugin-profile.js";

export const FIRST_PARTY_PLUGIN_PACKAGES = Object.freeze({
  browser: {
    pluginId: "browser",
    packageName: "@zenx/browser-plugin",
    tarball: "zenx-browser-plugin-electron-1.0.0.tgz",
  },
  computer: {
    pluginId: "computer",
    packageName: "@zenx/computer-plugin",
    tarball: "zenx-computer-plugin-macos-1.0.0.tgz",
  },
  selfControl: {
    pluginId: "zenx-self-control",
    packageName: "@zenx/self-control-plugin",
    tarball: "zenx-self-control-plugin-1.0.0.tgz",
  },
  triggers: {
    pluginId: "zenx-triggers",
    packageName: "@zenx/triggers-plugin",
    tarball: "zenx-triggers-plugin-1.0.0.tgz",
  },
});

export function firstPartyProviderTarball(
  pluginId: string,
  providerId: string,
): string {
  if (pluginId === "browser") {
    if (providerId === "electron-dedicated-browser")
      return "zenx-browser-plugin-electron-1.0.0.tgz";
    if (providerId === "playwright-cli")
      return "zenx-browser-plugin-playwright-1.0.0.tgz";
    if (providerId === "user-browser-cdp")
      return "zenx-browser-plugin-user-session-1.0.0.tgz";
  }
  if (pluginId === "computer") {
    if (providerId === "macos-desktop")
      return "zenx-computer-plugin-macos-1.0.0.tgz";
    if (providerId === "microsoft-winapp-cli")
      return "zenx-computer-plugin-win32-1.1.0.tgz";
    if (providerId === "peekaboo-cli")
      return "zenx-computer-plugin-peekaboo-1.0.0.tgz";
  }
  throw new Error(`No provider variant for ${pluginId}/${providerId}`);
}

export function createDelegatingFirstPartyProfileLoader(
  service: () => ZenXCapabilityPackage,
): ZenXTrustedProfilePluginLoader {
  return (module) => {
    // Capture the selected service for this runtime generation. Provider
    // replacement stages a different candidate without redirecting calls from
    // the still-published generation before the Catalog commit.
    const selectedService = service();
    const create = module["createZenXTrustedPlugin"];
    if (typeof create !== "function")
      throw new Error("Bundled first-party runtime factory is missing");
    const runtime = create({
      start: async (
        sdk: Parameters<NonNullable<ZenXCapabilityPackage["start"]>>[0],
      ) => await selectedService.start?.(sdk),
      invoke: async (
        toolName: string,
        invocation: {
          callId: string;
          arguments: Readonly<Record<string, unknown>>;
          cwd: string;
          signal: AbortSignal;
        },
      ) =>
        await selectedService.invoke(toolName, {
          ...invocation,
          name: toolName,
          arguments: { ...invocation.arguments },
        }),
      close: async () => await selectedService.close?.(),
    }) as unknown;
    if (
      typeof runtime !== "object" ||
      runtime === null ||
      typeof (runtime as { invoke?: unknown }).invoke !== "function"
    ) {
      throw new Error("Bundled first-party runtime factory is invalid");
    }
    return runtime as ReturnType<ZenXTrustedProfilePluginLoader>;
  };
}
