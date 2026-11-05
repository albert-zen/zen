import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

const UUID = "app-shot@zenx.local";
const VERSION = 3;
const RUNTIME_FILES = [
  "metadata.json",
  "extension.js",
  "captureService.js",
  "captureFeedback.js",
  "feedbackGeometry.js",
];
const BUNDLE_FILES = [
  ...RUNTIME_FILES,
  "bundle.json",
  "LICENSE",
  "README.md",
  "upstream.json",
];
const MAX_FILE_BYTES = 1024 * 1024;

function sameNames(actual, expected) {
  return (
    Array.isArray(actual) &&
    actual.length === expected.length &&
    expected.every((name) => actual.includes(name))
  );
}

async function regularFile(filename) {
  const entry = await lstat(filename);
  if (!entry.isFile() || entry.size === 0 || entry.size > MAX_FILE_BYTES)
    throw new Error(`Invalid GNOME App Shot resource file: ${filename}`);
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
      current.size !== entry.size
    )
      throw new Error(`Changed GNOME App Shot resource file: ${filename}`);
    const bytes = await file.readFile();
    if (bytes.length !== entry.size)
      throw new Error(`Changed GNOME App Shot resource file: ${filename}`);
    return bytes;
  } finally {
    await file.close();
  }
}

// Check each existing parent before creating anything below it. This is build
// staging in a private run directory, not an OS-atomic hostile-writer boundary.
async function resourceDirectory(directory) {
  let entry;
  try {
    entry = await lstat(directory);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (entry) {
    if (!entry.isDirectory() || (await realpath(directory)) !== directory)
      throw new Error(`Unsafe GNOME App Shot resource directory: ${directory}`);
    return;
  }
  await resourceDirectory(path.dirname(directory));
  await mkdir(directory);
}

/** Offline source distribution only. Never executes, installs or enables the extension. */
export async function copyGnomeAppShotResource({
  buildPath,
  sourceDirectory,
  target,
  platform = process.platform,
}) {
  if (target !== "app" || platform !== "linux") return undefined;
  const source = path.resolve(sourceDirectory);
  const resources = path.dirname(path.resolve(buildPath));
  const destination = path.join(resources, "app-shot-gnome");
  if (
    source === destination ||
    source.startsWith(destination + path.sep) ||
    destination.startsWith(source + path.sep)
  )
    throw new Error("GNOME App Shot source and destination must not overlap");
  if (
    !(await lstat(source)).isDirectory() ||
    (await realpath(source)) !== source
  )
    throw new Error("Unsafe GNOME App Shot source directory");
  if (!sameNames(await readdir(source), BUNDLE_FILES))
    throw new Error(
      "GNOME App Shot bundle requires exactly the fixed distribution files",
    );

  // Read and validate every required file before writing to App Resources. No
  // path comes from the manifest, and only these captured bytes are staged.
  const files = new Map();
  for (const name of BUNDLE_FILES)
    files.set(name, await regularFile(path.join(source, name)));
  const manifest = JSON.parse(files.get("bundle.json").toString("utf8"));
  if (
    !manifest ||
    !sameNames(Object.keys(manifest), ["uuid", "files"]) ||
    manifest.uuid !== UUID ||
    !sameNames(manifest.files, RUNTIME_FILES)
  )
    throw new Error("Invalid GNOME App Shot bundle manifest");
  const metadata = JSON.parse(files.get("metadata.json").toString("utf8"));
  if (metadata?.uuid !== UUID || metadata?.version !== VERSION)
    throw new Error(
      `GNOME App Shot metadata requires ${UUID} version ${VERSION}`,
    );

  await resourceDirectory(resources);
  // afterCopy owns a fresh private resource directory. Refuse existing bundles
  // instead of following links, replacing files or merging stale source files.
  await mkdir(destination);
  for (const [name, bytes] of files)
    await writeFile(path.join(destination, name), bytes, { flag: "wx" });
  return destination;
}
