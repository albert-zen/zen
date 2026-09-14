import { createHash } from "node:crypto";
import { access, readFile, stat } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { RTK_EXPERIMENT_SHA256 } from "../../../../src/shell-output-filter.js";

export interface RtkAvailability {
  available: boolean;
  reason?: string;
}

/** Only the fixed, application-owned resource can enable the experiment. */
export async function inspectRtkResource(
  resourcesDirectory: string | undefined,
  platform = process.platform,
  architecture = process.arch,
): Promise<RtkAvailability> {
  if (platform !== "darwin" || architecture !== "arm64")
    return {
      available: false,
      reason: "Available on Apple silicon Macs only.",
    };
  if (resourcesDirectory === undefined)
    return { available: false, reason: "RTK is not included in this build." };
  const executable = rtkExecutable(resourcesDirectory);
  try {
    const info = await stat(executable);
    if (!info.isFile() || info.size > 128 * 1024 * 1024)
      throw new Error("invalid resource");
    await access(executable, constants.X_OK);
    if (
      createHash("sha256")
        .update(await readFile(executable))
        .digest("hex") !== RTK_EXPERIMENT_SHA256
    )
      return {
        available: false,
        reason:
          "The bundled RTK could not be verified. Use a verified ZenX build.",
      };
    return { available: true };
  } catch {
    return {
      available: false,
      reason: "RTK is missing or cannot be read in this build.",
    };
  }
}

export function rtkExecutable(resourcesDirectory: string): string {
  return path.resolve(resourcesDirectory, "rtk", "rtk");
}
