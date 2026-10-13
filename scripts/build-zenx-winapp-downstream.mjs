import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createReadStream } from "node:fs";
import {
  appendFile,
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const lockPath = "vendor/winapp-0.3.1/source.lock.json";
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function relativeFile(value) {
  assert.equal(typeof value, "string");
  assert.ok(value.length > 0 && !path.isAbsolute(value));
  assert.ok(
    !/[\\:\0]/u.test(value) &&
      !value.split("/").some((part) => ["", ".", ".."].includes(part)),
  );
  return value;
}

export async function readReviewedBuildInputs(root = repositoryRoot) {
  const lockBytes = await readFile(path.join(root, lockPath));
  const lock = validateBuildLock(JSON.parse(lockBytes.toString("utf8")));
  const patchBytes = await readFile(path.join(root, lock.patch.path));
  assert.equal(
    sha256(patchBytes),
    lock.patch.sha256,
    "Reviewed patch hash mismatch",
  );
  const dependencyLockBytes = await readFile(
    path.join(root, lock.dependencyLock.path),
  );
  assert.equal(
    dependencyLockBytes.length,
    lock.dependencyLock.sizeBytes,
    "Reviewed dependency lock size mismatch",
  );
  assert.equal(
    sha256(dependencyLockBytes),
    lock.dependencyLock.sha256,
    "Reviewed dependency lock hash mismatch",
  );
  return { lock, lockBytes, patchBytes, dependencyLockBytes };
}

// A bounded, link-free inventory is shared by the producer and assembly handoff.
// Provenance cannot hash itself; the trusted build passes its raw digest separately.
export async function inventoryDownstreamFiles(directory) {
  assert.ok(
    (await lstat(directory)).isDirectory(),
    "Downstream root must be a real directory",
  );
  const files = [];
  const directories = [];
  const names = new Set();
  let totalBytes = 0;
  const visit = async (relative) => {
    for (const name of (await readdir(path.join(directory, relative))).sort()) {
      const file = relativeFile(path.posix.join(relative, name));
      assert.ok(
        !names.has(file.toLowerCase()),
        `Case-colliding downstream path: ${file}`,
      );
      names.add(file.toLowerCase());
      assert.ok(names.size <= 4096, "Downstream payload exceeds entry bound");
      const metadata = await lstat(path.join(directory, file));
      if (metadata.isDirectory()) {
        directories.push(file);
        await visit(file);
      } else {
        assert.ok(
          metadata.isFile(),
          `Downstream payload must contain only regular files: ${file}`,
        );
        totalBytes += metadata.size;
        assert.ok(
          totalBytes <= 512 * 1024 * 1024,
          "Downstream payload exceeds size bound",
        );
        if (file !== "provenance.json") {
          files.push({
            path: file,
            sizeBytes: metadata.size,
            sha256: await hashFile(path.join(directory, file)),
          });
        }
      }
    }
  };
  await visit("");
  return { files, directories };
}

export async function verifyDownstreamCandidate({
  root = repositoryRoot,
  directory,
  provenanceSha256,
}) {
  assert.match(
    provenanceSha256 ?? "",
    /^[a-f0-9]{64}$/u,
    "Pass the same-run downstream provenance SHA-256",
  );
  assert.ok(
    (await lstat(directory)).isDirectory(),
    "Downstream root must be a real directory",
  );
  const provenancePath = path.join(directory, "provenance.json");
  const provenanceMetadata = await lstat(provenancePath);
  assert.ok(
    provenanceMetadata.isFile(),
    "Downstream provenance must be a regular file",
  );
  assert.ok(
    provenanceMetadata.size <= 4 * 1024 * 1024,
    "Downstream provenance exceeds size bound",
  );
  const provenanceBytes = await readFile(provenancePath);
  assert.equal(
    sha256(provenanceBytes),
    provenanceSha256,
    "Downstream provenance digest mismatch",
  );
  const { lock, lockBytes, patchBytes, dependencyLockBytes } =
    await readReviewedBuildInputs(root);
  const inventory = await inventoryDownstreamFiles(directory);
  const provenance = JSON.parse(provenanceBytes.toString("utf8"));
  assert.equal(provenance.schemaVersion, 1);
  assert.equal(provenance.purpose, "zenx-windows-uia-provider");
  assert.equal(provenance.providerBuild, lock.downstream.providerBuild);
  assert.equal(provenance.version, lock.downstream.version);
  assert.deepEqual(provenance.upstream, lock.upstream);
  assert.equal(provenance.patchSha256, lock.patch.sha256);
  assert.equal(provenance.sourceLockSha256, sha256(lockBytes));
  assert.equal(provenance.dependencyLockSha256, lock.dependencyLock.sha256);
  assert.equal(provenance.dependencyLockMode, lock.dependencyLockMode);
  assert.equal(provenance.dotnetSdk, lock.dotnetSdk);
  assert.equal(provenance.nodeVersion, lock.nodeVersion);
  assert.equal(provenance.runtimeVersion, lock.runtimeVersion);
  assert.equal(provenance.targetRid, lock.targetRid);
  assert.equal(provenance.bitReproducibilityVerified, false);
  parseFeatureContract(JSON.stringify(provenance.featureContract), lock);
  assert.deepEqual(
    provenance.files,
    inventory.files,
    "Downstream shipped file inventory mismatch",
  );
  assert.deepEqual(
    provenance.directories,
    inventory.directories,
    "Downstream directory inventory mismatch",
  );
  for (const [file, expected] of [
    ["source.lock.json", lockBytes],
    ["downstream.patch", patchBytes],
    ["packages.lock.json", dependencyLockBytes],
  ]) {
    assert.ok(
      (await readFile(path.join(directory, file))).equals(expected),
      `Downstream reviewed input mismatch: ${file}`,
    );
  }
  for (const file of [
    "bin/winapp.exe",
    "bin/libSkiaSharp.dll",
    "UPSTREAM-LICENSE.txt",
    "dotnet-info.txt",
  ]) {
    assert.ok(
      inventory.files.some(
        (entry) => entry.path === file && entry.sizeBytes > 0,
      ),
      `Downstream required file missing: ${file}`,
    );
  }
  assert.deepEqual(provenance.executable, {
    path: "bin/winapp.exe",
    sha256: inventory.files.find((file) => file.path === "bin/winapp.exe")
      .sha256,
  });
  for (const phase of ["before", "after"]) {
    const output = await readFile(
      path.join(directory, `runtime-resolution-${phase}-restore.json`),
      "utf8",
    );
    assert.deepEqual(
      parseRuntimeResolution(output, lock),
      provenance.runtimeResolution,
      "Downstream runtime evidence mismatch",
    );
  }
  return {
    lock,
    provenance,
    provenanceSha256,
    inventory,
    downstream: {
      schemaVersion: 1,
      providerBuild: lock.downstream.providerBuild,
      upstreamCommit: lock.upstream.commit,
      patchSha256: lock.patch.sha256,
      sourceLockSha256: sha256(lockBytes),
      dependencyLockSha256: lock.dependencyLock.sha256,
      contractVersion: 1,
    },
  };
}

export function validateBuildLock(lock) {
  assert.equal(lock.schemaVersion, 1);
  assert.equal(lock.upstream.repository, "microsoft/winappCli");
  assert.match(lock.upstream.commit, /^[a-f0-9]{40}$/u);
  assert.match(lock.downstream.providerBuild, /^zenx-winapp-[0-9A-Za-z.-]+$/u);
  assert.match(lock.downstream.version, /^0\.3\.1-zenx\.[0-9A-Za-z.]+$/u);
  assert.equal(lock.targetRid, "win-x64");
  assert.match(lock.nodeVersion, /^22\.\d+\.\d+$/u);
  assert.match(lock.dotnetSdk, /^10\.0\.\d+$/u);
  assert.match(lock.runtimeVersion, /^10\.0\.\d+$/u);
  relativeFile(lock.project);
  relativeFile(lock.patch.path);
  assert.match(lock.patch.sha256, /^[a-f0-9]{64}$/u);
  assert.equal(lock.dependencyLockMode, "frozen-locked-restore");
  relativeFile(lock.dependencyLock.path);
  assert.match(lock.dependencyLock.sha256, /^[a-f0-9]{64}$/u);
  assert.equal(lock.dependencyLock.sizeBytes, 13704);
  assert.ok(Object.keys(lock.sourceFiles).length > 0);
  for (const [name, digest] of Object.entries(lock.sourceFiles)) {
    relativeFile(name);
    if (digest !== null) assert.match(digest, /^[a-f0-9]{40}$/u);
  }
  return lock;
}

function run(command, args, { cwd, capture = true } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    maxBuffer: 16 * 1024 * 1024,
    timeout: 20 * 60 * 1000,
    windowsHide: true,
    env: {
      ...process.env,
      DOTNET_CLI_TELEMETRY_OPTOUT: "1",
      DOTNET_NOLOGO: "1",
      WINAPP_CLI_TELEMETRY_OPTOUT: "1",
      WINAPP_CLI_UPDATE_CHECK: "0",
    },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} failed (${result.status}): ${(result.stderr ?? "").slice(-8192)}`,
    );
  }
  return result.stdout ?? "";
}

export async function verifyAndPatchSource({
  root,
  sourceDirectory,
  lock,
  execute = run,
}) {
  validateBuildLock(lock);
  const patchFile = path.join(root, lock.patch.path);
  const patch = await readFile(patchFile);
  assert.equal(
    sha256(patch),
    lock.patch.sha256,
    "Downstream patch hash mismatch",
  );
  const git = (args) => execute("git", args, { cwd: sourceDirectory }).trim();
  assert.equal(
    git(["rev-parse", "HEAD"]),
    lock.upstream.commit,
    "Unexpected upstream source commit",
  );
  assert.equal(
    git(["status", "--porcelain", "--untracked-files=all"]),
    "",
    "Upstream build checkout must be clean",
  );
  for (const [name, digest] of Object.entries(lock.sourceFiles)) {
    if (digest === null) {
      assert.equal(
        git(["ls-tree", "HEAD", "--", name]),
        "",
        `New source path already exists: ${name}`,
      );
    } else {
      assert.equal(
        git(["rev-parse", `HEAD:${name}`]),
        digest,
        `Source preimage mismatch: ${name}`,
      );
    }
  }
  // Patch the Git index, then materialize only the reviewed paths. This handles
  // Windows checkout line endings without normalizing or resetting other files.
  git(["apply", "--cached", "--check", patchFile]);
  git(["apply", "--cached", patchFile]);
  const changed = git(["diff", "--cached", "--name-only"])
    .split("\n")
    .filter(Boolean)
    .sort();
  assert.deepEqual(
    changed,
    Object.keys(lock.sourceFiles).sort(),
    "Patch changed an unreviewed path",
  );
  git(["checkout-index", "--force", "--", ...changed]);
  assert.equal(
    git(["diff", "--name-only"]),
    "",
    "Patched checkout differs from its index",
  );
  return { patchSha256: lock.patch.sha256, patchedPaths: changed };
}

export function parseFeatureContract(raw, lock) {
  const contract = JSON.parse(raw.trim());
  assert.deepEqual(Object.keys(contract).sort(), [
    "autoSetFocus",
    "contractVersion",
    "providerBuild",
    "schemaVersion",
    "upstreamCommit",
  ]);
  assert.equal(contract.schemaVersion, 1);
  assert.equal(contract.contractVersion, 1);
  assert.equal(contract.providerBuild, lock.downstream.providerBuild);
  assert.equal(contract.upstreamCommit, lock.upstream.commit);
  assert.equal(
    contract.autoSetFocus,
    false,
    "Actual downstream UIA client must report AutoSetFocus=false",
  );
  return contract;
}

async function hashFile(filename) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest("hex");
}

export function getBuildProperties(lock) {
  return [
    "-p:Configuration=Release",
    `-p:RuntimeIdentifier=${lock.targetRid}`,
    "-p:SelfContained=true",
    "-p:TargetLatestRuntimePatch=true",
    `-p:Version=${lock.downstream.version}`,
    "-p:ContinuousIntegrationBuild=true",
    `-p:SourceRevisionId=${lock.upstream.commit}`,
  ];
}

export function parseRuntimeResolution(output, lock) {
  const { Properties: properties, Items: items } = JSON.parse(output);
  assert.equal(properties.TargetFramework, "net10.0-windows10.0.19041.0");
  assert.equal(properties.RuntimeIdentifier, lock.targetRid);
  assert.equal(properties.SelfContained.toLowerCase(), "true");
  assert.equal(properties.PublishAot.toLowerCase(), "true");
  const frameworks = items.RuntimeFramework.filter(
    (item) => item.Identity === "Microsoft.NETCore.App",
  );
  const packs = items.RuntimePack.filter(
    (item) => item.FrameworkName === "Microsoft.NETCore.App",
  );
  assert.equal(
    frameworks.length,
    1,
    "Expected one resolved .NET runtime framework",
  );
  assert.equal(
    packs.length,
    1,
    "Expected one resolved target .NET runtime pack",
  );
  assert.equal(frameworks[0].Version, lock.runtimeVersion);
  assert.equal(packs[0].NuGetPackageVersion, lock.runtimeVersion);
  assert.equal(packs[0].RuntimeIdentifier, lock.targetRid);
  return {
    targetFramework: properties.TargetFramework,
    targetRid: properties.RuntimeIdentifier,
    runtimeVersion: frameworks[0].Version,
    runtimePack: packs[0].Identity,
  };
}

export async function buildDownstream({
  root = repositoryRoot,
  sourceDirectory,
  outputDirectory,
}) {
  assert.equal(
    process.platform,
    "win32",
    "Native downstream builds require Windows; no runtime compilation fallback",
  );
  assert.ok(sourceDirectory && outputDirectory, "Pass --source and --output");
  sourceDirectory = path.resolve(sourceDirectory);
  outputDirectory = path.resolve(outputDirectory);
  assert.ok(
    !outputDirectory.startsWith(`${sourceDirectory}${path.sep}`) &&
      outputDirectory !== sourceDirectory,
    "Output must be separate from the source checkout",
  );
  const {
    lock,
    lockBytes,
    dependencyLockBytes: resolvedLock,
  } = await readReviewedBuildInputs(root);
  assert.equal(
    process.versions.node,
    lock.nodeVersion,
    "Unexpected build Node.js version",
  );
  const patched = await verifyAndPatchSource({ root, sourceDirectory, lock });
  assert.equal(
    run("dotnet", ["--version"], { cwd: sourceDirectory }).trim(),
    lock.dotnetSdk,
    "Unexpected .NET SDK",
  );
  // Never clear or reuse an arbitrary output directory. A retry needs a fresh one.
  await mkdir(outputDirectory);
  await writeFile(path.join(outputDirectory, "source.lock.json"), lockBytes);
  await copyFile(
    path.join(root, lock.patch.path),
    path.join(outputDirectory, "downstream.patch"),
  );
  await writeFile(
    path.join(outputDirectory, "dotnet-info.txt"),
    run("dotnet", ["--info"], { cwd: sourceDirectory }),
  );
  const project = path.join(sourceDirectory, lock.project);
  const dependencyLock = path.join(path.dirname(project), "packages.lock.json");
  // A global RuntimeFrameworkVersion also overrides the unrelated Windows SDK
  // framework. Resolve each framework with this pinned SDK, then verify the .NET
  // framework AND RID-specific pack before restore and again after locked restore.
  const properties = getBuildProperties(lock);
  const readRuntimeResolution = () =>
    run(
      "dotnet",
      [
        "msbuild",
        project,
        "-nologo",
        "-verbosity:quiet",
        "-target:ProcessFrameworkReferences",
        "-getProperty:TargetFramework,RuntimeIdentifier,SelfContained,PublishAot",
        "-getItem:RuntimeFramework,RuntimePack",
        ...properties,
      ],
      { cwd: sourceDirectory },
    );
  const initialRuntimeOutput = readRuntimeResolution();
  await writeFile(
    path.join(outputDirectory, "runtime-resolution-before-restore.json"),
    initialRuntimeOutput,
  );
  const runtimeResolution = parseRuntimeResolution(initialRuntimeOutput, lock);
  // Install the already-reviewed raw closure before the first restore. No
  // unconstrained dependency discovery is permitted in product builds.
  await writeFile(dependencyLock, resolvedLock);
  await writeFile(
    path.join(outputDirectory, "packages.lock.json"),
    resolvedLock,
  );
  run("dotnet", ["restore", project, "--locked-mode", ...properties], {
    cwd: sourceDirectory,
    capture: false,
  });
  assert.ok(
    (await readFile(dependencyLock)).equals(resolvedLock),
    "Locked restore changed dependencies",
  );
  const lockedRuntimeOutput = readRuntimeResolution();
  await writeFile(
    path.join(outputDirectory, "runtime-resolution-after-restore.json"),
    lockedRuntimeOutput,
  );
  assert.deepEqual(
    parseRuntimeResolution(lockedRuntimeOutput, lock),
    runtimeResolution,
    "Locked restore changed the resolved runtime",
  );
  const binaryDirectory = path.join(outputDirectory, "bin");
  run(
    "dotnet",
    [
      "publish",
      project,
      "--no-restore",
      "--output",
      binaryDirectory,
      ...properties,
    ],
    { cwd: sourceDirectory, capture: false },
  );
  assert.ok(
    (await readFile(dependencyLock)).equals(resolvedLock),
    "Publish changed dependencies",
  );
  const executable = path.join(binaryDirectory, "winapp.exe");
  const contract = parseFeatureContract(
    run(executable, ["--zenx-uia-contract"], { cwd: sourceDirectory }),
    lock,
  );
  await copyFile(
    path.join(sourceDirectory, "LICENSE"),
    path.join(outputDirectory, "UPSTREAM-LICENSE.txt"),
  );
  const inventory = await inventoryDownstreamFiles(outputDirectory);
  assert.ok(
    inventory.files.some((file) => file.path === "bin/libSkiaSharp.dll"),
    "Native SkiaSharp runtime is missing",
  );
  const provenance = {
    schemaVersion: 1,
    purpose: "zenx-windows-uia-provider",
    version: lock.downstream.version,
    providerBuild: lock.downstream.providerBuild,
    upstream: lock.upstream,
    patchSha256: patched.patchSha256,
    sourceLockSha256: sha256(lockBytes),
    dependencyLockSha256: sha256(resolvedLock),
    dependencyLockMode: lock.dependencyLockMode,
    nodeVersion: lock.nodeVersion,
    dotnetSdk: lock.dotnetSdk,
    runtimeVersion: lock.runtimeVersion,
    runtimeResolution,
    targetRid: lock.targetRid,
    runnerImage: process.env.ImageOS ?? null,
    runnerImageVersion: process.env.ImageVersion ?? null,
    executable: { path: "bin/winapp.exe", sha256: await hashFile(executable) },
    ...inventory,
    featureContract: contract,
    bitReproducibilityVerified: false,
    productIntegrationVerified: false,
  };
  const provenanceBytes = Buffer.from(
    `${JSON.stringify(provenance, null, 2)}\n`,
  );
  await writeFile(
    path.join(outputDirectory, "provenance.json"),
    provenanceBytes,
  );
  const provenanceSha256 = sha256(provenanceBytes);
  await verifyDownstreamCandidate({
    root,
    directory: outputDirectory,
    provenanceSha256,
  });
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(
      process.env.GITHUB_OUTPUT,
      `provenance-sha256=${provenanceSha256}\n`,
    );
  }
  console.log(JSON.stringify({ ...provenance, provenanceSha256 }));
  return provenance;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const args = process.argv.slice(2);
  assert.equal(
    args.length,
    4,
    "Usage: node build-zenx-winapp-downstream.mjs --source DIR --output DIR",
  );
  assert.equal(args[0], "--source");
  assert.equal(args[2], "--output");
  await buildDownstream({ sourceDirectory: args[1], outputDirectory: args[3] });
}
