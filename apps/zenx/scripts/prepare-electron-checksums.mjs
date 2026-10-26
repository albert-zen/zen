import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
export const ELECTRON_VERSION = "43.2.0";

/** Use the checksum authority shipped in the npm-lockfile-pinned Electron package.
 * @electron/get still verifies every ZIP, including its existing warm cache;
 * unlike an independently cached SHASUMS256.txt, no mutable manifest is trusted.
 */
export async function electronDownloadOptions({
  version = ELECTRON_VERSION,
  platform = process.platform,
  arch = process.arch,
  packageDirectory = path.dirname(require.resolve("electron/package.json")),
} = {}) {
  const manifest = JSON.parse(
    await readFile(path.join(packageDirectory, "package.json"), "utf8"),
  );
  if (manifest.version !== version) {
    throw new Error(
      `Electron package version must match packaging pin ${version}`,
    );
  }
  const checksums = JSON.parse(
    await readFile(path.join(packageDirectory, "checksums.json"), "utf8"),
  );
  const artifactName = `electron-v${version}-${platform}-${arch}.zip`;
  const digest = checksums?.[artifactName];
  if (typeof digest !== "string" || !/^[a-f0-9]{64}$/u.test(digest)) {
    throw new Error(`Electron package checksums do not cover ${artifactName}`);
  }
  return {
    checksums: { [artifactName]: digest },
  };
}
