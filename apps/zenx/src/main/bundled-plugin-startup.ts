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
  await isolateBundledPluginInstall(
    capabilities,
    ZENX_ROOMS_CAPABILITY_ID,
    async () => {
      const installedRooms = capabilities
        .pluginSnapshot()
        .plugins.find((plugin) => plugin.id === ZENX_ROOMS_CAPABILITY_ID);
      if (installedRooms?.profileSource !== undefined) return;
      await capabilities.installBundledPluginPackage(
        path.join(resourcesDirectory, "plugins", ZENX_ROOMS_TARBALL),
        {
          pluginId: ZENX_ROOMS_CAPABILITY_ID,
          packageName: ZENX_ROOMS_PACKAGE_NAME,
        },
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
        if (installed?.profileSource !== undefined) return;
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
        await capabilities.installBundledPluginPackage(
          path.join(resourcesDirectory, "plugins", tarball),
          {
            pluginId: definition.pluginId,
            packageName: definition.packageName,
          },
        );
      },
    );
  }
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
