import { randomBytes } from "node:crypto";
import { chmod, mkdir, open, rename, unlink } from "node:fs/promises";
import path from "node:path";

export interface ZenXConnectionDescriptor {
  version: 1;
  transport: "websocket";
  url: string;
  authentication: {
    type: "bearer-file";
    tokenFile: string;
  };
}

export async function publishZenXConnectionDescriptor(
  descriptorFile: string,
  descriptor: ZenXConnectionDescriptor,
): Promise<void> {
  assertZenXConnectionDescriptor(descriptor);
  await mkdir(path.dirname(descriptorFile), { recursive: true, mode: 0o700 });
  const temporaryFile = `${descriptorFile}.${String(process.pid)}.${randomBytes(8).toString("hex")}.tmp`;
  const temporary = await open(temporaryFile, "wx", 0o600);
  try {
    await temporary.writeFile(`${JSON.stringify(descriptor)}\n`, "utf8");
    await temporary.chmod(0o600);
    await temporary.sync();
  } finally {
    await temporary.close();
  }
  try {
    await rename(temporaryFile, descriptorFile);
    if (process.platform !== "win32") await chmod(descriptorFile, 0o600);
  } catch (error) {
    await removeFile(temporaryFile);
    throw error;
  }
}

export async function readZenXConnectionDescriptor(
  descriptorFile: string,
): Promise<ZenXConnectionDescriptor> {
  const handle = await open(descriptorFile, "r");
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) {
      throw new Error(
        `ZenX connection descriptor is not a regular file: ${descriptorFile}`,
      );
    }
    if (process.platform !== "win32" && (metadata.mode & 0o044) !== 0) {
      throw new Error(
        `ZenX connection descriptor is readable by group or others: ${descriptorFile}`,
      );
    }
    const descriptor = JSON.parse(await handle.readFile("utf8")) as unknown;
    assertZenXConnectionDescriptor(descriptor);
    return descriptor;
  } finally {
    await handle.close();
  }
}

export async function revokeZenXConnectionDescriptor(
  descriptorFile: string,
): Promise<void> {
  await removeFile(descriptorFile);
}

function assertZenXConnectionDescriptor(
  value: unknown,
): asserts value is ZenXConnectionDescriptor {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invalid ZenX connection descriptor");
  }
  const descriptor = value as Record<string, unknown>;
  const authentication = descriptor["authentication"];
  if (
    descriptor["version"] !== 1 ||
    descriptor["transport"] !== "websocket" ||
    typeof descriptor["url"] !== "string" ||
    typeof authentication !== "object" ||
    authentication === null ||
    Array.isArray(authentication) ||
    (authentication as Record<string, unknown>)["type"] !== "bearer-file" ||
    typeof (authentication as Record<string, unknown>)["tokenFile"] !== "string"
  ) {
    throw new Error("Invalid ZenX connection descriptor");
  }
  assertLoopbackWebSocket(descriptor["url"]);
  if (
    !path.isAbsolute(
      (authentication as Record<string, unknown>)["tokenFile"] as string,
    )
  ) {
    throw new Error("ZenX bearer token file must be an absolute path");
  }
}

function assertLoopbackWebSocket(rawUrl: string): void {
  const url = new URL(rawUrl);
  if (
    url.protocol !== "ws:" ||
    (url.hostname !== "127.0.0.1" &&
      url.hostname !== "localhost" &&
      url.hostname !== "::1" &&
      url.hostname !== "[::1]")
  ) {
    throw new Error(
      "ZenX descriptor must use an authenticated loopback WebSocket",
    );
  }
}

async function removeFile(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
