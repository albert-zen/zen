import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { isIP } from "node:net";

export const DEFAULT_APP_SERVER_HOST = "127.0.0.1";
export const DEFAULT_APP_SERVER_PORT = 3000;

export type AppServerClientHandoff = {
  readonly baseUrl: string;
  readonly capability: string;
};

export function readAppServerPort(value: string | undefined): number {
  if (!value) {
    return DEFAULT_APP_SERVER_PORT;
  }

  const port = Number(value);

  if (Number.isInteger(port) && port >= 0 && port <= 65_535) {
    return port;
  }

  throw new Error("ZEN_APP_SERVER_PORT must be an integer from 0 to 65535");
}

export function readRemoteBindOptIn(
  value: string | undefined,
  variableName: string
): boolean {
  if (value === undefined || value === "0" || value === "false") {
    return false;
  }

  if (value === "1" || value === "true") {
    return true;
  }

  throw new Error(`${variableName} must be one of: 0, 1, false, true`);
}

export function assertLoopbackBindAllowed(
  host: string,
  allowRemoteBind: boolean,
  serverName: string
): void {
  if (!allowRemoteBind && !isLoopbackHost(host)) {
    throw new Error(`${serverName} binding requires explicit opt-in`);
  }
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.toLowerCase().replace(/^\[|\]$/gu, "");

  if (normalized === "localhost" || normalized === "::1") {
    return true;
  }

  if (isIP(normalized) === 4) {
    return normalized.startsWith("127.");
  }

  return normalized.startsWith("::ffff:127.");
}

export async function writeAppServerClientHandoff(
  path: string,
  handoff: AppServerClientHandoff
): Promise<void> {
  await writeFile(path, `${JSON.stringify(handoff)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600
  });
}

export async function consumeAppServerClientHandoff(
  path: string
): Promise<AppServerClientHandoff> {
  const claimedPath = `${path}.${process.pid}.${randomUUID()}.consuming`;
  await rename(path, claimedPath);

  try {
    const value = JSON.parse(await readFile(claimedPath, "utf8")) as unknown;

    if (
      typeof value !== "object" ||
      value === null ||
      !("baseUrl" in value) ||
      typeof value.baseUrl !== "string" ||
      !("capability" in value) ||
      typeof value.capability !== "string"
    ) {
      throw new Error("App Server client handoff is invalid");
    }

    new URL(value.baseUrl);
    return { baseUrl: value.baseUrl, capability: value.capability };
  } finally {
    await rm(claimedPath, { force: true });
  }
}
