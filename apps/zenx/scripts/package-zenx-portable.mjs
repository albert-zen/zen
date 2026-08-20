import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  cp,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const zenx = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const root = path.resolve(zenx, "..", "..");
const packagedRoot = path.join(zenx, ".packaged");
const runsRoot = path.join(packagedRoot, "runs");
const artifactRoot = path.join(packagedRoot, "artifact");
const artifactCache = path.join(packagedRoot, "cache", "artifacts");

if (isDirectExecution()) await packageZenX(process.argv.slice(2));

async function packageZenX(arguments_) {
  const target = arguments_.includes("--app") ? "app" : "smoke";
  const productName = target === "app" ? "ZenX" : "ZenXProviderSmoke";
  const targetDirectory = `${productName}-${process.platform}-${process.arch}`;
  await withPackagingTargetLock(packagedRoot, targetDirectory, async () => {
    await mkdir(runsRoot, { recursive: true, mode: 0o700 });
    const staging = await mkdtemp(path.join(runsRoot, "package-"));
    try {
      const buildSnapshot = await createBuildSnapshot(staging);
      const resources = path.join(staging, "resources");
      const appDir = path.join(staging, "app");
      const stagedArtifacts = path.join(staging, "artifact");
      const assembly = JSON.parse(
        (
          await run(process.execPath, [
            path.join(root, "scripts", "assemble-zenx-providers.mjs"),
            "--output",
            resources,
            "--cache",
            artifactCache,
          ])
        ).stdout,
      );
      const zenxPackage = JSON.parse(
        await readFile(path.join(zenx, "package.json"), "utf8"),
      );
      await stagePackage({
        target,
        outDirectory: buildSnapshot,
        rootDirectory: root,
        appDirectory: appDir,
        manifestSha256: assembly.manifestSha256,
      });
      await writeFile(
        path.join(appDir, "package.json"),
        `${JSON.stringify(packageManifest(target, zenxPackage), null, 2)}\n`,
      );
      const { packager } = await import("@electron/packager");
      const packaged = await packager({
        dir: appDir,
        out: stagedArtifacts,
        overwrite: false,
        platform: process.platform,
        arch: process.arch,
        name: productName,
        electronVersion: "43.2.0",
        afterCopy: [
          async ({ buildPath }) => {
            await copyPackagedProviderResources({
              buildPath,
              sourceDirectory: path.join(resources, "providers"),
            });
          },
        ],
        asar: false,
      });
      if (path.basename(packaged[0]) !== targetDirectory) {
        throw new Error(
          `Electron packager returned unexpected target ${path.basename(packaged[0])}`,
        );
      }
      if (target === "smoke") {
        await runExecutable(executablePath(packaged[0], target));
      }
      const publishedArtifact = await publishPackagedArtifact(
        packaged[0],
        path.join(artifactRoot, targetDirectory),
      );
      const executable = executablePath(publishedArtifact, target);
      console.log(
        JSON.stringify(
          {
            packagedArtifact: publishedArtifact,
            executable,
            target,
            version: zenxPackage.version,
            manifestDigest: assembly.manifestSha256,
            releaseSizeBytes: assembly.releaseSizeBytes,
          },
          null,
          2,
        ),
      );
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  });
}

/** Build only into the current packaging run before anything snapshots it. */
export async function createBuildSnapshot(
  stagingDirectory,
  build = runZenXBuild,
) {
  const buildDirectory = path.join(stagingDirectory, "build");
  await build(buildDirectory);
  return buildDirectory;
}

async function runZenXBuild(buildDirectory) {
  await run(
    process.execPath,
    [
      path.join(
        root,
        "node_modules",
        "electron-vite",
        "bin",
        "electron-vite.js",
      ),
      "build",
      "--outDir",
      buildDirectory,
    ],
    { cwd: zenx },
  );
}

export async function withPackagingTargetLock(
  packageRoot,
  targetDirectory,
  action,
) {
  const locks = path.join(packageRoot, "locks");
  await mkdir(locks, { recursive: true, mode: 0o700 });
  const lockPath = path.join(locks, `${targetDirectory}.lock`);
  let lock;
  try {
    lock = await open(lockPath, "wx", 0o600);
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw new Error(
        `Packaging target ${targetDirectory} is already in progress; if no packaging process is active, remove the stale lock explicitly`,
      );
    }
    throw error;
  }
  try {
    await lock.writeFile(`${String(process.pid)} ${randomUUID()}\n`);
    await lock.sync();
    return await action();
  } finally {
    await lock.close();
    await rm(lockPath, { force: true });
  }
}

export async function publishPackagedArtifact(stagedArtifact, finalArtifact) {
  await mkdir(path.dirname(finalArtifact), { recursive: true, mode: 0o700 });
  const retiredArtifact = path.join(
    path.dirname(finalArtifact),
    `.${path.basename(finalArtifact)}.${randomUUID()}.retired`,
  );
  let retired = false;
  try {
    await rename(finalArtifact, retiredArtifact);
    retired = true;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  try {
    await rename(stagedArtifact, finalArtifact);
  } catch (error) {
    if (retired) await rename(retiredArtifact, finalArtifact);
    throw error;
  }
  if (retired) {
    await rm(retiredArtifact, { recursive: true, force: true });
  }
  return finalArtifact;
}

export async function stagePackage(options) {
  const stagedMain =
    options.target === "app"
      ? path.join(options.appDirectory, "out", "main")
      : path.join(options.appDirectory, "main");
  if (options.target === "app") {
    await cp(options.outDirectory, path.join(options.appDirectory, "out"), {
      recursive: true,
    });
    await cp(
      path.join(options.rootDirectory, "node_modules", "ws"),
      path.join(options.appDirectory, "node_modules", "ws"),
      { recursive: true },
    );
  } else {
    await cp(path.join(options.outDirectory, "main"), stagedMain, {
      recursive: true,
    });
  }
  await injectProviderManifestDigest(stagedMain, options.manifestSha256);
}

export async function copyPackagedProviderResources(options) {
  const resourcesDirectory = path.dirname(options.buildPath);
  const destination = path.join(
    resourcesDirectory,
    path.basename(options.sourceDirectory),
  );
  await mkdir(resourcesDirectory, { recursive: true, mode: 0o700 });
  await cp(options.sourceDirectory, destination, {
    recursive: true,
    verbatimSymlinks: true,
  });
  return destination;
}

export function packageManifest(target, zenxPackage) {
  return target === "app"
    ? {
        name: "zenx",
        version: zenxPackage.version,
        private: true,
        type: "module",
        main: "out/main/index.js",
        dependencies: { ws: zenxPackage.dependencies.ws },
      }
    : {
        name: "zenx-packaged-provider-smoke",
        version: zenxPackage.version,
        private: true,
        type: "module",
        main: "main/packaged-provider-smoke.js",
      };
}

function isDirectExecution() {
  return (
    process.argv[1] !== undefined &&
    path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  );
}

async function injectProviderManifestDigest(mainDirectory, manifestSha256) {
  let replacements = 0;
  for (const file of await walk(mainDirectory)) {
    if (!file.endsWith(".js")) continue;
    const source = await readFile(file, "utf8");
    if (!source.includes("__ZENX_PACKAGED_PROVIDER_MANIFEST_SHA256__")) {
      continue;
    }
    await writeFile(
      file,
      source.replaceAll(
        "__ZENX_PACKAGED_PROVIDER_MANIFEST_SHA256__",
        manifestSha256,
      ),
    );
    replacements += 1;
  }
  if (replacements === 0) {
    throw new Error(
      "built ZenX main output has no provider manifest placeholder",
    );
  }
}

async function walk(rootDir) {
  const result = [];
  const { readdir } = await import("node:fs/promises");
  for (const entry of await readdir(rootDir, { withFileTypes: true })) {
    const candidate = path.join(rootDir, entry.name);
    if (entry.isDirectory()) result.push(...(await walk(candidate)));
    else result.push(candidate);
  }
  return result;
}

function executablePath(appPath, packageTarget) {
  const executableName = packageTarget === "app" ? "ZenX" : "ZenXProviderSmoke";
  if (process.platform === "win32")
    return path.join(appPath, `${executableName}.exe`);
  if (process.platform === "darwin") {
    return path.join(
      appPath,
      `${executableName}.app`,
      "Contents",
      "MacOS",
      executableName,
    );
  }
  return path.join(appPath, executableName);
}

async function runExecutable(executable) {
  await new Promise((resolve, reject) => {
    const child = spawn(executable, [], {
      stdio: "inherit",
      windowsHide: true,
      env: { ...process.env, ZENX_PACKAGED_SMOKE: "1" },
    });
    child.once("error", reject);
    child.once("exit", (code, signal) =>
      code === 0
        ? resolve()
        : reject(
            new Error(
              `packaged provider smoke exited ${String(code)} ${signal ?? ""}`,
            ),
          ),
    );
  });
}
