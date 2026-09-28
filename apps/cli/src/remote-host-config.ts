import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { RemoteWorkspace } from "../../../src/protocol/native/remote-host.js";

export interface RemoteHostConfig {
  hostId: string;
  listen: string;
  port: number;
  tlsCertFile: string;
  tlsKeyFile: string;
  pairCodeFile: string;
  workspaces: RemoteWorkspace[];
}
/** This is an explicit isolated CLI Host opt-in, never the ZenX daily profile. */
export async function loadRemoteHostConfig(
  filename: string,
): Promise<RemoteHostConfig> {
  const configPath = path.resolve(filename);
  await privateFile(configPath);
  const value: unknown = JSON.parse(await readFile(configPath, "utf8"));
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("Remote Host config must be an object");
  const config = value as Record<string, unknown>;
  const string = (name: string): string => {
    const result = config[name];
    if (
      typeof result !== "string" ||
      result.trim().length === 0 ||
      result.length > 4096
    )
      throw new Error(`Remote Host ${name} is required`);
    return result;
  };
  const absolute = (name: string) => {
    const filename = string(name);
    if (!path.isAbsolute(filename))
      throw new Error(`Remote Host ${name} must be absolute`);
    return filename;
  };
  const workspaces = config.workspaces;
  if (
    !Array.isArray(workspaces) ||
    workspaces.length < 1 ||
    workspaces.length > 32
  )
    throw new Error("Remote Host requires configured workspaces");
  const entries: RemoteWorkspace[] = [];
  for (const entry of workspaces) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry))
      throw new Error("Invalid remote workspace");
    const row = entry as Record<string, unknown>;
    if (
      typeof row.id !== "string" ||
      !/^[a-zA-Z0-9_-]{1,64}$/u.test(row.id) ||
      typeof row.label !== "string" ||
      row.label.length < 1 ||
      row.label.length > 128 ||
      typeof row.cwd !== "string" ||
      !path.isAbsolute(row.cwd)
    )
      throw new Error(
        "Remote workspace id/label/cwd must be valid and cwd absolute",
      );
    const cwd = await realpath(row.cwd);
    if (
      entries.some((previous) => previous.id === row.id || previous.cwd === cwd)
    )
      throw new Error("Duplicate remote workspace");
    entries.push({ id: row.id, label: row.label, cwd });
  }
  const tlsKeyFile = absolute("tlsKeyFile");
  await privateFile(tlsKeyFile);
  const port = config.port;
  if (
    typeof port !== "number" ||
    !Number.isInteger(port) ||
    port < 0 ||
    port > 65535
  )
    throw new Error("Invalid remote port");
  return {
    hostId: string("hostId"),
    listen: string("listen"),
    port,
    tlsCertFile: absolute("tlsCertFile"),
    tlsKeyFile,
    pairCodeFile: absolute("pairCodeFile"),
    workspaces: entries,
  };
}
async function privateFile(filename: string): Promise<void> {
  const info = await stat(filename);
  if (
    !info.isFile() ||
    (process.platform !== "win32" && (info.mode & 0o077) !== 0)
  )
    throw new Error(
      "Remote Host configuration and TLS key must be private regular files",
    );
}
