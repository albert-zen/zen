// One-off review preparation. Never called by product builds or packaging.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  getBuildProperties,
  parseRuntimeResolution,
  readReviewedBuildInputs,
  verifyAndPatchSource,
} from "./build-zenx-winapp-downstream.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sdkVersion = "10.0.403";
const runtimeVersion = "10.0.14";
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function validateSecurityResolution(raw, lock) {
  const result = parseRuntimeResolution(raw, lock);
  const { Properties: properties, Items: items } = JSON.parse(raw);
  assert.equal(properties.NuGetAudit.toLowerCase(), "true");
  assert.equal(properties.NuGetAuditMode.toLowerCase(), "all");
  assert.equal(properties.TreatWarningsAsErrors.toLowerCase(), "true");
  assert.doesNotMatch(
    `${properties.NoWarn};${properties.WarningsNotAsErrors}`,
    /NU190[0-5]/iu,
  );
  assert.equal((items.NuGetAuditSuppress ?? []).length, 0);
  return result;
}

export function validatePreparedClosure(bytes) {
  assert.ok(bytes.length > 0 && bytes.length < 1024 * 1024);
  assert.ok(bytes.includes(Buffer.from("\r\n")), "Require Windows lock bytes");
  const closure = JSON.parse(bytes.toString("utf8"));
  assert.equal(closure.version, 2);
  const framework = "net10.0-windows10.0.19041";
  assert.deepEqual(Object.keys(closure.dependencies).sort(), [
    framework,
    `${framework}/win-x64`,
  ]);
  for (const group of Object.values(closure.dependencies)) {
    const compiler = group["Microsoft.DotNet.ILCompiler"];
    assert.equal(compiler.resolved, runtimeVersion);
    assert.equal(compiler.requested, `[${runtimeVersion}, )`);
  }
  const platform = closure.dependencies[`${framework}/win-x64`];
  assert.equal(
    platform["Microsoft.DotNet.ILCompiler"].dependencies[
      "runtime.win-x64.Microsoft.DotNet.ILCompiler"
    ],
    runtimeVersion,
  );
  assert.equal(
    platform["runtime.win-x64.Microsoft.DotNet.ILCompiler"].resolved,
    runtimeVersion,
  );
  assert.equal(
    closure.dependencies[framework]["Microsoft.NET.ILLink.Tasks"].resolved,
    runtimeVersion,
  );
  const packageCount = Object.values(closure.dependencies).reduce(
    (count, group) => count + Object.keys(group).length,
    0,
  );
  assert.ok(packageCount > 0 && packageCount <= 256);
  return { sizeBytes: bytes.length, sha256: sha256(bytes), packageCount };
}

export async function prepareSecurityClosure({
  sourceDirectory,
  workDirectory,
}) {
  assert.equal(process.platform, "win32", "Preparation requires Windows");
  sourceDirectory = await realpath(sourceDirectory);
  workDirectory = path.join(
    await realpath(path.dirname(path.resolve(workDirectory))),
    path.basename(workDirectory),
  );
  const relative = path.relative(sourceDirectory, workDirectory);
  assert.ok(
    path.isAbsolute(relative) || relative.startsWith(`..${path.sep}`),
    "Preparation must be outside upstream source",
  );
  const reviewed = await readReviewedBuildInputs(root);
  const lock = { ...reviewed.lock, dotnetSdk: sdkVersion, runtimeVersion };
  assert.equal(process.versions.node, lock.nodeVersion);
  await verifyAndPatchSource({ root, sourceDirectory, lock });
  // Exclusive creation: never reuse a preceding attempt's closure or caches.
  await mkdir(workDirectory);
  const configDirectory = path.join(workDirectory, "configuration");
  await mkdir(configDirectory);
  await writeFile(
    path.join(configDirectory, "global.json"),
    JSON.stringify({
      sdk: {
        version: sdkVersion,
        rollForward: "disable",
        allowPrerelease: false,
      },
    }),
  );
  const configFile = path.join(configDirectory, "NuGet.Config");
  await writeFile(
    configFile,
    '<?xml version="1.0" encoding="utf-8"?>\n<configuration><packageSources><clear/><add key="nuget.org" value="https://api.nuget.org/v3/index.json"/></packageSources><auditSources><clear/><add key="nuget.org" value="https://api.nuget.org/v3/index.json"/></auditSources></configuration>\n',
  );
  const packages = path.join(workDirectory, "packages");
  const environment = {
    ...process.env,
    DOTNET_CLI_HOME: path.join(workDirectory, "dotnet-home"),
    DOTNET_MULTILEVEL_LOOKUP: "0",
    DOTNET_CLI_TELEMETRY_OPTOUT: "1",
    DOTNET_NOLOGO: "1",
    NUGET_PACKAGES: packages,
    NUGET_HTTP_CACHE_PATH: path.join(workDirectory, "http-cache"),
    NUGET_PLUGINS_CACHE_PATH: path.join(workDirectory, "plugins-cache"),
    WINAPP_CLI_TELEMETRY_OPTOUT: "1",
    WINAPP_CLI_UPDATE_CHECK: "0",
  };
  const run = (args, capture = true) => {
    const result = spawnSync("dotnet", args, {
      cwd: configDirectory,
      env: environment,
      encoding: "utf8",
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
      timeout: 20 * 60 * 1000,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, `dotnet ${args[0]} failed`);
    return result.stdout ?? "";
  };
  assert.equal(run(["--version"]).trim(), sdkVersion);
  const project = path.join(sourceDirectory, lock.project);
  const properties = getBuildProperties(lock);
  const readResolution = () =>
    validateSecurityResolution(
      run([
        "msbuild",
        project,
        "-nologo",
        "-verbosity:quiet",
        "-target:ProcessFrameworkReferences",
        "-getProperty:TargetFramework,RuntimeIdentifier,SelfContained,PublishAot,NuGetAudit,NuGetAuditMode,TreatWarningsAsErrors,NoWarn,WarningsNotAsErrors",
        "-getItem:RuntimeFramework,RuntimePack,NuGetAuditSuppress",
        ...properties,
      ]),
      lock,
    );
  const before = readResolution();
  const dependencyLock = path.join(path.dirname(project), "packages.lock.json");
  await writeFile(dependencyLock, reviewed.dependencyLockBytes);
  const restore = [
    "restore",
    project,
    "--configfile",
    configFile,
    "--packages",
    packages,
    "--no-http-cache",
    ...properties,
  ];
  run([...restore, "--use-lock-file", "--force-evaluate"], false);
  assert.ok((await lstat(dependencyLock)).size < 1024 * 1024);
  const preparedBytes = await readFile(dependencyLock);
  const closure = validatePreparedClosure(preparedBytes);
  assert.deepEqual(readResolution(), before);
  run([...restore, "--locked-mode"], false);
  assert.ok(
    (await readFile(dependencyLock)).equals(preparedBytes),
    "Second locked restore changed the generated closure",
  );
  assert.deepEqual(readResolution(), before);
  const receipt = {
    schemaVersion: 1,
    purpose: "security-closure-review-only",
    sdkVersion,
    runtimeVersion,
    upstreamCommit: lock.upstream.commit,
    patchSha256: lock.patch.sha256,
    previousDependencyLockSha256: lock.dependencyLock.sha256,
    runtimeResolution: before,
    packageSource: "https://api.nuget.org/v3/index.json",
    auditEnabled: true,
    auditMode: "all",
    warningsAsErrors: true,
    secondLockedRestoreUnchanged: true,
    nativeBuildPerformed: false,
    closure,
  };
  const artifact = path.join(workDirectory, "artifact");
  await mkdir(artifact);
  await writeFile(path.join(artifact, "packages.lock.json"), preparedBytes);
  await writeFile(
    path.join(artifact, "security-closure-receipt.json"),
    `${JSON.stringify(receipt, null, 2)}\n`,
  );
  return receipt;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  assert.equal(process.argv.length, 6);
  assert.equal(process.argv[2], "--source");
  assert.equal(process.argv[4], "--work");
  console.log(
    JSON.stringify(
      await prepareSecurityClosure({
        sourceDirectory: process.argv[3],
        workDirectory: process.argv[5],
      }),
    ),
  );
}
