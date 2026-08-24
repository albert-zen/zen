import { open } from "node:fs/promises";
import path from "node:path";

export interface ZenXPluginDevTargetDescriptor {
  version: 1;
  transport: "http";
  url: string;
  authentication: {
    type: "bearer-file";
    tokenFile: string;
  };
}

export interface ZenXPluginDevRequest {
  version: 1;
  projectDirectory: string;
  packageName: string;
  pluginId: string;
}

export interface ZenXPluginDevResult {
  version: 1;
  pluginId: string;
  packageName: string;
  generation: string;
  reload: { status: "reloaded" } | { status: "failed"; message: string };
}

export async function requestPluginDevLink(
  descriptorFile: string,
  request: ZenXPluginDevRequest,
): Promise<ZenXPluginDevResult> {
  const descriptor = await readPrivateJsonFile(
    path.resolve(descriptorFile),
    assertDevTargetDescriptor,
  );
  const token = (
    await readPrivateTextFile(descriptor.authentication.tokenFile)
  ).trim();
  if (token.length === 0 || token.includes("\n") || token.includes("\r")) {
    throw new Error("ZenX plugin dev bearer token is invalid");
  }
  const response = await fetch(new URL("/v1/plugins/dev", descriptor.url), {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(request),
  });
  const body = (await response.json()) as unknown;
  if (!response.ok) {
    const message =
      isRecord(body) && typeof body.message === "string"
        ? body.message
        : `ZenX plugin dev target returned HTTP ${String(response.status)}`;
    throw new Error(message);
  }
  assertDevResult(body);
  return body;
}

async function readPrivateTextFile(filePath: string): Promise<string> {
  if (!path.isAbsolute(filePath)) {
    throw new Error("ZenX plugin dev token path must be absolute");
  }
  const handle = await open(filePath, "r");
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new Error(`Not a regular file: ${filePath}`);
    if (process.platform !== "win32" && (metadata.mode & 0o044) !== 0) {
      throw new Error(
        `Private ZenX plugin dev file has unsafe permissions: ${filePath}`,
      );
    }
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

async function readPrivateJsonFile<T>(
  filePath: string,
  assertValue: (value: unknown) => asserts value is T,
): Promise<T> {
  const parsed = JSON.parse(await readPrivateTextFile(filePath)) as unknown;
  assertValue(parsed);
  return parsed;
}

function assertDevTargetDescriptor(
  value: unknown,
): asserts value is ZenXPluginDevTargetDescriptor {
  if (!isRecord(value) || !isRecord(value.authentication)) {
    throw new Error("Invalid ZenX plugin dev target descriptor");
  }
  if (
    value.version !== 1 ||
    value.transport !== "http" ||
    typeof value.url !== "string" ||
    value.authentication.type !== "bearer-file" ||
    typeof value.authentication.tokenFile !== "string"
  ) {
    throw new Error("Invalid ZenX plugin dev target descriptor");
  }
  const url = new URL(value.url);
  if (
    url.protocol !== "http:" ||
    (url.hostname !== "127.0.0.1" &&
      url.hostname !== "localhost" &&
      url.hostname !== "::1" &&
      url.hostname !== "[::1]")
  ) {
    throw new Error("ZenX plugin dev target must use loopback HTTP");
  }
  if (!path.isAbsolute(value.authentication.tokenFile)) {
    throw new Error("ZenX plugin dev token path must be absolute");
  }
}

function assertDevResult(value: unknown): asserts value is ZenXPluginDevResult {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    typeof value.pluginId !== "string" ||
    typeof value.packageName !== "string" ||
    typeof value.generation !== "string" ||
    !isRecord(value.reload) ||
    (value.reload.status !== "reloaded" &&
      !(
        value.reload.status === "failed" &&
        typeof value.reload.message === "string"
      ))
  ) {
    throw new Error("Invalid ZenX plugin dev target response");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
