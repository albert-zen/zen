import path from "node:path";

/** Only nonsecret deployment settings belong in plugin storage or tool results. */
export interface Configuration {
  pythonExecutable: string;
  channelsConfigFile: string;
  cwd: string;
  sharedFilesystemRoot?: string;
  permissionMode: "full-access" | "approval-required";
  allowUnrestrictedFullAccess: boolean;
}

export function configuration(
  value: unknown,
  defaultPermissionMode: Configuration["permissionMode"] = "full-access",
): Configuration {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("IMZenX configuration must be an object");
  const input = value as Record<string, unknown>;
  const fields = new Set([
    "pythonExecutable",
    "channelsConfigFile",
    "cwd",
    "sharedFilesystemRoot",
    "permissionMode",
    "allowUnrestrictedFullAccess",
  ]);
  if (Object.keys(input).some((key) => !fields.has(key)))
    throw new Error("IMZenX accepts only nonsecret connection settings");
  const absolute = (key: string) => {
    const candidate = input[key];
    if (
      typeof candidate !== "string" ||
      !path.isAbsolute(candidate) ||
      candidate.includes("\0")
    )
      throw new Error(`${key} must be an absolute path`);
    return candidate;
  };
  const permissionMode = input["permissionMode"] ?? defaultPermissionMode;
  if (
    permissionMode !== "full-access" &&
    permissionMode !== "approval-required"
  )
    throw new Error("Invalid permissionMode");
  const unrestricted = input["allowUnrestrictedFullAccess"] ?? false;
  if (typeof unrestricted !== "boolean")
    throw new Error("allowUnrestrictedFullAccess must be boolean");
  return {
    pythonExecutable: absolute("pythonExecutable"),
    channelsConfigFile: absolute("channelsConfigFile"),
    cwd: absolute("cwd"),
    ...(input["sharedFilesystemRoot"] === undefined ||
    input["sharedFilesystemRoot"] === ""
      ? {}
      : { sharedFilesystemRoot: absolute("sharedFilesystemRoot") }),
    permissionMode,
    allowUnrestrictedFullAccess: unrestricted,
  };
}
