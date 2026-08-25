import type {
  ZenXPluginPackageSource,
  ZenXPluginSnapshot,
  ZenXPluginSummary,
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

export interface MarketplaceCatalogLoadSnapshot extends MarketplaceCatalogSnapshot {
  readonly builtIns: readonly MarketplaceBuiltInEntry[];
  readonly error?: string;
}

export interface MarketplaceBuiltInEntry {
  readonly pluginId: string;
  readonly packageName: string;
  readonly name: string;
  readonly description: string;
  readonly icon: string;
  readonly available: boolean;
  readonly unavailableReason?: string;
}

export type MarketplaceInventoryLifecycle =
  ZenXPluginSummary["lifecycle"] | "available" | "unavailable";

export interface MarketplaceInventoryViewEntry {
  readonly key: string;
  readonly pluginId?: string;
  readonly packageSpec?: string;
  readonly name: string;
  readonly description: string;
  readonly icon: string;
  readonly source: "built-in" | "catalog" | "source";
  readonly lifecycle: MarketplaceInventoryLifecycle;
  readonly available: boolean;
  readonly unavailableReason?: string;
  readonly plugin?: ZenXPluginSummary;
  readonly recommendedVersion?: string;
  readonly curated: boolean;
  readonly versions: readonly MarketplaceCatalogVersion[];
  readonly updateAvailable: boolean;
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

/**
 * One read model for every plugin a person can manage. The Plugin Catalog
 * snapshot remains the lifecycle authority; this function only composes it
 * with Host-owned built-ins and read-only external metadata.
 */
export function marketplaceInventoryView(
  catalog: MarketplaceCatalogLoadSnapshot,
  plugins: ZenXPluginSnapshot,
): MarketplaceInventoryViewEntry[] {
  const pluginsById = new Map(
    plugins.plugins.map((plugin) => [plugin.id, plugin] as const),
  );
  const pluginsByPackage = new Map(
    plugins.plugins.flatMap((plugin) =>
      plugin.profileSource === undefined
        ? []
        : ([[plugin.profileSource.packageName, plugin]] as const),
    ),
  );
  const claimedPluginIds = new Set<string>();
  const claimedPackages = new Set<string>();
  const inventory: MarketplaceInventoryViewEntry[] = [];

  // Keep a mixed-version renderer connected to an older Host readable while
  // the normal production response always supplies this Host-owned inventory.
  for (const entry of catalog.builtIns ?? []) {
    const plugin = pluginsById.get(entry.pluginId);
    claimedPluginIds.add(entry.pluginId);
    claimedPackages.add(entry.packageName);
    inventory.push({
      key: `builtin:${entry.pluginId}`,
      pluginId: entry.pluginId,
      packageSpec: entry.packageName,
      name: entry.name,
      description: entry.description,
      icon: entry.icon,
      source: "built-in",
      lifecycle:
        plugin?.lifecycle ?? (entry.available ? "available" : "unavailable"),
      available: entry.available,
      ...(entry.unavailableReason === undefined
        ? {}
        : { unavailableReason: entry.unavailableReason }),
      ...(plugin === undefined ? {} : { plugin }),
      curated: true,
      versions: [],
      updateAvailable: false,
    });
  }

  for (const entry of catalog.entries) {
    if (claimedPackages.has(entry.packageSpec)) continue;
    const plugin = pluginsByPackage.get(entry.packageSpec);
    if (plugin !== undefined) claimedPluginIds.add(plugin.id);
    claimedPackages.add(entry.packageSpec);
    inventory.push({
      key: `catalog:${entry.packageSpec}`,
      ...(plugin === undefined ? {} : { pluginId: plugin.id, plugin }),
      packageSpec: entry.packageSpec,
      name: entry.name,
      description: entry.description,
      icon: entry.icon,
      source: "catalog",
      lifecycle: plugin?.lifecycle ?? "available",
      available: true,
      recommendedVersion: entry.recommendedVersion,
      curated: entry.curated,
      versions: entry.versions,
      updateAvailable:
        plugin !== undefined &&
        plugin.lifecycle !== "uninstalled" &&
        compareSemver(plugin.version, entry.recommendedVersion) < 0,
    });
  }

  for (const plugin of plugins.plugins) {
    if (
      claimedPluginIds.has(plugin.id) ||
      (plugin.profileSource !== undefined &&
        claimedPackages.has(plugin.profileSource.packageName))
    ) {
      continue;
    }
    inventory.push({
      key: `installed:${plugin.id}`,
      pluginId: plugin.id,
      ...(plugin.profileSource === undefined
        ? {}
        : { packageSpec: plugin.profileSource.packageName }),
      name: plugin.displayName,
      description: plugin.description ?? "No package description provided.",
      icon: "layers",
      source: "source",
      lifecycle: plugin.lifecycle,
      available: plugin.available,
      plugin,
      curated: false,
      versions: [],
      updateAvailable: false,
    });
  }

  return inventory.sort((left, right) => left.name.localeCompare(right.name));
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
    const difference = compareNumericIdentifier(
      parsedLeft.core[index]!,
      parsedRight.core[index]!,
    );
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
    const leftNumeric = /^\d+$/u.test(leftIdentifier);
    const rightNumeric = /^\d+$/u.test(rightIdentifier);
    if (leftNumeric && rightNumeric) {
      return compareNumericIdentifier(leftIdentifier, rightIdentifier);
    }
    if (leftNumeric) return -1;
    if (rightNumeric) return 1;
    return leftIdentifier < rightIdentifier ? -1 : 1;
  }
  return 0;
}

function compareNumericIdentifier(left: string, right: string): number {
  if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function parseSemver(version: string):
  | {
      core: readonly [string, string, string];
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
    core: [match[1]!, match[2]!, match[3]!],
    prerelease,
  };
}
