import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Electron 的校验清单（SHASUMS256.txt）由 @electron/get 刻意每次重取。
 * 版本一旦钉死，清单就不会变，所以这里把它落在构建缓存里：首次取回后，
 * 后续构建直接把清单作为 download.checksums 传入，仍然逐条校验产物，
 * 但不再需要访问 GitHub release 资产。
 */
export async function electronDownloadOptions({
  version,
  platform,
  arch,
  cacheDirectory,
  acquireChecksums = downloadChecksums,
}) {
  const artifactName = `electron-v${version}-${platform}-${arch}.zip`;
  const cacheFile = path.join(
    cacheDirectory,
    `electron-v${version}.SHASUMS256.txt`,
  );
  const cached = await readChecksums(cacheFile);
  if (cached !== undefined && cached[artifactName] !== undefined)
    return { checksums: cached };

  const text = await acquireChecksums(
    `https://github.com/electron/electron/releases/download/v${version}/SHASUMS256.txt`,
  );
  const checksums = parseChecksums(text);
  if (checksums[artifactName] === undefined)
    throw new Error(
      `Electron checksums for v${version} do not cover ${artifactName}`,
    );
  await mkdir(cacheDirectory, { recursive: true });
  const staged = path.join(
    cacheDirectory,
    `.${path.basename(cacheFile)}-${process.pid}`,
  );
  try {
    await writeFile(staged, `${text.trimEnd()}\n`, "utf8");
    await rename(staged, cacheFile);
  } finally {
    await rm(staged, { force: true });
  }
  return { checksums };
}

export function parseChecksums(text) {
  const checksums = {};
  for (const line of text.split("\n")) {
    const match = /^([0-9a-f]{64})\s+\*?(.+)$/.exec(line.trim());
    if (match !== null) checksums[match[2].trim()] = match[1];
  }
  if (Object.keys(checksums).length === 0)
    throw new Error("Electron checksums file contained no entries");
  return checksums;
}

async function readChecksums(cacheFile) {
  try {
    return parseChecksums(await readFile(cacheFile, "utf8"));
  } catch {
    /* Missing or unreadable cache; fetch the pinned release manifest below. */
    return undefined;
  }
}

async function downloadChecksums(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok)
    throw new Error(
      `Electron checksums download failed: HTTP ${response.status}`,
    );
  return await response.text();
}
