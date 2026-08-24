import type { ZenXAutomationControlPort } from "./capabilities/automation-control-package.js";
import type { ZenXTrustedProfilePluginLoader } from "./plugin-profile.js";

export const ZENX_ROOMS_PACKAGE_NAME = "@zenx/rooms-plugin";
export const ZENX_ROOMS_TARBALL = "zenx-rooms-plugin-1.0.0.tgz";

export function createZenXRoomsProfileLoader(
  service: () => ZenXAutomationControlPort,
): ZenXTrustedProfilePluginLoader {
  return (module) => {
    const create = module["createZenXTrustedPlugin"];
    if (typeof create !== "function") {
      throw new Error(
        "Bundled Rooms runtime does not export createZenXTrustedPlugin",
      );
    }
    const runtime = create(service()) as unknown;
    if (
      typeof runtime !== "object" ||
      runtime === null ||
      typeof (runtime as { invoke?: unknown }).invoke !== "function"
    ) {
      throw new Error("Bundled Rooms runtime factory is invalid");
    }
    return runtime as ReturnType<ZenXTrustedProfilePluginLoader>;
  };
}
