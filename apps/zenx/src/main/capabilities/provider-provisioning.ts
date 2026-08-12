import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";

import { parseWindowsNpmShimEntry } from "./external-provider.js";

export type PinnedProviderId = "playwright-cli" | "microsoft-winapp-cli";

export interface BundledProvider {
  providerId: PinnedProviderId;
  executable: string;
  version: string;
  sha256: string;
  manifestPath: string;
  manifestSha256: string;
  companion?: { path: string; sha256: string };
}

export interface BundledProviderResolution {
  provider?: BundledProvider;
  reason?: string;
}

interface ProviderManifestEntry {
  executable: string;
  version: string;
  sha256: string;
  platforms: string[];
}

interface ProviderManifest {
  schemaVersion: 1;
  providers: Partial<Record<PinnedProviderId, ProviderManifestEntry>>;
}

/**
 * Resolve only an application-bundled provider whose manifest pins both
 * version and bytes. This is deliberately offline: downloading or accepting
 * a PATH executable belongs to an explicit provisioning/update workflow.
 */
export async function resolveBundledProvider(
  providerId: PinnedProviderId,
  options: {
    resourcesDirectory: string;
    platform: NodeJS.Platform;
    expectedVersion?: string;
    expectedManifestSha256?: string;
  },
): Promise<BundledProviderResolution> {
  let providerRoot: string;
  let manifestPath: string;
  try {
    const lexicalProviderRoot = path.join(
      options.resourcesDirectory,
      "providers",
    );
    const rootStat = await lstat(lexicalProviderRoot);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
      throw new Error("provider root must be a regular, non-symlink directory");
    }
    providerRoot = await realpath(lexicalProviderRoot);
    manifestPath = path.join(providerRoot, "manifest.json");
    const manifestStat = await lstat(manifestPath);
    if (manifestStat.isSymbolicLink() || !manifestStat.isFile()) {
      throw new Error("manifest must be a regular, non-symlink file");
    }
    if (manifestStat.size > 256 * 1024)
      throw new Error("manifest exceeds its size bound");
    const manifestRealPath = await realpath(manifestPath);
    if (!isWithin(providerRoot, manifestRealPath)) {
      throw new Error("manifest resolves outside its resource directory");
    }
  } catch (error) {
    return {
      reason: `Bundled ${providerId} manifest is unavailable: ${describeError(error)}`,
    };
  }
  let parsed: unknown;
  let manifestBytes: Buffer;
  try {
    manifestBytes = await readFile(manifestPath);
    parsed = JSON.parse(manifestBytes.toString("utf8"));
  } catch (error) {
    return {
      reason: `Bundled ${providerId} manifest is unavailable at ${manifestPath}: ${describeError(error)}`,
    };
  }
  const manifestSha256 = createHash("sha256")
    .update(manifestBytes)
    .digest("hex");
  if (
    options.expectedManifestSha256 !== undefined &&
    manifestSha256 !== options.expectedManifestSha256
  ) {
    return {
      reason: `Bundled ${providerId} manifest integrity mismatch: expected ${options.expectedManifestSha256}, got ${manifestSha256}`,
    };
  }
  const manifest = parseManifest(parsed, providerId);
  if (manifest === undefined) {
    return {
      reason: `Bundled ${providerId} manifest is invalid or does not pin this provider`,
    };
  }
  if (!manifest.platforms.includes(options.platform)) {
    return {
      reason: `Bundled ${providerId} does not provide an asset for ${options.platform}`,
    };
  }
  if (
    options.expectedVersion !== undefined &&
    manifest.version !== options.expectedVersion
  ) {
    return {
      reason: `Bundled ${providerId} version mismatch: expected ${options.expectedVersion}, got ${manifest.version}`,
    };
  }
  const executable = path.resolve(providerRoot, manifest.executable);
  if (
    path.isAbsolute(manifest.executable) ||
    !isWithin(providerRoot, executable)
  ) {
    return {
      reason: `Bundled ${providerId} executable escapes its resource directory`,
    };
  }
  let executableRealPath: string;
  let bytes: Buffer;
  let companion: { path: string; sha256: string } | undefined;
  try {
    const executableStat = await lstat(executable);
    if (executableStat.isSymbolicLink() || !executableStat.isFile()) {
      throw new Error("executable must be a regular, non-symlink file");
    }
    executableRealPath = await realpath(executable);
    if (!isWithin(providerRoot, executableRealPath)) {
      throw new Error("executable resolves outside its resource directory");
    }
    bytes = await readFile(executableRealPath);
    if (path.extname(executableRealPath).toLowerCase() === ".cmd") {
      const entry = parseWindowsNpmShimEntry(bytes.toString("utf8"));
      if (entry === undefined)
        throw new Error("executable shim is unsupported");
      const segments = entry.split(/[\\/]+/u);
      if (
        segments.some(
          (segment) => segment === "" || segment === "." || segment === "..",
        )
      ) {
        throw new Error("executable shim contains an unsafe path");
      }
      const companionPath = path.resolve(
        path.dirname(executableRealPath),
        ...segments,
      );
      if (!isWithin(providerRoot, companionPath)) {
        throw new Error(
          "executable shim resolves outside its resource directory",
        );
      }
      const companionStat = await lstat(companionPath);
      if (companionStat.isSymbolicLink() || !companionStat.isFile()) {
        throw new Error("executable shim companion must be a regular file");
      }
      const companionRealPath = await realpath(companionPath);
      if (!isWithin(providerRoot, companionRealPath)) {
        throw new Error(
          "executable shim companion resolves outside its resource directory",
        );
      }
      companion = {
        path: companionRealPath,
        sha256: createHash("sha256")
          .update(await readFile(companionRealPath))
          .digest("hex"),
      };
    }
  } catch (error) {
    return {
      reason: `Bundled ${providerId} executable is unavailable at ${executable}: ${describeError(error)}`,
    };
  }
  const actualSha256 = createHash("sha256").update(bytes).digest("hex");
  if (actualSha256 !== manifest.sha256) {
    return {
      reason: `Bundled ${providerId} integrity mismatch: expected ${manifest.sha256}, got ${actualSha256}`,
    };
  }
  return {
    provider: {
      providerId,
      executable: executableRealPath,
      version: manifest.version,
      sha256: actualSha256,
      manifestPath,
      manifestSha256,
      ...(companion === undefined ? {} : { companion }),
    },
  };
}

/** Re-read and re-hash a selected asset immediately before provider use. */
export async function verifyBundledProvider(
  selected: BundledProvider,
  options: {
    resourcesDirectory: string;
    platform: NodeJS.Platform;
  },
): Promise<void> {
  const resolved = await resolveBundledProvider(selected.providerId, {
    ...options,
    expectedVersion: selected.version,
    expectedManifestSha256: selected.manifestSha256,
  });
  if (resolved.provider === undefined) {
    throw new Error(resolved.reason ?? "Bundled provider verification failed");
  }
  if (
    resolved.provider.executable !== selected.executable ||
    resolved.provider.sha256 !== selected.sha256 ||
    resolved.provider.version !== selected.version
  ) {
    throw new Error(
      "Bundled provider changed after selection; refusing to launch",
    );
  }
  if (selected.companion !== undefined) {
    if (
      resolved.provider.companion?.path !== selected.companion.path ||
      resolved.provider.companion.sha256 !== selected.companion.sha256
    ) {
      throw new Error(
        "Bundled provider companion changed after selection; refusing to launch",
      );
    }
  }
}

function parseManifest(
  value: unknown,
  providerId: PinnedProviderId,
): ProviderManifestEntry | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const manifest = value as Partial<ProviderManifest>;
  if (manifest.schemaVersion !== 1 || typeof manifest.providers !== "object") {
    return undefined;
  }
  const entry = manifest.providers?.[providerId];
  if (
    entry === undefined ||
    typeof entry !== "object" ||
    typeof entry.executable !== "string" ||
    entry.executable.length === 0 ||
    entry.executable.length > 256 ||
    typeof entry.version !== "string" ||
    entry.version.length > 64 ||
    !/^\d+\.\d+\.\d+(?:[-+].*)?$/u.test(entry.version) ||
    typeof entry.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(entry.sha256) ||
    !Array.isArray(entry.platforms) ||
    entry.platforms.length === 0 ||
    entry.platforms.length > 8 ||
    !entry.platforms.every(
      (platform): platform is string => typeof platform === "string",
    )
  ) {
    return undefined;
  }
  return entry;
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
