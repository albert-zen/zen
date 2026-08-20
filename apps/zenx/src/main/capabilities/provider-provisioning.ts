import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  chmod,
  lstat,
  open,
  readFile,
  readdir,
  readlink,
  realpath,
} from "node:fs/promises";
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
  runtime?: { path: string; sha256: string; version?: string };
  assets?: BundledProviderAsset[];
}

export interface BundledProviderAsset {
  path: string;
  sha256: string;
  kind?: "file" | "directory";
  ignoredPaths?: string[];
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
  companion?: { path: string; sha256: string };
  runtime?: { path: string; sha256: string; version?: string };
  assets?: BundledProviderAsset[];
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
    verifyDirectoryAssets?: boolean;
  },
): Promise<BundledProviderResolution> {
  let providerRoot: string;
  let manifestPath: string;
  try {
    const resourceRoot = await realpath(options.resourcesDirectory);
    const lexicalProviderRoot = path.join(
      options.resourcesDirectory,
      "providers",
    );
    const rootStat = await lstat(lexicalProviderRoot);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
      throw new Error("provider root must be a regular, non-symlink directory");
    }
    providerRoot = await realpath(lexicalProviderRoot);
    if (!isWithin(resourceRoot, providerRoot)) {
      throw new Error("provider root resolves outside the resource directory");
    }
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
  let assets: BundledProviderAsset[] | undefined;
  try {
    const executableStat = await lstat(executable);
    if (executableStat.isSymbolicLink() || !executableStat.isFile()) {
      throw new Error("executable must be a regular, non-symlink file");
    }
    executableRealPath = await realpath(executable);
    if (!isWithin(providerRoot, executableRealPath)) {
      throw new Error("executable resolves outside its resource directory");
    }
    if (executableStat.size > 64 * 1024 * 1024)
      throw new Error("executable exceeds its size bound");
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
      if (companionStat.size > 64 * 1024 * 1024)
        throw new Error("executable shim companion exceeds its size bound");
      const companionSha256 = createHash("sha256")
        .update(await readFile(companionRealPath))
        .digest("hex");
      if (manifest.companion === undefined) {
        throw new Error("executable shim companion is not pinned");
      }
      const manifestCompanionPath = path.resolve(
        providerRoot,
        manifest.companion.path,
      );
      if (
        path.isAbsolute(manifest.companion.path) ||
        !isWithin(providerRoot, manifestCompanionPath) ||
        (await realpath(manifestCompanionPath)) !== companionRealPath ||
        manifest.companion.sha256 !== companionSha256
      ) {
        throw new Error("executable shim companion integrity mismatch");
      }
      companion = {
        path: companionRealPath,
        sha256: companionSha256,
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
  if (manifest.assets !== undefined) {
    try {
      if (manifest.assets.length > 64)
        throw new Error("asset list exceeds its bound");
      assets = [];
      for (const asset of manifest.assets) {
        const assetPath = path.resolve(providerRoot, asset.path);
        if (path.isAbsolute(asset.path) || !isWithin(providerRoot, assetPath)) {
          throw new Error("asset escapes its resource directory");
        }
        const assetStat = await lstat(assetPath);
        const kind = asset.kind ?? "file";
        if (
          assetStat.isSymbolicLink() ||
          (kind === "file" && !assetStat.isFile()) ||
          (kind === "directory" && !assetStat.isDirectory())
        ) {
          throw new Error(`asset must be a regular, non-symlink ${kind}`);
        }
        if (kind === "file" && assetStat.size > 512 * 1024 * 1024)
          throw new Error("asset exceeds its size bound");
        const assetRealPath = await realpath(assetPath);
        if (!isWithin(providerRoot, assetRealPath))
          throw new Error("asset resolves outside its resource directory");
        const assetSha256 =
          kind === "directory" && options.verifyDirectoryAssets !== false
            ? await hashBundledDirectoryAsset(assetRealPath, asset.ignoredPaths)
            : kind === "file"
              ? await hashBundledFileAsset(assetRealPath)
              : asset.sha256;
        if (assetSha256 !== asset.sha256)
          throw new Error(`asset integrity mismatch: ${asset.path}`);
        assets.push({
          path: assetRealPath,
          sha256: assetSha256,
          ...(asset.kind === undefined ? {} : { kind: asset.kind }),
          ...(asset.ignoredPaths === undefined
            ? {}
            : { ignoredPaths: [...asset.ignoredPaths] }),
        });
      }
    } catch (error) {
      return {
        reason: `Bundled ${providerId} companion assets are unavailable: ${describeError(error)}`,
      };
    }
  }
  let runtime: BundledProvider["runtime"];
  if (manifest.runtime !== undefined) {
    const runtimePath = path.resolve(providerRoot, manifest.runtime.path);
    if (
      path.isAbsolute(manifest.runtime.path) ||
      !isWithin(providerRoot, runtimePath)
    ) {
      return {
        reason: `Bundled ${providerId} runtime escapes its resource directory`,
      };
    }
    try {
      const runtimeStat = await lstat(runtimePath);
      if (runtimeStat.isSymbolicLink() || !runtimeStat.isFile())
        throw new Error("runtime must be a regular, non-symlink file");
      if (runtimeStat.size > 128 * 1024 * 1024)
        throw new Error("runtime exceeds its size bound");
      const runtimeRealPath = await realpath(runtimePath);
      if (!isWithin(providerRoot, runtimeRealPath))
        throw new Error("runtime resolves outside its resource directory");
      const runtimeBytes = await readFile(runtimeRealPath);
      const runtimeSha256 = createHash("sha256")
        .update(runtimeBytes)
        .digest("hex");
      if (runtimeSha256 !== manifest.runtime.sha256)
        throw new Error("runtime integrity mismatch");
      runtime = {
        path: runtimeRealPath,
        sha256: runtimeSha256,
        ...(manifest.runtime.version === undefined
          ? {}
          : { version: manifest.runtime.version }),
      };
    } catch (error) {
      return {
        reason: `Bundled ${providerId} runtime is unavailable: ${describeError(error)}`,
      };
    }
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
      ...(runtime === undefined ? {} : { runtime }),
      ...(assets === undefined ? {} : { assets }),
    },
  };
}

/** Re-read and re-hash a selected asset immediately before provider use. */
export async function verifyBundledProvider(
  selected: BundledProvider,
  options: {
    resourcesDirectory: string;
    platform: NodeJS.Platform;
    verifyDirectoryAssets?: boolean;
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
  const verified = resolved.provider;
  if (
    verified.executable !== selected.executable ||
    verified.sha256 !== selected.sha256 ||
    verified.version !== selected.version
  ) {
    throw new Error(
      "Bundled provider changed after selection; refusing to launch",
    );
  }
  if (
    selected.assets?.length !== verified.assets?.length ||
    selected.assets?.some(
      (asset, index) =>
        asset.path !== verified.assets?.[index]?.path ||
        asset.sha256 !== verified.assets?.[index]?.sha256 ||
        asset.kind !== verified.assets?.[index]?.kind ||
        !equalStrings(
          asset.ignoredPaths,
          verified.assets?.[index]?.ignoredPaths,
        ),
    )
  ) {
    throw new Error(
      "Bundled provider companion assets changed after selection; refusing to launch",
    );
  }
  if (
    selected.runtime?.path !== verified.runtime?.path ||
    selected.runtime?.sha256 !== verified.runtime?.sha256 ||
    selected.runtime?.version !== verified.runtime?.version
  ) {
    throw new Error(
      "Bundled provider runtime changed after selection; refusing to launch",
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

/**
 * Bind the verified assets for the short launch interval. The files are held
 * open and the selected resource tree is made read-only before spawn; this is
 * the Windows-compatible equivalent available to a Node child-process runner
 * that cannot pass an executable handle to CreateProcess.
 */
export async function bindBundledProviderLaunch(
  selected: BundledProvider,
  options: {
    resourcesDirectory: string;
    platform: NodeJS.Platform;
    verifyDirectoryAssets?: boolean;
  },
): Promise<() => Promise<void>> {
  await verifyBundledProvider(selected, options);
  const handles = [] as Awaited<ReturnType<typeof open>>[];
  try {
    for (const candidate of [
      selected.executable,
      selected.companion?.path,
      selected.runtime?.path,
      ...(selected.assets
        ?.filter((asset) => asset.kind !== "directory")
        .map((asset) => asset.path) ?? []),
    ].filter((value): value is string => value !== undefined)) {
      handles.push(await open(candidate, "r"));
    }
  } catch (error) {
    await Promise.all(handles.map((handle) => handle.close()));
    throw error;
  }
  if (options.platform === "win32") {
    try {
      await chmod(path.dirname(selected.manifestPath), 0o555);
      await Promise.all(
        [
          selected.manifestPath,
          selected.executable,
          selected.companion?.path,
          selected.runtime?.path,
          ...(selected.assets
            ?.filter((asset) => asset.kind !== "directory")
            .map((asset) => asset.path) ?? []),
        ]
          .filter((candidate): candidate is string => candidate !== undefined)
          .map((candidate) => chmod(candidate, 0o444)),
      );
      await Promise.all(
        selected.assets
          ?.filter((asset) => asset.kind === "directory")
          .map((asset) => chmod(asset.path, 0o555)) ?? [],
      );
    } catch (error) {
      await Promise.all(handles.map((handle) => handle.close()));
      throw new Error(
        `Bundled provider resource tree could not be made immutable before spawn: ${describeError(error)}`,
      );
    }
  }
  return async () => {
    await Promise.all(handles.map((handle) => handle.close()));
  };
}

export async function hashBundledDirectoryAsset(
  rootDirectory: string,
  ignoredPaths: readonly string[] = [],
): Promise<string> {
  const maxEntries = 20_000;
  const maxBytes = 2 * 1024 * 1024 * 1024;
  const root = await realpath(rootDirectory);
  const hash = createHash("sha256");
  const ignored = new Set(ignoredPaths);
  let entriesSeen = 0;
  let bytesSeen = 0;

  async function visit(
    directory: string,
    relativeDirectory: string,
  ): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
    );
    for (const entry of entries) {
      const candidate = path.join(directory, entry.name);
      const relative = path.posix.join(relativeDirectory, entry.name);
      if (ignored.has(relative)) {
        const ignoredMetadata = await lstat(candidate);
        if (!ignoredMetadata.isFile() || ignoredMetadata.isSymbolicLink()) {
          throw new Error(
            `bundled directory runtime state must be a regular file: ${relative}`,
          );
        }
        continue;
      }
      entriesSeen += 1;
      if (entriesSeen > maxEntries) {
        throw new Error("bundled directory asset exceeds the entry bound");
      }
      const metadata = await lstat(candidate);
      if (metadata.isDirectory()) {
        hash.update(`directory\0${relative}\0`);
        await visit(candidate, relative);
        continue;
      }
      if (metadata.isFile()) {
        bytesSeen += metadata.size;
        if (bytesSeen > maxBytes) {
          throw new Error("bundled directory asset exceeds the size bound");
        }
        hash.update(`file\0${relative}\0${String(metadata.size)}\0`);
        const file = createReadStream(candidate);
        for await (const chunk of file) hash.update(chunk);
        hash.update("\0");
        continue;
      }
      if (metadata.isSymbolicLink()) {
        const target = await readlink(candidate);
        const resolvedTarget = await realpath(candidate);
        if (path.isAbsolute(target) || !isWithin(root, resolvedTarget)) {
          throw new Error(
            `bundled directory asset symlink escapes: ${relative}`,
          );
        }
        hash.update(`symlink\0${relative}\0${target}\0`);
        continue;
      }
      throw new Error(
        `bundled directory asset contains an unsupported entry: ${relative}`,
      );
    }
  }

  await visit(root, "");
  return hash.digest("hex");
}

async function hashBundledFileAsset(file: string): Promise<string> {
  const hash = createHash("sha256");
  const stream = createReadStream(file);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest("hex");
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
    ) ||
    (entry.runtime !== undefined &&
      (typeof entry.runtime.path !== "string" ||
        entry.runtime.path.length === 0 ||
        entry.runtime.path.length > 256 ||
        typeof entry.runtime.sha256 !== "string" ||
        !/^[a-f0-9]{64}$/u.test(entry.runtime.sha256) ||
        (entry.runtime.version !== undefined &&
          (typeof entry.runtime.version !== "string" ||
            entry.runtime.version.length > 64)))) ||
    (entry.companion !== undefined &&
      (typeof entry.companion.path !== "string" ||
        entry.companion.path.length === 0 ||
        entry.companion.path.length > 256 ||
        typeof entry.companion.sha256 !== "string" ||
        !/^[a-f0-9]{64}$/u.test(entry.companion.sha256))) ||
    (entry.assets !== undefined &&
      (entry.assets.length > 64 ||
        !entry.assets.every(
          (asset) =>
            typeof asset === "object" &&
            asset !== null &&
            typeof asset.path === "string" &&
            asset.path.length > 0 &&
            asset.path.length <= 256 &&
            typeof asset.sha256 === "string" &&
            /^[a-f0-9]{64}$/u.test(asset.sha256) &&
            (asset.kind === undefined ||
              asset.kind === "file" ||
              asset.kind === "directory") &&
            (asset.ignoredPaths === undefined ||
              (asset.kind === "directory" &&
                Array.isArray(asset.ignoredPaths) &&
                asset.ignoredPaths.length <= 16 &&
                asset.ignoredPaths.every(isSafeRelativeAssetPath) &&
                new Set(asset.ignoredPaths).size ===
                  asset.ignoredPaths.length)),
        )))
  ) {
    return undefined;
  }
  return entry;
}

function isSafeRelativeAssetPath(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 256) {
    return false;
  }
  if (path.posix.isAbsolute(value) || value.includes("\\")) return false;
  return !value
    .split("/")
    .some((segment) => segment === "" || segment === "." || segment === "..");
}

function equalStrings(
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
): boolean {
  return (
    left?.length === right?.length &&
    (left?.every((value, index) => value === right?.[index]) ?? true)
  );
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
