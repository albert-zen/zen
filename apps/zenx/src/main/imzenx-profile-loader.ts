import type { ImZenXHost } from "../../../../packages/zenx-imzenx-plugin/src/runtime.js";
import type { ZenXTrustedProfilePluginLoader } from "./plugin-profile.js";

export function createImZenXProfileLoader(
  host: ImZenXHost,
): ZenXTrustedProfilePluginLoader {
  return (module) => {
    const create = module["createZenXTrustedPlugin"];
    if (typeof create !== "function")
      throw new Error("IMZenX runtime factory is missing");
    return create(host) as ReturnType<ZenXTrustedProfilePluginLoader>;
  };
}
