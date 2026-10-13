import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
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
  assert.ok(!value.includes("\\") && !value.split("/").includes(".."));
  return value;
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
  assert.equal(lock.dependencyLockMode, "capture-then-locked-restore");
  assert.ok(Object.keys(lock.sourceFiles).length > 0);
  for (const [name, digest] of Object.entries(lock.sourceFiles)) {
    relativeFile(name);
    assert.match(digest, /^[a-f0-9]{40}$/u);
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
    assert.equal(
      git(["rev-parse", `HEAD:${name}`]),
      digest,
      `Source preimage mismatch: ${name}`,
    );
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
    "providerBuild",
    "schemaVersion",
    "upstreamCommit",
  ]);
  assert.equal(contract.schemaVersion, 1);
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
  const lockBytes = await readFile(path.join(root, lockPath));
  const lock = validateBuildLock(JSON.parse(lockBytes.toString("utf8")));
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
  const properties = [
    `-p:RuntimeFrameworkVersion=${lock.runtimeVersion}`,
    `-p:Version=${lock.downstream.version}`,
  ];
  // First checkpoint discovers the resolved dependency closure, then requires a
  // locked restore before compiling. Its lock is an output for subsequent review;
  // it is NOT represented as a previously reviewed transitive dependency pin.
  run(
    "dotnet",
    [
      "restore",
      project,
      "--runtime",
      lock.targetRid,
      "--use-lock-file",
      ...properties,
    ],
    { cwd: sourceDirectory, capture: false },
  );
  const resolvedLock = await readFile(dependencyLock);
  await writeFile(
    path.join(outputDirectory, "packages.lock.json"),
    resolvedLock,
  );
  run(
    "dotnet",
    [
      "restore",
      project,
      "--runtime",
      lock.targetRid,
      "--locked-mode",
      ...properties,
    ],
    { cwd: sourceDirectory, capture: false },
  );
  assert.deepEqual(
    await readFile(dependencyLock),
    resolvedLock,
    "Locked restore changed dependencies",
  );
  const binaryDirectory = path.join(outputDirectory, "bin");
  run(
    "dotnet",
    [
      "publish",
      project,
      "--configuration",
      "Release",
      "--runtime",
      lock.targetRid,
      "--self-contained",
      "true",
      "--no-restore",
      "--output",
      binaryDirectory,
      ...properties,
      "-p:ContinuousIntegrationBuild=true",
      `-p:SourceRevisionId=${lock.upstream.commit}`,
    ],
    { cwd: sourceDirectory, capture: false },
  );
  assert.deepEqual(
    await readFile(dependencyLock),
    resolvedLock,
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
  const provenance = {
    schemaVersion: 1,
    purpose: "build-only-candidate-not-selected-by-ZenX",
    providerBuild: lock.downstream.providerBuild,
    upstream: lock.upstream,
    patchSha256: patched.patchSha256,
    sourceLockSha256: sha256(lockBytes),
    resolvedDependencyLockSha256: sha256(resolvedLock),
    dependencyLockMode: lock.dependencyLockMode,
    nodeVersion: lock.nodeVersion,
    dotnetSdk: lock.dotnetSdk,
    runtimeVersion: lock.runtimeVersion,
    targetRid: lock.targetRid,
    runnerImage: process.env.ImageOS ?? null,
    runnerImageVersion: process.env.ImageVersion ?? null,
    executable: { path: "bin/winapp.exe", sha256: await hashFile(executable) },
    featureContract: contract,
    bitReproducibilityVerified: false,
    productIntegrationVerified: false,
  };
  await writeFile(
    path.join(outputDirectory, "provenance.json"),
    `${JSON.stringify(provenance, null, 2)}\n`,
  );
  console.log(JSON.stringify(provenance));
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
