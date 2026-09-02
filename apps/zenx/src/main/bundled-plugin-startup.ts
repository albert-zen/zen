import { realpath } from "node:fs/promises";
import path from "node:path";

import type { ZenXCapabilityService } from "./capability-service.js";
import { ZENX_ROOMS_CAPABILITY_ID } from "./capabilities/automation-control-package.js";
import {
  FIRST_PARTY_PLUGIN_PACKAGES,
  firstPartyProviderTarball,
} from "./first-party-profile-loader.js";
import {
  ZENX_ROOMS_PACKAGE_NAME,
  ZENX_ROOMS_TARBALL,
} from "./rooms-profile-loader.js";

export async function installZenXBundledPluginsAtStartup(
  capabilities: ZenXCapabilityService,
  resourcesDirectory: string,
): Promise<void> {
  // Do not resurrect bundled plugins while the persisted catalog is
  // unreadable: its disabled/uninstalled choices are unknown. The core host
  // remains available and the user can repair or reinstall from Settings.
  if (!capabilities.pluginCatalogAvailable()) return;
  await isolateBundledPluginInstall(
    capabilities,
    ZENX_ROOMS_CAPABILITY_ID,
    async () => {
      const installedRooms = capabilities
        .pluginSnapshot()
        .plugins.find((plugin) => plugin.id === ZENX_ROOMS_CAPABILITY_ID);
      const tarballPath = path.join(
        resourcesDirectory,
        "plugins",
        ZENX_ROOMS_TARBALL,
      );
      const action = await bundledPluginStartupAction(
        installedRooms,
        tarballPath,
      );
      if (action === "skip") return;
      await capabilities.installBundledPluginPackage(
        tarballPath,
        {
          pluginId: ZENX_ROOMS_CAPABILITY_ID,
          packageName: ZENX_ROOMS_PACKAGE_NAME,
        },
        { allowSameVersionBundledVariant: action === "repair" },
      );
    },
  );
  for (const definition of [
    FIRST_PARTY_PLUGIN_PACKAGES.browser,
    FIRST_PARTY_PLUGIN_PACKAGES.computer,
    FIRST_PARTY_PLUGIN_PACKAGES.selfControl,
    FIRST_PARTY_PLUGIN_PACKAGES.triggers,
  ]) {
    await isolateBundledPluginInstall(
      capabilities,
      definition.pluginId,
      async () => {
        if (
          definition.pluginId === "computer" &&
          providerUnavailable(() => capabilities.computerProfilePackage())
        )
          return;
        if (
          definition.pluginId === "browser" &&
          providerUnavailable(() => capabilities.browserProfilePackage())
        )
          return;
        const installed = capabilities
          .pluginSnapshot()
          .plugins.find((plugin) => plugin.id === definition.pluginId);
        const tarball =
          definition.pluginId === "browser"
            ? firstPartyProviderTarball(
                "browser",
                capabilities.browserProfilePackage().manifest.provider.id,
              )
            : definition.pluginId === "computer"
              ? firstPartyProviderTarball(
                  "computer",
                  capabilities.computerProfilePackage().manifest.provider.id,
                )
              : definition.tarball;
        const tarballPath = path.join(resourcesDirectory, "plugins", tarball);
        const action = await bundledPluginStartupAction(installed, tarballPath);
        if (action === "skip") return;
        await capabilities.installBundledPluginPackage(
          tarballPath,
          {
            pluginId: definition.pluginId,
            packageName: definition.packageName,
          },
          { allowSameVersionBundledVariant: action === "repair" },
        );
      },
    );
  }
}

type BundledPluginStartupAction = "skip" | "install" | "repair";

async function bundledPluginStartupAction(
  installed:
    | ReturnType<ZenXCapabilityService["pluginSnapshot"]>["plugins"][number]
    | undefined,
  tarballPath: string,
): Promise<BundledPluginStartupAction> {
  // An explicit uninstall is user intent; startup must not resurrect it.
  if (installed?.lifecycle === "uninstalled") return "skip";
  const source = installed?.profileSource;
  if (source === undefined) return "install";
  // A non-bundled source is a user-selected override and must be preserved.
  if (source.mode !== "bundled") return "skip";
  try {
    if ((await realpath(tarballPath)) === source.packageSpec) return "skip";
  } catch {
    // Let the normal install path report a missing App Resource package.
  }
  return "repair";
}

async function isolateBundledPluginInstall(
  capabilities: ZenXCapabilityService,
  pluginId: string,
  install: () => Promise<void>,
): Promise<void> {
  try {
    await install();
  } catch (error) {
    capabilities.recordBundledPluginStartupError(pluginId, error);
  }
}

function providerUnavailable(resolve: () => unknown): boolean {
  try {
    resolve();
    return false;
  } catch {
    return true;
  }
}
