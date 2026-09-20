import { execFile } from "node:child_process";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import {
  ZENX_CHROME_EXTENSION_ORIGIN,
  ZENX_CHROME_NATIVE_HOST_NAME,
} from "./chrome-extension-bridge.js";

const run = promisify(execFile);

export interface ChromeNativeHostRegistrationOptions {
  platform: NodeJS.Platform;
  homeDirectory: string;
  runtimeDirectory: string;
  executablePath: string;
  windowsLauncherPath?: string;
}

export function chromeNativeHostExecutablePath(
  options: ChromeNativeHostRegistrationOptions,
): string {
  if (options.platform !== "win32") return path.resolve(options.executablePath);
  if (options.windowsLauncherPath === undefined) {
    throw new Error("Packaged ZenX Chrome native host launcher is missing");
  }
  return path.resolve(options.windowsLauncherPath);
}

export function chromeNativeHostManifestPath(
  options: ChromeNativeHostRegistrationOptions,
): string {
  if (options.platform === "darwin") {
    return path.join(
      options.homeDirectory,
      "Library",
      "Application Support",
      "Google",
      "Chrome",
      "NativeMessagingHosts",
      `${ZENX_CHROME_NATIVE_HOST_NAME}.json`,
    );
  }
  if (options.platform === "linux") {
    return path.join(
      options.homeDirectory,
      ".config",
      "google-chrome",
      "NativeMessagingHosts",
      `${ZENX_CHROME_NATIVE_HOST_NAME}.json`,
    );
  }
  if (options.platform === "win32") {
    return path.join(
      options.runtimeDirectory,
      `${ZENX_CHROME_NATIVE_HOST_NAME}.json`,
    );
  }
  throw new Error(
    `Chrome native messaging is unsupported on ${options.platform}`,
  );
}

export async function registerChromeNativeHost(
  options: ChromeNativeHostRegistrationOptions,
): Promise<string> {
  const manifestFile = chromeNativeHostManifestPath(options);
  const manifest = {
    name: ZENX_CHROME_NATIVE_HOST_NAME,
    description: "ZenX bridge for one explicitly selected Chrome tab",
    path: chromeNativeHostExecutablePath(options),
    type: "stdio",
    allowed_origins: [ZENX_CHROME_EXTENSION_ORIGIN],
  };
  await mkdir(path.dirname(manifestFile), { recursive: true, mode: 0o700 });
  const temporary = `${manifestFile}.${String(process.pid)}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, {
      mode: 0o600,
    });
    await rename(temporary, manifestFile);
  } finally {
    await unlink(temporary).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
  }
  if (options.platform === "win32") {
    await run("reg.exe", [
      "ADD",
      `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${ZENX_CHROME_NATIVE_HOST_NAME}`,
      "/ve",
      "/t",
      "REG_SZ",
      "/d",
      manifestFile,
      "/f",
    ]);
  }
  return manifestFile;
}

export async function unregisterChromeNativeHost(
  options: ChromeNativeHostRegistrationOptions,
): Promise<void> {
  if (options.platform === "win32") {
    await run("reg.exe", [
      "DELETE",
      `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${ZENX_CHROME_NATIVE_HOST_NAME}`,
      "/f",
    ]).catch((error: unknown) => {
      const output = `${(error as { stdout?: unknown }).stdout ?? ""} ${(error as { stderr?: unknown }).stderr ?? ""}`;
      if (!/unable to find|not find|找不到/iu.test(output)) throw error;
    });
  }
  await unlink(chromeNativeHostManifestPath(options)).catch(
    (error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    },
  );
}

export async function chromeNativeHostRegistered(
  options: ChromeNativeHostRegistrationOptions,
): Promise<boolean> {
  const manifestFile = chromeNativeHostManifestPath(options);
  let manifest: unknown;
  try {
    manifest = JSON.parse(await readFile(manifestFile, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    return false;
  }
  if (
    typeof manifest !== "object" ||
    manifest === null ||
    (manifest as { name?: unknown }).name !== ZENX_CHROME_NATIVE_HOST_NAME ||
    (manifest as { path?: unknown }).path !==
      chromeNativeHostExecutablePath(options) ||
    JSON.stringify(
      (manifest as { allowed_origins?: unknown }).allowed_origins,
    ) !== JSON.stringify([ZENX_CHROME_EXTENSION_ORIGIN])
  )
    return false;
  if (options.platform !== "win32") return true;
  try {
    const result = await run("reg.exe", [
      "QUERY",
      `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${ZENX_CHROME_NATIVE_HOST_NAME}`,
      "/ve",
    ]);
    return result.stdout.includes(manifestFile);
  } catch {
    return false;
  }
}
