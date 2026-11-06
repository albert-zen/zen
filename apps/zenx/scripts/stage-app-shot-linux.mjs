/** Build-time data only. These resources are never runtime helper candidates. */
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const LINUX_APP_SHOT_HELPERS = {
  kde: {
    directory: "kde-snap-shot",
    executable: "zenx-kde-snap-shot",
    buildInputs: ["Cargo.toml", "src/main.rs", "src/transport_tests.rs"],
    sources: [
      "README.md",
      "Cargo.lock",
      "LICENSE.upstream",
      "UPSTREAM.json",
      "io.github.albert_zen.ZenX.KdeCapture.desktop.in",
    ],
  },
  hyprland: {
    directory: "hyprland-app-shot",
    executable: "zenx-hyprland-snap-shot",
    buildInputs: [
      "Cargo.toml",
      "src/main.rs",
      "src/capture.rs",
      "src/ipc.rs",
      "src/protocols.rs",
      "src/transport_tests.rs",
    ],
    sources: [
      "README.md",
      "Cargo.lock",
      "LICENSE.t3code",
      "LICENSE.hyprland-protocols",
      "upstream.json",
      "protocols/hyprland-toplevel-export-v1.xml",
      "protocols/hyprland-toplevel-mapping-v1.xml",
    ],
  },
};
// Fixed compile/test inputs plus distributed source notices and guides. Update
// this list whenever another module, include_str!/include_bytes! or protocol is linked.
export const LINUX_APP_SHOT_SOURCE_FILES = [
  "LINUX-DISTRIBUTION.md",
  ...Object.values(LINUX_APP_SHOT_HELPERS).flatMap((helper) =>
    [...helper.sources, ...helper.buildInputs].map(
      (file) => `${helper.directory}/${file}`,
    ),
  ),
];
const nativeSourceRoot = fileURLToPath(new URL("../native", import.meta.url));

export const LINUX_APP_SHOT_FILES = [
  "README.md",
  "RUST-COPYRIGHT-library.html",
  ...Object.entries(LINUX_APP_SHOT_HELPERS).flatMap(([name, helper]) =>
    [helper.executable, ...helper.sources, "THIRD-PARTY-NOTICES.txt"].map(
      (file) => `${name}/${file}`,
    ),
  ),
];
const MAX_DOCUMENT_BYTES = 4 * 1024 * 1024;
const MAX_EXECUTABLE_BYTES = 64 * 1024 * 1024;
const EXECUTABLES = Object.entries(LINUX_APP_SHOT_HELPERS).map(
  ([name, helper]) => `${name}/${helper.executable}`,
);
const fixedNames = (actual, expected) =>
  Array.isArray(actual) &&
  actual.length === expected.length &&
  new Set(actual).size === actual.length &&
  expected.every((name) => actual.includes(name));
export const sha256 = (bytes) =>
  createHash("sha256").update(bytes).digest("hex");

/** Bounded regular-file read, with no symlink following or manifest-derived paths. */
export async function readNativeResource(
  filename,
  maximum = MAX_DOCUMENT_BYTES,
  { allowBuildHardlinks = false } = {},
) {
  const entry = await lstat(filename);
  if (
    !entry.isFile() ||
    (!allowBuildHardlinks && entry.nlink !== 1) ||
    entry.size === 0 ||
    entry.size > maximum
  )
    throw new Error(`Invalid Linux App Shot resource file: ${filename}`);
  const file = await open(
    filename,
    constants.O_RDONLY |
      (constants.O_NOFOLLOW ?? 0) |
      (constants.O_NONBLOCK ?? 0),
  );
  try {
    const current = await file.stat();
    if (
      !current.isFile() ||
      current.dev !== entry.dev ||
      current.ino !== entry.ino ||
      current.size !== entry.size ||
      (!allowBuildHardlinks && current.nlink !== 1)
    )
      throw new Error(`Changed Linux App Shot resource file: ${filename}`);
    const buffer = Buffer.alloc(entry.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(
        buffer,
        length,
        buffer.length - length,
        length,
      );
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    const final = await file.stat();
    if (
      length !== entry.size ||
      final.size !== entry.size ||
      final.mtimeMs !== current.mtimeMs ||
      final.ctimeMs !== current.ctimeMs
    )
      throw new Error(`Changed Linux App Shot resource file: ${filename}`);
    return buffer.subarray(0, length);
  } finally {
    await file.close();
  }
}

export async function nativeResourceDirectory(directory, create = false) {
  let entry;
  try {
    entry = await lstat(directory);
  } catch (error) {
    if (error?.code !== "ENOENT" || !create) throw error;
  }
  if (entry) {
    if (!entry.isDirectory() || (await realpath(directory)) !== directory)
      throw new Error(`Unsafe Linux App Shot resource directory: ${directory}`);
    return;
  }
  await nativeResourceDirectory(path.dirname(directory), true);
  await mkdir(directory, { mode: 0o700 });
}

/** Build-time freshness only, not a signature or malicious-artifact authentication.
 * The default checkout root is host-owned; this test seam is never a runtime API.
 * Hash fixed relative names and their byte digests in a stable, unambiguous order.
 */
export async function linuxAppShotSourceDigest(
  nativeSourceDirectory = nativeSourceRoot,
) {
  const root = path.resolve(nativeSourceDirectory);
  await nativeResourceDirectory(root);
  const inputs = [];
  for (const name of LINUX_APP_SHOT_SOURCE_FILES) {
    await nativeResourceDirectory(path.dirname(path.join(root, name)));
    inputs.push([
      name,
      sha256(await readNativeResource(path.join(root, name))),
    ]);
  }
  return sha256(JSON.stringify(["zenx-linux-app-shot-source-v1", inputs]));
}

function versionCompare(a, b) {
  const left = a.split(".").map(Number),
    right = b.split(".").map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff) return diff;
  }
  return 0;
}

// Conservative scan includes weak GLIBC symbols. It is an ABI floor check, not
// ELF authentication or proof of execution on a real compositor/distro.
export function nativeExecutableGlibc(bytes) {
  if (
    bytes.length < 64 ||
    !bytes.subarray(0, 4).equals(Buffer.from([127, 69, 76, 70])) ||
    bytes[4] !== 2 ||
    bytes[5] !== 1 ||
    bytes[6] !== 1 ||
    ![2, 3].includes(bytes.readUInt16LE(16)) ||
    bytes.readUInt16LE(18) !== 62
  )
    throw new Error(
      "Linux App Shot distribution requires x64 Linux ELF executables",
    );
  const versions = [
    ...bytes.toString("latin1").matchAll(/GLIBC_(\d+\.\d+(?:\.\d+)?)\x00/gu),
  ].map((match) => match[1]);
  if (!versions.length)
    throw new Error("Missing Linux App Shot glibc symbol evidence");
  return versions.sort(versionCompare).at(-1);
}

async function exactTree(directory, files) {
  await nativeResourceDirectory(directory);
  const children = [...new Set(files.map((file) => file.split("/")[0]))];
  if (!fixedNames(await readdir(directory), children))
    throw new Error(
      "Linux App Shot bundle requires exactly the fixed distribution files",
    );
  for (const child of children) {
    const nested = files
      .filter((file) => file.startsWith(child + "/"))
      .map((file) => file.slice(child.length + 1));
    if (nested.length) await exactTree(path.join(directory, child), nested);
  }
}

export async function readLinuxAppShotDistribution(
  sourceDirectory,
  { arch = process.arch, requirePortable = true, nativeSourceDirectory } = {},
) {
  if (arch !== "x64")
    throw new Error(
      "Linux App Shot native distributions currently support x64 only; arm64 is not built or verified",
    );
  const source = path.resolve(sourceDirectory);
  await exactTree(source, [...LINUX_APP_SHOT_FILES, "manifest.json"]);
  const files = new Map();
  for (const name of [...LINUX_APP_SHOT_FILES, "manifest.json"])
    files.set(
      name,
      await readNativeResource(
        path.join(source, name),
        EXECUTABLES.includes(name) ? MAX_EXECUTABLE_BYTES : MAX_DOCUMENT_BYTES,
      ),
    );
  const manifest = JSON.parse(files.get("manifest.json").toString("utf8"));
  if (
    !manifest ||
    !fixedNames(Object.keys(manifest), [
      "schemaVersion",
      "platform",
      "architecture",
      "targetTriple",
      "rustc",
      "glibc",
      "fullTestsRun",
      "sourceSha256",
      "files",
    ]) ||
    manifest.schemaVersion !== 1 ||
    manifest.platform !== "linux" ||
    manifest.architecture !== arch ||
    manifest.targetTriple !== "x86_64-unknown-linux-gnu" ||
    typeof manifest.rustc !== "string" ||
    !/^rustc [\w. +-]{1,200}(?:\([^\n]{1,200}\))?$/u.test(manifest.rustc) ||
    typeof manifest.fullTestsRun !== "boolean" ||
    typeof manifest.sourceSha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(manifest.sourceSha256) ||
    !manifest.files ||
    !fixedNames(Object.keys(manifest.files), LINUX_APP_SHOT_FILES) ||
    !manifest.glibc ||
    !fixedNames(
      Object.keys(manifest.glibc),
      Object.keys(LINUX_APP_SHOT_HELPERS),
    )
  )
    throw new Error("Invalid Linux App Shot distribution manifest");
  for (const name of LINUX_APP_SHOT_FILES) {
    if (
      !/^[a-f0-9]{64}$/u.test(manifest.files[name]) ||
      sha256(files.get(name)) !== manifest.files[name]
    )
      throw new Error(`Linux App Shot checksum mismatch: ${name}`);
  }
  if (
    manifest.sourceSha256 !==
    (await linuxAppShotSourceDigest(nativeSourceDirectory))
  )
    throw new Error(
      "Stale Linux App Shot source digest: rebuild for this checkout",
    );
  for (const [name, helper] of Object.entries(LINUX_APP_SHOT_HELPERS)) {
    const glibc = nativeExecutableGlibc(
      files.get(`${name}/${helper.executable}`),
    );
    if (manifest.glibc[name] !== glibc)
      throw new Error(`Linux App Shot glibc evidence mismatch: ${name}`);
    if (requirePortable && versionCompare(glibc, "2.35") > 0)
      throw new Error(
        `Linux App Shot ${name} requires glibc ${glibc}; build portable releases on Ubuntu 22.04 (glibc <= 2.35)`,
      );
  }
  if (requirePortable && !manifest.fullTestsRun)
    throw new Error(
      "Linux App Shot packaging requires full native test evidence",
    );
  return { files, manifest };
}

/** Full-app preparation only; never downloads or installs a toolchain/helper. */
export async function prepareLinuxAppShotResources({
  target,
  platform = process.platform,
  arch = process.arch,
  stagingDirectory,
  sourceDirectory = process.env.ZENX_APP_SHOT_LINUX_DIST,
  nativeSourceDirectory,
  build,
}) {
  if (target !== "app" || platform !== "linux") return undefined;
  if (arch !== "x64") {
    if (sourceDirectory)
      throw new Error(
        "Explicit Linux App Shot artifacts require x64; this architecture is not built or verified",
      );
    return undefined;
  }
  let source = sourceDirectory;
  if (!source) {
    source = path.join(stagingDirectory, "app-shot-linux");
    const compile =
      build ??
      (await import("./build-app-shot-linux.mjs"))
        .buildLinuxAppShotDistribution;
    await compile({ outputDirectory: source });
  }
  await readLinuxAppShotDistribution(source, { arch, nativeSourceDirectory });
  return source;
}

/** Stage captured bytes as non-executable data outside app/ASAR. No runtime install. */
export async function copyLinuxAppShotResources({
  buildPath,
  sourceDirectory,
  nativeSourceDirectory,
  target,
  platform = process.platform,
  arch = process.arch,
}) {
  if (target !== "app" || platform !== "linux") return undefined;
  if (arch !== "x64") {
    if (sourceDirectory)
      throw new Error(
        "Explicit Linux App Shot artifacts require x64; this architecture is not built or verified",
      );
    return undefined;
  }
  const source = path.resolve(sourceDirectory);
  const resources = path.dirname(path.resolve(buildPath));
  const destination = path.join(resources, "app-shot-linux");
  if (
    source === destination ||
    source.startsWith(destination + path.sep) ||
    destination.startsWith(source + path.sep)
  )
    throw new Error("Linux App Shot source and destination must not overlap");
  const { files } = await readLinuxAppShotDistribution(source, {
    arch,
    nativeSourceDirectory,
  });
  await nativeResourceDirectory(resources, true);
  // Private packager directory, not a hostile-writer sandbox. Refuse stale output.
  await mkdir(destination, { mode: 0o700 });
  for (const [name, bytes] of files) {
    await nativeResourceDirectory(
      path.dirname(path.join(destination, name)),
      true,
    );
    await writeFile(path.join(destination, name), bytes, {
      flag: "wx",
      mode: 0o644,
    });
  }
  return destination;
}
