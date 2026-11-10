import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { appendFile, lstat, open, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sha256 = /^[a-f0-9]{64}$/u;
const version = /^\d+\.\d+\.\d+$/u;

// Before npm ci: the checked-in checksum projection is bound to the npm tarball
// integrity in package-lock, not an installed package or mutable SHASUMS URL.
export async function archivePlan({
  root = process.cwd(),
  platform = process.platform,
  arch = process.arch,
} = {}) {
  root = path.resolve(root);
  const lock = JSON.parse(
    await readFile(
      path.join(root, "scripts/desktop-archives.lock.json"),
      "utf8",
    ),
  );
  const npmLock = JSON.parse(
    await readFile(path.join(root, "package-lock.json"), "utf8"),
  );
  const e = lock.electron;
  const npmElectron = npmLock.packages?.["node_modules/electron"];
  if (
    lock.schema !== 1 ||
    !version.test(e?.version) ||
    npmElectron?.version !== e.version ||
    npmElectron?.integrity !== e.packageIntegrity ||
    npmElectron?.resolved !== e.packageUrl ||
    e.packageUrl !==
      `https://registry.npmjs.org/electron/-/electron-${e.version}.tgz` ||
    !/^sha512-[A-Za-z0-9+/]+=*$/u.test(e.packageIntegrity)
  ) {
    throw new Error(
      "Electron archive authority must match the npm lock; refresh the audited checksum projection",
    );
  }
  if (
    !/^(linux|darwin|win32)$/u.test(platform) ||
    !/^(x64|arm64|armv7l|ia32)$/u.test(arch)
  ) {
    throw new Error(`Unsupported archive target ${platform}-${arch}`);
  }
  const filename = `electron-v${e.version}-${platform}-${arch}.zip`;
  if (!sha256.test(e.checksums?.[filename]))
    throw new Error(`Missing pinned Electron checksum for ${filename}`);
  const cacheRoot = path.join(root, "apps/zenx/.packaged/cache/electron");
  // @electron/get Cache.getCacheDirectory hashes the URL's directory (without
  // query/hash or a trailing slash), not the full archive URL.
  const urlDirectory = `https://github.com/electron/electron/releases/download/v${e.version}`;
  const electron = {
    name: "electron",
    version: e.version,
    platform,
    arch,
    filename,
    sha256: e.checksums[filename],
    file: path.join(cacheRoot, digest(urlDirectory), filename),
    key: `desktop-electron-v1-${platform}-${arch}-${e.version}-${e.checksums[filename]}`,
    authority: `npm-lock:${e.packageIntegrity}`,
  };
  const r = lock.rtk;
  if (
    !version.test(r?.version) ||
    r.platform !== "darwin" ||
    r.arch !== "arm64" ||
    !sha256.test(r.archiveSha256) ||
    !sha256.test(r.binarySha256) ||
    r.url !==
      `https://github.com/rtk-ai/rtk/releases/download/v${r.version}/rtk-aarch64-apple-darwin.tar.gz`
  ) {
    throw new Error("Invalid pinned RTK archive authority");
  }
  const rtk =
    platform === r.platform && arch === r.arch
      ? {
          name: "rtk",
          version: r.version,
          platform,
          arch,
          sha256: r.archiveSha256,
          file: path.join(
            root,
            `apps/zenx/.packaged/cache/rtk/v${r.version}/${platform}-${arch}/sha256/${r.archiveSha256}`,
          ),
          key: `desktop-rtk-v1-${platform}-${arch}-${r.version}-${r.archiveSha256}`,
          authority: "desktop-archives.lock.json:rtk.archiveSha256",
        }
      : undefined;
  return { root, cacheRoot, electron, rtk };
}

async function regularArchive(root, file) {
  const relative = path.relative(root, file);
  if (relative.startsWith("..") || path.isAbsolute(relative))
    throw new Error("Archive escaped workspace");
  let current = root;
  const parts = relative.split(path.sep);
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    let stat;
    try {
      stat = await lstat(current);
    } catch (error) {
      if (error.code === "ENOENT") return false;
      throw error;
    }
    if (
      stat.isSymbolicLink() ||
      (index < parts.length - 1 ? !stat.isDirectory() : !stat.isFile())
    ) {
      throw new Error(
        `Archive path is not an ordinary file/directory: ${current}`,
      );
    }
  }
  return true;
}

export async function verifyArchive(
  plan,
  artifact,
  { installedAuthority = false, discardInvalid = false } = {},
) {
  if (!artifact || !(await regularArchive(plan.root, artifact.file)))
    return { verified: false, status: "miss" };
  if (installedAuthority && artifact.name === "electron") {
    const directory = path.join(plan.root, "node_modules/electron");
    const pkg = JSON.parse(
      await readFile(path.join(directory, "package.json"), "utf8"),
    );
    const checksums = JSON.parse(
      await readFile(path.join(directory, "checksums.json"), "utf8"),
    );
    if (
      pkg.version !== artifact.version ||
      checksums[artifact.filename] !== artifact.sha256
    ) {
      throw new Error(
        "Installed Electron checksum authority differs from the audited npm lock projection",
      );
    }
  }
  const handle = await open(
    artifact.file,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  let actual;
  try {
    if (!(await handle.stat()).isFile())
      throw new Error("Archive is not an ordinary file");
    const hash = createHash("sha256");
    for await (const bytes of handle.createReadStream({ autoClose: false }))
      hash.update(bytes);
    actual = hash.digest("hex");
  } finally {
    await handle.close();
  }
  if (actual !== artifact.sha256) {
    if (discardInvalid) await unlink(artifact.file);
    return {
      verified: false,
      status: discardInvalid ? "rejected-and-removed" : "rejected",
    };
  }
  return { verified: true, status: "verified" };
}

export async function runArchiveCache(
  phase,
  { root = process.cwd(), env = process.env, log = console.log } = {},
) {
  if (!["plan", "restored", "save"].includes(phase))
    throw new Error("Expected plan, restored or save phase");
  // Mirrors/overridden targets change @electron/get's URL hash or checksum
  // authority. Never advertise a cache hit for a different consumer target.
  const mirrorOverrides = [
    "mirror",
    "customDir",
    "customFilename",
    "customVersion",
  ].flatMap((name) => {
    const snake = name.replace(/([a-z])([A-Z])/gu, "$1_$2").toLowerCase();
    return [
      `npm_config_electron_${name.toLowerCase()}`,
      `NPM_CONFIG_ELECTRON_${snake.toUpperCase()}`,
      `npm_config_electron_${snake}`,
      `npm_package_config_electron_${name}`,
      `npm_package_config_electron_${snake}`,
      `ELECTRON_${snake.toUpperCase()}`,
    ];
  });
  for (const key of [
    ...mirrorOverrides,
    "ELECTRON_MIRROR",
    "npm_config_electron_mirror",
    "ELECTRON_CUSTOM_DIR",
    "ELECTRON_CUSTOM_FILENAME",
    "electron_use_remote_checksums",
    "npm_config_electron_use_remote_checksums",
    "ELECTRON_INSTALL_PLATFORM",
    "ELECTRON_INSTALL_ARCH",
    "npm_config_platform",
    "npm_config_arch",
  ]) {
    if (env[key])
      throw new Error(`Desktop archive cache does not support ${key}`);
  }
  const plan = await archivePlan({ root });
  if (
    env.electron_config_cache &&
    path.resolve(env.electron_config_cache) !== plan.cacheRoot
  ) {
    throw new Error(
      "Electron installer cache root differs from the archive plan",
    );
  }
  const output = {
    "electron-path": plan.electron.file,
    "electron-key": plan.electron.key,
    "rtk-enabled": String(Boolean(plan.rtk)),
    "rtk-path": plan.rtk?.file ?? "",
    "rtk-key": plan.rtk?.key ?? "",
  };
  if (phase === "plan" && env.GITHUB_ENV)
    await appendFile(
      env.GITHUB_ENV,
      `electron_config_cache=${plan.cacheRoot}\n`,
    );
  for (const artifact of [plan.electron, plan.rtk].filter(Boolean)) {
    const result =
      phase === "plan"
        ? { status: "planned" }
        : await verifyArchive(plan, artifact, {
            installedAuthority: phase === "save",
            discardInvalid: phase === "restored",
          });
    output[`${artifact.name}-verified`] = String(result.verified === true);
    const message = `${artifact.name} archive ${phase}: ${result.status}; actions-cache-hit=${env[`DESKTOP_${artifact.name.toUpperCase()}_CACHE_HIT`] || "not-reported"}; target=${artifact.platform}-${artifact.arch}; version=${artifact.version}; sha256=${artifact.sha256}; authority=${artifact.authority}`;
    log(message);
    if (env.GITHUB_STEP_SUMMARY)
      await appendFile(env.GITHUB_STEP_SUMMARY, `${message}\n\n`);
  }
  if (env.GITHUB_OUTPUT)
    await appendFile(
      env.GITHUB_OUTPUT,
      Object.entries(output)
        .map(([key, value]) => `${key}=${value}\n`)
        .join(""),
    );
  return output;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await runArchiveCache(process.argv[2]);
