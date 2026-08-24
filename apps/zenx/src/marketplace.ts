import type {
  ZenXPluginPackageSource,
  ZenXPluginSnapshot,
} from "./main/capabilities/types.js";

export interface MarketplaceCatalogVersion {
  readonly version: string;
  readonly packageSpec: string;
}

export interface MarketplaceCatalogEntry {
  readonly packageSpec: string;
  readonly name: string;
  readonly description: string;
  readonly icon: string;
  readonly recommendedVersion: string;
  readonly curated: boolean;
  readonly versions: readonly MarketplaceCatalogVersion[];
}

export interface MarketplaceCatalogSnapshot {
  readonly entries: readonly MarketplaceCatalogEntry[];
}

export interface MarketplaceCatalogViewEntry extends MarketplaceCatalogEntry {
  readonly installed?: {
    readonly pluginId: string;
    readonly version: string;
  };
  readonly updateAvailable: boolean;
}

export function marketplacePackageSource(
  entry: MarketplaceCatalogEntry,
  version: string,
): ZenXPluginPackageSource {
  const selected = entry.versions.find(
    (candidate) => candidate.version === version,
  );
  if (selected === undefined) {
    throw new Error(`${entry.name} version ${version} is not listed`);
  }
  return { mode: "npm", packageSpec: selected.packageSpec };
}

export function marketplaceCatalogView(
  catalog: MarketplaceCatalogSnapshot,
  plugins: ZenXPluginSnapshot,
  query = "",
): MarketplaceCatalogViewEntry[] {
  const needle = query.trim().toLocaleLowerCase();
  return catalog.entries
    .filter((entry) =>
      needle.length === 0
        ? true
        : [entry.name, entry.description, entry.packageSpec].some((value) =>
            value.toLocaleLowerCase().includes(needle),
          ),
    )
    .map((entry) => {
      const plugin = plugins.plugins.find(
        (candidate) =>
          candidate.lifecycle !== "uninstalled" &&
          candidate.profileSource?.packageName === entry.packageSpec,
      );
      return {
        ...entry,
        ...(plugin === undefined
          ? {}
          : { installed: { pluginId: plugin.id, version: plugin.version } }),
        updateAvailable:
          plugin !== undefined &&
          compareSemver(plugin.version, entry.recommendedVersion) < 0,
      };
    });
}

export function validateMarketplaceCatalog(
  value: unknown,
): MarketplaceCatalogSnapshot {
  if (!isRecord(value) || !Array.isArray(value.entries)) {
    throw new Error("Marketplace catalog must contain an entries array");
  }
  const entries = value.entries.map((entry, index) =>
    validateMarketplaceEntry(entry, index),
  );
  const packageSpecs = new Set<string>();
  for (const entry of entries) {
    if (packageSpecs.has(entry.packageSpec)) {
      throw new Error(
        `Marketplace catalog repeats package spec ${entry.packageSpec}`,
      );
    }
    packageSpecs.add(entry.packageSpec);
  }
  return { entries };
}

function validateMarketplaceEntry(
  value: unknown,
  index: number,
): MarketplaceCatalogEntry {
  if (!isRecord(value)) {
    throw new Error(`Marketplace entry ${String(index + 1)} is invalid`);
  }
  const packageSpec = requiredString(value.packageSpec, "package spec", index);
  if (!isCanonicalNpmPackageName(packageSpec)) {
    throw new Error(
      `Marketplace entry ${String(index + 1)} package spec must be a canonical npm package identity`,
    );
  }
  const name = requiredString(value.name, "name", index);
  const description = requiredString(value.description, "description", index);
  const icon = requiredString(value.icon, "icon", index);
  const recommendedVersion = requiredSemver(
    value.recommendedVersion,
    "recommended version",
    index,
  );
  if (typeof value.curated !== "boolean") {
    throw new Error(
      `Marketplace entry ${String(index + 1)} curated state is invalid`,
    );
  }
  if (!Array.isArray(value.versions) || value.versions.length === 0) {
    throw new Error(
      `Marketplace entry ${String(index + 1)} must list at least one version`,
    );
  }
  const versions = value.versions.map((candidate, versionIndex) => {
    if (!isRecord(candidate)) {
      throw new Error(
        `Marketplace entry ${String(index + 1)} version ${String(versionIndex + 1)} is invalid`,
      );
    }
    const version = requiredSemver(candidate.version, "version", index);
    const versionPackageSpec = requiredString(
      candidate.packageSpec,
      "version package spec",
      index,
    );
    if (versionPackageSpec !== `${packageSpec}@${version}`) {
      throw new Error(
        `Marketplace entry ${String(index + 1)} version ${version} must use the exact canonical package version ${packageSpec}@${version}`,
      );
    }
    return { version, packageSpec: versionPackageSpec };
  });
  if (
    new Set(versions.map((candidate) => candidate.version)).size !==
    versions.length
  ) {
    throw new Error(
      `Marketplace entry ${String(index + 1)} repeats a listed version`,
    );
  }
  if (!versions.some((candidate) => candidate.version === recommendedVersion)) {
    throw new Error(
      `Marketplace entry ${String(index + 1)} recommended version ${recommendedVersion} is not listed`,
    );
  }
  return {
    packageSpec,
    name,
    description,
    icon,
    recommendedVersion,
    curated: value.curated,
    versions,
  };
}

function requiredString(value: unknown, field: string, index: number): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(
      `Marketplace entry ${String(index + 1)} ${field} is invalid`,
    );
  }
  return value;
}

function requiredSemver(value: unknown, field: string, index: number): string {
  const version = requiredString(value, field, index);
  if (parseSemver(version) === undefined) {
    throw new Error(
      `Marketplace entry ${String(index + 1)} ${field} is not semantic version metadata`,
    );
  }
  return version;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCanonicalNpmPackageName(value: string): boolean {
  if (value.length > 214) return false;
  const segment = "[a-z0-9][a-z0-9._-]*";
  return new RegExp(`^(?:${segment}|@${segment}/${segment})$`, "u").test(value);
}

function compareSemver(left: string, right: string): number {
  const parsedLeft = parseSemver(left);
  const parsedRight = parseSemver(right);
  if (parsedLeft === undefined || parsedRight === undefined) return 0;
  for (let index = 0; index < 3; index += 1) {
    const difference = parsedLeft.core[index]! - parsedRight.core[index]!;
    if (difference !== 0) return difference;
  }
  if (parsedLeft.prerelease.length === 0) {
    return parsedRight.prerelease.length === 0 ? 0 : 1;
  }
  if (parsedRight.prerelease.length === 0) return -1;
  const identifiers = Math.max(
    parsedLeft.prerelease.length,
    parsedRight.prerelease.length,
  );
  for (let index = 0; index < identifiers; index += 1) {
    const leftIdentifier = parsedLeft.prerelease[index];
    const rightIdentifier = parsedRight.prerelease[index];
    if (leftIdentifier === undefined) return -1;
    if (rightIdentifier === undefined) return 1;
    if (leftIdentifier === rightIdentifier) continue;
    const leftNumber = /^\d+$/u.test(leftIdentifier)
      ? Number(leftIdentifier)
      : undefined;
    const rightNumber = /^\d+$/u.test(rightIdentifier)
      ? Number(rightIdentifier)
      : undefined;
    if (leftNumber !== undefined && rightNumber !== undefined) {
      return leftNumber - rightNumber;
    }
    if (leftNumber !== undefined) return -1;
    if (rightNumber !== undefined) return 1;
    return leftIdentifier.localeCompare(rightIdentifier);
  }
  return 0;
}

function parseSemver(version: string):
  | {
      core: readonly [number, number, number];
      prerelease: readonly string[];
    }
  | undefined {
  const match =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u.exec(
      version,
    );
  if (match === null) return undefined;
  const prerelease = match[4]?.split(".") ?? [];
  if (
    prerelease.some(
      (identifier) => /^\d+$/u.test(identifier) && /^0\d+/u.test(identifier),
    )
  ) {
    return undefined;
  }
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease,
  };
}
