import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  rm,
  writeFile,
  readdir,
  stat,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { acquireVerifiedArtifact } from "./verified-artifact-acquisition.mjs";

const run = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const zenx = path.resolve(here, "..", "apps", "zenx");
const defaultLockPath = path.join(
  zenx,
  "resources",
  "providers",
  "provider-lock.json",
);
const maxAssetBytes = 512 * 1024 * 1024;
const artifactDownloadMilliseconds = 2 * 60 * 1_000;
const maxBrowserPayloadEntries = 20_000;
const maxBrowserPayloadBytes = 2 * 1024 * 1024 * 1024;
const playwrightBrowserRuntimeStatePaths = ["DEPENDENCIES_VALIDATED"];
let lock;
let artifactCache;
let providers;
let work;

if (isDirectExecution()) {
  process.stdout.write(
    `${JSON.stringify(await assembleZenXProviders(process.argv.slice(2)))}\n`,
  );
}

export async function assembleZenXProviders(arguments_) {
  const outputArgument = argumentValue(arguments_, "--output");
  const cacheArgument = argumentValue(arguments_, "--cache");
  const lockArgument = argumentValue(arguments_, "--provider-lock");
  lock = JSON.parse(
    await readFile(path.resolve(lockArgument ?? defaultLockPath), "utf8"),
  );
  const runs = path.join(zenx, ".packaged", "runs");
  await mkdir(runs, { recursive: true, mode: 0o700 });
  const defaultRun =
    outputArgument === undefined
      ? await mkdtemp(path.join(runs, "provider-assembly-"))
      : undefined;
  const output = path.resolve(
    outputArgument ?? path.join(defaultRun, "resources"),
  );
  artifactCache = path.resolve(
    cacheArgument ?? path.join(zenx, ".packaged", "cache", "artifacts"),
  );
  providers = path.join(output, "providers");
  work = await mkdtemp(path.join(os.tmpdir(), "zenx-provider-assembly-"));

  try {
    await rm(providers, { recursive: true, force: true });
    await mkdir(providers, { recursive: true, mode: 0o700 });
    const platform = process.platform;
    const arch = process.arch === "arm64" ? "arm64" : "x64";
    const nodeKey = `${platform}-${arch}`;
    const nodeArchive = lock.node.platformArchives[nodeKey];
    if (nodeArchive === undefined)
      throw new Error(`No pinned Node runtime for ${nodeKey}`);
    const nodeArchivePath = await acquireArtifact(
      `Node.js ${lock.node.version} ${nodeKey} runtime`,
      `${lock.node.releaseBase}${nodeArchive.file}`,
      nodeArchive.sha256,
    );
    const nodeExtract = path.join(work, "node");
    await mkdir(nodeExtract);
    await extract(nodeArchivePath, nodeExtract);
    const nodeExecutable = await findFile(
      nodeExtract,
      platform === "win32" ? "node.exe" : "node",
    );
    const runtimePath = path.join(
      providers,
      "runtime",
      path.basename(nodeExecutable),
    );
    await mkdir(path.dirname(runtimePath), { recursive: true, mode: 0o700 });
    await cp(nodeExecutable, runtimePath);
    const nodeLicense = await findFile(nodeExtract, "LICENSE");
    await cp(nodeLicense, path.join(path.dirname(runtimePath), "LICENSE"));
    await writeFile(
      path.join(path.dirname(runtimePath), "THIRD_PARTY_NOTICES.txt"),
      `Node.js ${lock.node.version} — bundled official runtime\n\n${await readFile(nodeLicense, "utf8")}`,
      { mode: 0o600 },
    );
    const runtimeSha256 = sha256(await readFile(runtimePath));

    const playwright = await assembleNpmProvider(
      "playwright-cli",
      platform,
      runtimePath,
    );
    const winapp = await assembleNpmProvider(
      "microsoft-winapp-cli",
      platform,
      runtimePath,
    );
    const browser = await assemblePlaywrightBrowser({
      pin: lock.browser,
      platform,
      arch,
      providersDirectory: providers,
      playwrightDirectory: path.join(providers, "playwright-cli"),
      cacheLocation: artifactCache,
      deadline: Date.now() + artifactDownloadMilliseconds,
    });
    playwright.assets.push(...browser.assets);
    const manifest = {
      schemaVersion: 1,
      providers: {
        "playwright-cli": {
          executable: playwright.executable,
          version: lock.providers["playwright-cli"].version,
          sha256: playwright.sha256,
          platforms: [platform],
          runtime: {
            path: path.relative(providers, runtimePath),
            sha256: runtimeSha256,
            version: lock.node.version,
          },
          assets: playwright.assets,
        },
        "microsoft-winapp-cli": {
          executable: winapp.executable,
          version: lock.providers["microsoft-winapp-cli"].version,
          sha256: winapp.sha256,
          platforms: ["win32"],
          runtime: {
            path: path.relative(providers, runtimePath),
            sha256: runtimeSha256,
            version: lock.node.version,
          },
          assets: winapp.assets,
        },
      },
    };
    const manifestBytes = Buffer.from(
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8",
    );
    await writeFile(path.join(providers, "manifest.json"), manifestBytes, {
      mode: 0o600,
    });
    await writeFile(
      path.join(providers, "THIRD_PARTY_NOTICES.txt"),
      `ZenX bundled provider notices\n\n@playwright/cli ${lock.providers["playwright-cli"].version} — Apache-2.0\nPlaywright Chromium ${lock.browser.version} (revision ${lock.browser.revision}) — bundled official browser\n@microsoft/winappcli ${lock.providers["microsoft-winapp-cli"].version} — MIT\nNode.js ${lock.node.version} — bundled official runtime; see nodejs.org/dist/${lock.node.version}/README.md\n\nArchive SHA-256:\n@playwright/cli ${lock.providers["playwright-cli"].sha256}\nPlaywright Chromium ${browser.archiveSha256}\n@microsoft/winappcli ${lock.providers["microsoft-winapp-cli"].sha256}\nNode ${nodeArchive.sha256}\n\nThe complete upstream license texts are copied beside each assembled provider payload.\n`,
      { mode: 0o600 },
    );
    const result = {
      resourcesDirectory: output,
      manifestSha256: sha256(manifestBytes),
      platform,
      arch,
      runtimeVersion: lock.node.version,
      browserRevision: lock.browser.revision,
      releaseSizeBytes: await directorySize(output),
    };
    await writeFile(
      path.join(output, "provider-assembly.json"),
      `${JSON.stringify(result, null, 2)}\n`,
      { mode: 0o600 },
    );
    return result;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

export async function assemblePlaywrightBrowser(options) {
  const { pin, platform, arch } = options;
  const platformKey = `${platform}-${arch === "arm64" ? "arm64" : "x64"}`;
  const archive = pin?.platformArchives?.[platformKey];
  if (archive === undefined) {
    throw new Error(`No pinned Playwright browser archive for ${platformKey}`);
  }
  await verifyPlaywrightBrowserPin(pin, options.playwrightDirectory);
  const archivePath = await acquireVerifiedArtifact({
    artifactName: `Playwright ${pin.name} ${pin.version} revision ${pin.revision} ${platformKey}`,
    url: archive.url,
    digest: archive.sha256,
    deadline: options.deadline,
    cacheLocation: options.cacheLocation,
  });
  const browsersDirectory = path.join(
    options.providersDirectory,
    "playwright-browsers",
  );
  const browserDirectory = path.join(
    browsersDirectory,
    `${pin.name}-${pin.revision}`,
  );
  const executable = resolvePinnedBrowserPath(
    browserDirectory,
    archive.executable,
  );
  await mkdir(browsersDirectory, { recursive: true, mode: 0o700 });
  await rm(browserDirectory, { recursive: true, force: true });
  await mkdir(browserDirectory, { recursive: true, mode: 0o700 });
  try {
    await (options.extractArchive ?? extract)(archivePath, browserDirectory);
    const executableStat = await lstat(executable);
    if (executableStat.isSymbolicLink() || !executableStat.isFile()) {
      throw new Error(
        `Pinned Playwright browser executable is unavailable at ${executable}`,
      );
    }
    if (executableStat.size > maxAssetBytes) {
      throw new Error("Pinned Playwright browser executable exceeds the bound");
    }
    if (
      !isWithin(await realpath(browserDirectory), await realpath(executable))
    ) {
      throw new Error("Pinned Playwright browser executable escapes its root");
    }
    await chmod(executable, 0o755);
    await writeFile(path.join(browserDirectory, "INSTALLATION_COMPLETE"), "", {
      mode: 0o600,
    });
    await writeFile(
      path.join(browserDirectory, "ARCHIVE-SHA256"),
      `${archive.sha256}\n`,
      { mode: 0o600 },
    );
    return {
      archiveSha256: archive.sha256,
      browserDirectory,
      executable,
      assets: [
        {
          path: path.relative(options.providersDirectory, browserDirectory),
          sha256: await hashBrowserPayloadDirectory(
            browserDirectory,
            playwrightBrowserRuntimeStatePaths,
          ),
          kind: "directory",
          ignoredPaths: playwrightBrowserRuntimeStatePaths,
        },
        {
          path: path.relative(options.providersDirectory, executable),
          sha256: await hashFile(executable),
        },
      ],
    };
  } catch (error) {
    await rm(browserDirectory, { recursive: true, force: true });
    throw error;
  }
}

export async function hashBrowserPayloadDirectory(
  rootDirectory,
  ignoredPaths = [],
) {
  const root = await realpath(rootDirectory);
  const hash = createHash("sha256");
  const ignored = new Set(ignoredPaths);
  let entriesSeen = 0;
  let bytesSeen = 0;

  const visit = async (directory, relativeDirectory) => {
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
            `Playwright browser runtime state must be a regular file: ${relative}`,
          );
        }
        continue;
      }
      entriesSeen += 1;
      if (entriesSeen > maxBrowserPayloadEntries) {
        throw new Error("Playwright browser payload exceeds the entry bound");
      }
      const metadata = await lstat(candidate);
      if (metadata.isDirectory()) {
        hash.update(`directory\0${relative}\0`);
        await visit(candidate, relative);
        continue;
      }
      if (metadata.isFile()) {
        bytesSeen += metadata.size;
        if (bytesSeen > maxBrowserPayloadBytes) {
          throw new Error("Playwright browser payload exceeds the size bound");
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
            `Playwright browser payload symlink escapes its root: ${relative}`,
          );
        }
        hash.update(`symlink\0${relative}\0${target}\0`);
        continue;
      }
      throw new Error(
        `Playwright browser payload contains an unsupported entry: ${relative}`,
      );
    }
  };

  await visit(root, "");
  return hash.digest("hex");
}

async function verifyPlaywrightBrowserPin(pin, playwrightDirectory) {
  const browsers = JSON.parse(
    await readFile(
      path.join(
        playwrightDirectory,
        "node_modules",
        "playwright-core",
        "browsers.json",
      ),
      "utf8",
    ),
  ).browsers;
  const browser = browsers?.find((candidate) => candidate.name === pin?.name);
  if (
    browser === undefined ||
    browser.revision !== pin.revision ||
    browser.browserVersion !== pin.version
  ) {
    throw new Error(
      `Playwright browser lock does not match installed playwright-core metadata for ${pin?.name ?? "unknown"}`,
    );
  }
}

function resolvePinnedBrowserPath(browserDirectory, relativePath) {
  if (typeof relativePath !== "string" || path.isAbsolute(relativePath)) {
    throw new Error("Pinned Playwright browser executable path is invalid");
  }
  const segments = relativePath.split("/");
  if (
    segments.some(
      (segment) => segment === "" || segment === "." || segment === "..",
    )
  ) {
    throw new Error("Pinned Playwright browser executable path is invalid");
  }
  const executable = path.resolve(browserDirectory, ...segments);
  if (!isWithin(browserDirectory, executable)) {
    throw new Error("Pinned Playwright browser executable escapes its root");
  }
  return executable;
}

async function hashFile(file) {
  const hash = createHash("sha256");
  const stream = createReadStream(file);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest("hex");
}

async function assembleNpmProvider(id, platform, runtimePath) {
  const pin = lock.providers[id];
  const archivePath = await acquireArtifact(
    `${id} ${pin.version}`,
    pin.tarball,
    pin.sha256,
  );
  await verifyNpmIntegrity(id, archivePath, pin.integrity);
  const extracted = path.join(work, id);
  await mkdir(extracted);
  await extract(archivePath, extracted);
  const packageDir = path.join(extracted, "package");
  const destination = path.join(providers, id);
  await cp(packageDir, destination, { recursive: true, force: true });
  if (id === "playwright-cli") {
    for (const dependency of pin.transitive ?? []) {
      const dependencyArchive = await acquireArtifact(
        `${dependency.name} ${dependency.version}`,
        dependency.tarball,
        dependency.sha256,
      );
      await verifyNpmIntegrity(
        dependency.name,
        dependencyArchive,
        dependency.integrity,
      );
      await installPinnedDependency(dependency, dependencyArchive, destination);
    }
  }
  const executable =
    id === "playwright-cli"
      ? path.join(destination, "playwright-cli.js")
      : path.join(destination, "dist", "cli.js");
  const relative = path.relative(providers, executable);
  const bytes = await readFile(executable);
  if (bytes.byteLength > maxAssetBytes)
    throw new Error(`${id} executable exceeds the release bound`);
  await writeFile(
    path.join(destination, "ARCHIVE-SHA256"),
    `${pin.sha256}\n${pin.integrity}\n`,
    { mode: 0o600 },
  );
  const license = path.join(destination, "LICENSE");
  if (!(await exists(license)))
    await writeFile(license, `${id} — ${pin.license}\n`, { mode: 0o600 });
  await appendLicenseNotice(destination, id, pin.license);
  const assets = [];
  if (id === "playwright-cli") {
    const dependencyLock = canonicalDependencyLock(pin.transitive ?? []);
    const dependencyLockSha256 = sha256(dependencyLock);
    if (
      pin.dependencyLockSha256 !== undefined &&
      dependencyLockSha256 !== pin.dependencyLockSha256
    ) {
      throw new Error(
        `playwright-cli transitive dependency lock mismatch: expected ${pin.dependencyLockSha256}, got ${dependencyLockSha256}`,
      );
    }
    const dependencyLockPath = path.join(destination, "DEPENDENCY-LOCK.json");
    await writeFile(dependencyLockPath, dependencyLock, { mode: 0o600 });
    assets.push({
      path: path.relative(providers, dependencyLockPath),
      sha256: dependencyLockSha256,
    });
  }
  if (id === "microsoft-winapp-cli") {
    const nativeRoot = path.join(
      destination,
      "bin",
      platform === "win32" ? "win-x64" : "unsupported",
    );
    if (platform === "win32") {
      const nativeExecutable = path.join(nativeRoot, "winapp.exe");
      if (!(await exists(nativeExecutable)))
        throw new Error(
          "WinApp native companion is missing from the official archive",
        );
      const nativeBytes = await readFile(nativeExecutable);
      assets.push({
        path: path.relative(providers, nativeExecutable),
        sha256: sha256(nativeBytes),
      });
    }
  }
  return { executable: relative, sha256: sha256(bytes), runtimePath, assets };
}

async function appendLicenseNotice(destination, id, license) {
  const notices = [];
  for (const file of await walkFiles(destination)) {
    if (!/\/(?:LICENSE|NOTICE)(?:\.[^/]*)?$/iu.test(file.replaceAll("\\", "/")))
      continue;
    notices.push(
      `\n--- ${path.relative(destination, file)} ---\n${await readFile(file, "utf8")}`,
    );
  }
  await writeFile(
    path.join(destination, "THIRD_PARTY_NOTICES.txt"),
    `${id} declared license: ${license}\n${notices.join("\n")}`,
    { mode: 0o600 },
  );
}

async function walkFiles(rootDir) {
  const files = [];
  for (const entry of await readdir(rootDir, { withFileTypes: true })) {
    const candidate = path.join(rootDir, entry.name);
    if (entry.isFile()) files.push(candidate);
    else if (entry.isDirectory()) files.push(...(await walkFiles(candidate)));
  }
  return files;
}

async function extract(archive, destination) {
  await run("tar", ["-xf", archive, "-C", destination]);
}

async function acquireArtifact(artifactName, url, digest) {
  return await acquireVerifiedArtifact({
    artifactName,
    url,
    digest,
    deadline: Date.now() + artifactDownloadMilliseconds,
    cacheLocation: artifactCache,
  });
}

async function verifyNpmIntegrity(id, archive, integrity) {
  const separator = integrity.indexOf("-");
  const algorithm = integrity.slice(0, separator);
  const expected = integrity.slice(separator + 1);
  if (algorithm !== "sha512" || expected.length === 0) {
    throw new Error(`${id} has an unsupported npm integrity pin`);
  }
  const hash = createHash(algorithm);
  const file = createReadStream(archive);
  for await (const chunk of file) hash.update(chunk);
  if (hash.digest("base64") !== expected) {
    throw new Error(`${id} npm integrity mismatch`);
  }
}

async function installPinnedDependency(dependency, archive, destination) {
  const extracted = path.join(
    work,
    `dependency-${dependency.name.replaceAll("/", "-")}`,
  );
  await mkdir(extracted);
  await extract(archive, extracted);
  const packageDirectory = path.join(extracted, "package");
  const metadata = JSON.parse(
    await readFile(path.join(packageDirectory, "package.json"), "utf8"),
  );
  if (
    metadata.name !== dependency.name ||
    metadata.version !== dependency.version
  ) {
    throw new Error(
      `playwright-cli transitive package mismatch for ${dependency.name}`,
    );
  }
  const dependencyDirectory = path.join(
    destination,
    "node_modules",
    ...dependency.name.split("/"),
  );
  await mkdir(path.dirname(dependencyDirectory), {
    recursive: true,
    mode: 0o700,
  });
  await cp(packageDirectory, dependencyDirectory, {
    recursive: true,
    force: true,
  });
}

async function findFile(root, name) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const candidate = path.join(root, entry.name);
    if (entry.isFile() && entry.name === name) return candidate;
    if (entry.isDirectory()) {
      const found = await findFile(candidate, name);
      if (found !== undefined) return found;
    }
  }
  throw new Error(`Bundled runtime ${name} was not found`);
}

async function directorySize(root) {
  let total = 0;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const candidate = path.join(root, entry.name);
    if (entry.isFile()) total += (await stat(candidate)).size;
    else if (entry.isDirectory()) total += await directorySize(candidate);
  }
  return total;
}

async function exists(candidate) {
  try {
    await readFile(candidate);
    return true;
  } catch {
    return false;
  }
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonicalDependencyLock(dependencies) {
  const packages = [...dependencies]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map(({ name, version, tarball, integrity, sha256 }) => ({
      name,
      version,
      tarball,
      integrity,
      sha256,
    }));
  return Buffer.from(
    `${JSON.stringify({ schemaVersion: 1, packages }, null, 2)}\n`,
    "utf8",
  );
}

function argumentValue(arguments_, name) {
  const index = arguments_.indexOf(name);
  return index >= 0 ? arguments_[index + 1] : undefined;
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function isDirectExecution() {
  return (
    process.argv[1] !== undefined &&
    path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  );
}
