import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

export type PinnedProviderId = "playwright-cli" | "microsoft-winapp-cli";

export interface BundledProvider {
  providerId: PinnedProviderId;
  executable: string;
  version: string;
  sha256: string;
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
  options: { resourcesDirectory: string; platform: NodeJS.Platform },
): Promise<BundledProviderResolution> {
  const manifestPath = path.join(
    options.resourcesDirectory,
    "providers",
    "manifest.json",
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    return {
      reason: `Bundled ${providerId} manifest is unavailable at ${manifestPath}: ${describeError(error)}`,
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
  const executable = path.resolve(
    options.resourcesDirectory,
    "providers",
    manifest.executable,
  );
  const providerRoot = path.resolve(options.resourcesDirectory, "providers");
  if (
    executable !== providerRoot &&
    !executable.startsWith(`${providerRoot}${path.sep}`)
  ) {
    return {
      reason: `Bundled ${providerId} executable escapes its resource directory`,
    };
  }
  let bytes: Buffer;
  try {
    bytes = await readFile(executable);
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
      executable,
      version: manifest.version,
      sha256: actualSha256,
    },
  };
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
    typeof entry.version !== "string" ||
    !/^\d+\.\d+\.\d+(?:[-+].*)?$/u.test(entry.version) ||
    typeof entry.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(entry.sha256) ||
    !Array.isArray(entry.platforms) ||
    !entry.platforms.every(
      (platform): platform is string => typeof platform === "string",
    )
  ) {
    return undefined;
  }
  return entry;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
