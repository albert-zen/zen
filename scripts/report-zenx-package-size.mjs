import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir, readFile, readlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const defaultLock = new URL(
  "../apps/zenx/resources/providers/provider-lock.json",
  import.meta.url,
);
const componentNames = [
  "runtime",
  "playwright-cli",
  "playwright-browsers",
  "microsoft-winapp-cli",
  "provider-metadata",
  "application-remainder",
];

// Read-only accounting of the existing assembly layout, not an installer or a
// readiness check. The caller supplies an immutable, already unpacked snapshot.
export async function reportPackageSize({
  root,
  providersRelative = "providers",
  lockPath = defaultLock,
  platformKey,
  cache,
}) {
  if (!root) throw new Error("--root is required");
  const providerParts = providersRelative.split("/");
  if (
    path.isAbsolute(providersRelative) ||
    providerParts.some(
      (part) => !part || part === "." || part === ".." || part.includes("\\"),
    )
  )
    throw new Error("Invalid providers-relative path");
  const lock = JSON.parse(await readFile(lockPath, "utf8"));
  if (lock.schemaVersion !== 1)
    throw new Error("Unsupported provider-lock schema");
  if (
    !lock.node?.platformArchives?.[platformKey] ||
    !lock.browser?.platformArchives?.[platformKey]
  )
    throw new Error("--platform must name a platform in provider-lock");
  root = path.resolve(root);
  if (!(await lstat(root)).isDirectory())
    throw new Error("Root must be a real directory, not a symlink");
  const components = Object.fromEntries(
    componentNames.map((name) => [name, counter()]),
  );
  const total = counter();
  const symlinks = [];
  const providerPrefix = `${providersRelative}/`;
  let manifest = null;
  let entries = 0;
  async function visit(relative) {
    if (++entries > 200_000) throw new Error("Package exceeds 200000 entries");
    const candidate = path.join(root, relative);
    const stats = await lstat(candidate);
    const subpath = relative.startsWith(providerPrefix)
      ? relative.slice(providerPrefix.length)
      : null;
    const first = subpath?.split("/")[0];
    const component =
      first && componentNames.slice(0, 4).includes(first)
        ? first
        : subpath !== null || relative === providersRelative
          ? "provider-metadata"
          : "application-remainder";
    account(total, stats);
    account(components[component], stats);
    if (stats.isSymbolicLink()) {
      symlinks.push({
        path: relative,
        target: await readlink(candidate),
        component,
      });
      return;
    }
    if (stats.isDirectory()) {
      for (const name of (await readdir(candidate)).sort())
        await visit(relative ? `${relative}/${name}` : name);
    } else if (stats.isFile()) {
      if (relative === `${providerPrefix}manifest.json`) {
        if (stats.size > 1024 * 1024)
          throw new Error("Provider manifest exceeds 1 MiB");
        const bytes = await readFile(candidate);
        const parsed = JSON.parse(bytes.toString("utf8"));
        manifest = {
          schemaVersion: parsed.schemaVersion,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          providers: Object.keys(parsed.providers ?? {}).sort(),
          verification: "not-performed",
        };
      }
    } else throw new Error(`Unsupported filesystem entry: ${relative}`);
  }
  await visit("");
  if (cache) {
    const cacheStats = await optionalStat(path.resolve(cache));
    if (cacheStats && !cacheStats.isDirectory())
      throw new Error("Cache root must be a real directory");
  }
  const archives = [];
  for (const pin of archivePins(lock, platformKey)) {
    if (!/^[a-f0-9]{64}$/u.test(pin.sha256))
      throw new Error(`Invalid archive digest: ${pin.id}`);
    let result = { ...pin, status: "unknown", compressedBytes: null };
    if (cache) {
      // Match acquireVerifiedArtifact's cache/artifacts/sha256/<digest> layout.
      const directory = path.join(path.resolve(cache), "sha256");
      const file = path.join(directory, pin.sha256);
      const parent = await optionalStat(directory);
      if (parent && !parent.isDirectory())
        throw new Error("Cache sha256 must be a real directory");
      const stats = parent ? await optionalStat(file) : null;
      if (!stats) result.status = "missing";
      else if (!stats.isFile()) result.status = "not-regular-file";
      else {
        const hash = createHash("sha256");
        for await (const chunk of createReadStream(file)) hash.update(chunk);
        result.status =
          hash.digest("hex") === pin.sha256 ? "verified" : "digest-mismatch";
        if (result.status === "verified") result.compressedBytes = stats.size;
      }
    }
    archives.push(result);
  }
  return {
    schemaVersion: 1,
    platformKey,
    providersRelative,
    manifest,
    total: finish(total),
    components: Object.fromEntries(
      Object.entries(components).map(([name, value]) => [name, finish(value)]),
    ),
    symlinks,
    archives,
    estimatedSavingsBytes: null,
  };
}

function counter() {
  return {
    entries: 0,
    files: 0,
    directories: 0,
    symlinks: 0,
    hardlinkDuplicates: 0,
    logicalBytes: 0,
    symlinkBytes: 0,
    allocatedBytes: 0,
    inodes: new Set(),
  };
}

function account(result, stats) {
  result.entries++;
  if (stats.isFile()) {
    result.files++;
    result.logicalBytes += stats.size;
  }
  if (stats.isDirectory()) result.directories++;
  if (stats.isSymbolicLink()) {
    result.symlinks++;
    result.symlinkBytes += stats.size;
  }
  const inode = `${stats.dev}:${stats.ino}`;
  const usableInode =
    Number.isSafeInteger(stats.ino) &&
    stats.ino > 0 &&
    Number.isSafeInteger(stats.dev);
  const duplicate = usableInode && result.inodes.has(inode);
  if (duplicate) result.hardlinkDuplicates++;
  else {
    if (usableInode) result.inodes.add(inode);
    if (
      process.platform === "win32" ||
      !usableInode ||
      !Number.isSafeInteger(stats.blocks) ||
      stats.blocks < 0
    )
      result.allocatedBytes = null;
    else if (result.allocatedBytes !== null)
      result.allocatedBytes += stats.blocks * 512;
  }
}

function finish({ inodes: _inodes, ...value }) {
  // Absent components are unknown, not evidence of an intentionally empty pack.
  return value.entries ? value : null;
}

function archivePins(lock, platform) {
  const node = lock.node.platformArchives[platform];
  const browser = lock.browser.platformArchives[platform];
  return [
    {
      id: "runtime",
      version: lock.node.version,
      source: `${lock.node.releaseBase}${node.file}`,
      sha256: node.sha256,
    },
    {
      id: "playwright-browsers",
      version: lock.browser.version,
      revision: lock.browser.revision,
      source: browser.url,
      sha256: browser.sha256,
    },
    ...Object.entries(lock.providers)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .flatMap(([id, pin]) => [
        { id, version: pin.version, source: pin.tarball, sha256: pin.sha256 },
        ...(pin.transitive ?? []).map((dependency) => ({
          id: `${id}/${dependency.name}`,
          version: dependency.version,
          source: dependency.tarball,
          sha256: dependency.sha256,
        })),
      ]),
  ];
}

async function optionalStat(file) {
  try {
    return await lstat(file);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const names = {
    "--root": "root",
    "--providers-relative": "providersRelative",
    "--provider-lock": "lockPath",
    "--platform": "platformKey",
    "--cache": "cache",
  };
  const options = {};
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i += 2) {
    const key = names[args[i]];
    if (!key || !args[i + 1] || args[i + 1].startsWith("--") || key in options)
      throw new Error(
        "Expected unique --root/--platform and optional --providers-relative/--provider-lock/--cache values",
      );
    options[key] = args[i + 1];
  }
  process.stdout.write(
    `${JSON.stringify(await reportPackageSize(options), null, 2)}\n`,
  );
}
