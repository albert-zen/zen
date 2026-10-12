import { lstat, readFile, realpath } from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";
import { RemoteGrantFile } from "../../../src/protocol/native/remote-grants.js";
import type { RemoteWorkspace } from "../../../src/protocol/native/remote-host.js";
import { originAuthority } from "../../../src/protocol/native/remote-transport.js";

/** Foreground Fleet Host configuration, separate from the isolated fake fixture. */
export interface FleetHeadlessConfig {
  enabled: true;
  hostId: string;
  bindAddress: string;
  port: number;
  tlsCertificateFile: string;
  tlsKeyFile: string;
  grantFile: string;
  pairCodeFile: string;
  access: "read" | "control";
  shellEnabled: boolean;
  originEndpoint?: string;
  workspaces: RemoteWorkspace[];
}

export async function loadFleetHeadlessConfig(
  filename: string,
): Promise<FleetHeadlessConfig> {
  const configPath = path.resolve(filename);
  await assertPrivateFleetPath(configPath, "file");
  const info = await lstat(configPath);
  if (info.size > 256 * 1024) throw new Error("Fleet Host config is too large");
  const value: unknown = JSON.parse(await readFile(configPath, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Fleet Host config must be an object");
  const c = value as Record<string, unknown>;
  const known = new Set([
    "enabled",
    "hostId",
    "bindAddress",
    "port",
    "tlsCertificateFile",
    "tlsKeyFile",
    "grantFile",
    "pairCodeFile",
    "access",
    "shellEnabled",
    "originEndpoint",
    "workspaces",
  ]);
  for (const key of Object.keys(c))
    if (!known.has(key))
      throw new Error(`Unknown Fleet Host config field: ${key}`);
  if (c.enabled !== true)
    throw new Error("Fleet Host config requires enabled: true");
  const string = (name: string): string => {
    const v = c[name];
    if (typeof v !== "string" || !v.trim() || v.length > 4096)
      throw new Error(`Fleet Host ${name} is required`);
    return v;
  };
  const absolute = (name: string): string => {
    const v = string(name);
    if (!path.isAbsolute(v))
      throw new Error(`Fleet Host ${name} must be absolute`);
    return path.normalize(v);
  };
  const hostId = string("hostId");
  if (!/^[a-zA-Z0-9_-]{1,128}$/u.test(hostId))
    throw new Error("Fleet Host requires a stable alphanumeric hostId");
  const bindAddress = string("bindAddress");
  if (isIP(bindAddress) === 0)
    throw new Error("Fleet Host bindAddress must be an explicit IP address");
  const port = c.port;
  if (
    typeof port !== "number" ||
    !Number.isInteger(port) ||
    port < 0 ||
    port > 65535
  )
    throw new Error("Fleet Host requires an explicit port from 0 to 65535");
  if (c.access !== "read" && c.access !== "control")
    throw new Error("Fleet Host access must be read or control");
  if (c.shellEnabled !== undefined && typeof c.shellEnabled !== "boolean")
    throw new Error("Fleet Host shellEnabled must be a boolean");
  if (c.shellEnabled === true && c.access !== "control")
    throw new Error("Fleet Host shellEnabled requires control access");
  if (
    !Array.isArray(c.workspaces) ||
    c.workspaces.length < 1 ||
    c.workspaces.length > 32
  )
    throw new Error("Fleet Host requires a nonempty workspace allowlist");
  const workspaces: RemoteWorkspace[] = [];
  for (const value of c.workspaces) {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("Invalid Fleet Host workspace");
    const w = value as Record<string, unknown>;
    if (
      typeof w.id !== "string" ||
      !/^[a-zA-Z0-9_-]{1,64}$/u.test(w.id) ||
      typeof w.label !== "string" ||
      !w.label.trim() ||
      w.label.length > 128 ||
      typeof w.cwd !== "string" ||
      !path.isAbsolute(w.cwd)
    )
      throw new Error("Fleet workspace requires id, label and absolute cwd");
    const cwd = await realpath(w.cwd);
    if (!(await lstat(cwd)).isDirectory())
      throw new Error("Fleet workspace cwd must be a directory");
    if (workspaces.some((entry) => entry.id === w.id || entry.cwd === cwd))
      throw new Error("Duplicate Fleet workspace");
    workspaces.push({ id: w.id, label: w.label, cwd });
  }
  const tlsCertificateFile = absolute("tlsCertificateFile");
  const tlsKeyFile = absolute("tlsKeyFile");
  const grantFile = absolute("grantFile");
  const pairCodeFile = absolute("pairCodeFile");
  if (
    new Set([
      configPath,
      tlsCertificateFile,
      tlsKeyFile,
      grantFile,
      pairCodeFile,
    ]).size !== 5
  )
    throw new Error(
      "Fleet Host config, TLS and authorization paths must be distinct",
    );
  if (!(await lstat(tlsCertificateFile)).isFile())
    throw new Error("Fleet TLS certificate must be a regular file");
  await assertPrivateFleetPath(tlsKeyFile, "file");
  for (const file of [grantFile, pairCodeFile])
    await assertPrivateFleetPath(path.dirname(file), "directory");
  try {
    await assertPrivateFleetPath(grantFile, "file");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  // Existing authorization must be readable and match this stable Host before binding.
  new RemoteGrantFile(grantFile, hostId).read();
  let originEndpoint: string | undefined;
  if (c.originEndpoint !== undefined) {
    originEndpoint = string("originEndpoint");
    if (originAuthority(originEndpoint).port !== port)
      throw new Error("Fleet Origin endpoint port must equal the bound port");
  }
  return {
    enabled: true,
    hostId,
    bindAddress,
    port,
    tlsCertificateFile,
    tlsKeyFile,
    grantFile,
    pairCodeFile,
    access: c.access,
    shellEnabled: c.shellEnabled === true,
    ...(originEndpoint === undefined ? {} : { originEndpoint }),
    workspaces,
  };
}

/** No symlinked or shared writable location for Host authority material. */
export async function assertPrivateFleetPath(
  filename: string,
  kind: "file" | "directory",
): Promise<void> {
  if (process.platform === "win32")
    throw new Error(
      "Production headless Fleet requires POSIX private-file validation; Windows ACL validation is not implemented",
    );
  const info = await lstat(filename);
  if (
    (kind === "file" ? !info.isFile() : !info.isDirectory()) ||
    (info.mode & 0o077) !== 0 ||
    info.uid !== process.getuid?.() ||
    (await realpath(filename)) !== path.resolve(filename)
  )
    throw new Error(
      `Fleet Host requires an owned private regular ${kind}: ${filename}`,
    );
}
