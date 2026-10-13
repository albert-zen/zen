import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  inventoryDownstreamFiles,
  parseRuntimeResolution,
  readReviewedBuildInputs,
  verifyDownstreamCandidate,
} from "../../../scripts/build-zenx-winapp-downstream.mjs";
import {
  assembleDownstreamProvider,
  downstreamAssemblyArguments,
  hashBrowserPayloadDirectory,
} from "../../../scripts/assemble-zenx-providers.mjs";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function fixture(t) {
  const temporary = await mkdtemp(
    path.join(os.tmpdir(), "zenx-downstream-assembly-"),
  );
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const directory = path.join(temporary, "candidate");
  await mkdir(path.join(directory, "bin"), { recursive: true });
  const { lock, lockBytes, patchBytes, dependencyLockBytes } =
    await readReviewedBuildInputs(root);
  const runtime = {
    Properties: {
      TargetFramework: "net10.0-windows10.0.19041.0",
      RuntimeIdentifier: "win-x64",
      SelfContained: "true",
      PublishAot: "true",
    },
    Items: {
      RuntimeFramework: [
        { Identity: "Microsoft.NETCore.App", Version: lock.runtimeVersion },
      ],
      RuntimePack: [
        {
          Identity: "Microsoft.NETCore.App.Runtime.win-x64",
          FrameworkName: "Microsoft.NETCore.App",
          RuntimeIdentifier: "win-x64",
          NuGetPackageVersion: lock.runtimeVersion,
        },
      ],
    },
  };
  for (const [file, bytes] of Object.entries({
    "bin/winapp.exe": "native executable fixture",
    "bin/libSkiaSharp.dll": "native DLL fixture",
    "bin/winapp.pdb": "debug symbols fixture",
    "source.lock.json": lockBytes,
    "packages.lock.json": dependencyLockBytes,
    "downstream.patch": patchBytes,
    "UPSTREAM-LICENSE.txt": "MIT fixture",
    "dotnet-info.txt": `SDK ${lock.dotnetSdk}`,
    "runtime-resolution-before-restore.json": JSON.stringify(runtime),
    "runtime-resolution-after-restore.json": JSON.stringify(runtime),
  }))
    await writeFile(path.join(directory, file), bytes);
  const inventory = await inventoryDownstreamFiles(directory);
  const provenance = {
    schemaVersion: 1,
    purpose: "zenx-windows-uia-provider",
    version: lock.downstream.version,
    providerBuild: lock.downstream.providerBuild,
    upstream: lock.upstream,
    patchSha256: lock.patch.sha256,
    sourceLockSha256: digest(lockBytes),
    dependencyLockSha256: lock.dependencyLock.sha256,
    dependencyLockMode: lock.dependencyLockMode,
    nodeVersion: lock.nodeVersion,
    dotnetSdk: lock.dotnetSdk,
    runtimeVersion: lock.runtimeVersion,
    targetRid: lock.targetRid,
    runtimeResolution: parseRuntimeResolution(JSON.stringify(runtime), lock),
    executable: {
      path: "bin/winapp.exe",
      sha256: inventory.files.find((file) => file.path === "bin/winapp.exe")
        .sha256,
    },
    ...inventory,
    featureContract: {
      schemaVersion: 1,
      contractVersion: 1,
      providerBuild: lock.downstream.providerBuild,
      upstreamCommit: lock.upstream.commit,
      autoSetFocus: false,
    },
    bitReproducibilityVerified: false,
    productIntegrationVerified: false,
  };
  const seal = async () => {
    const bytes = Buffer.from(`${JSON.stringify(provenance, null, 2)}\n`);
    await writeFile(path.join(directory, "provenance.json"), bytes);
    return digest(bytes);
  };
  return {
    temporary,
    directory,
    provenance,
    seal,
    provenanceSha256: await seal(),
  };
}

test("Windows packaging requires an explicit same-run digest and leaves macOS/Linux unchanged", () => {
  assert.throws(
    () => downstreamAssemblyArguments([], "win32"),
    /requires --downstream/u,
  );
  assert.throws(() =>
    downstreamAssemblyArguments(["--downstream", "candidate"], "win32"),
  );
  assert.throws(() =>
    downstreamAssemblyArguments(
      ["--downstream", "candidate", "--downstream-sha256", "bad"],
      "win32",
    ),
  );
  assert.throws(
    () =>
      downstreamAssemblyArguments(
        ["--downstream", "a", "--downstream", "b"],
        "win32",
      ),
    /Duplicate/u,
  );
  assert.throws(
    () => downstreamAssemblyArguments(["--downstream", "--app"], "win32"),
    /Missing/u,
  );
  for (const platform of ["darwin", "linux"]) {
    assert.deepEqual(downstreamAssemblyArguments(["--app"], platform), []);
    assert.throws(
      () =>
        downstreamAssemblyArguments(["--downstream", "candidate"], platform),
      /Windows-only/u,
    );
  }
  assert.deepEqual(
    downstreamAssemblyArguments(
      ["--downstream", "candidate", "--downstream-sha256", "a".repeat(64)],
      "win32",
    ),
    [
      "--downstream",
      path.resolve("candidate"),
      "--downstream-sha256",
      "a".repeat(64),
    ],
  );
});

test("assembly seals direct native executable, every shipped file, and the whole bin tree", async (t) => {
  const f = await fixture(t);
  const providersDirectory = path.join(f.temporary, "providers");
  const entry = await assembleDownstreamProvider({ ...f, providersDirectory });
  assert.equal(entry.executable, "zenx-winapp-uia/bin/winapp.exe");
  assert.equal(entry.version, "0.3.1-zenx.af0.2");
  assert.deepEqual(entry.platforms, ["win32"]);
  assert.equal(entry.runtime, undefined);
  assert.deepEqual(
    Object.keys(entry.downstream).sort(),
    [
      "schemaVersion",
      "providerBuild",
      "upstreamCommit",
      "patchSha256",
      "sourceLockSha256",
      "dependencyLockSha256",
      "contractVersion",
    ].sort(),
  );
  assert.equal(entry.assets.length, f.provenance.files.length + 2);
  const tree = entry.assets.find((asset) => asset.kind === "directory");
  assert.equal(tree.path, "zenx-winapp-uia/bin");
  assert.equal(tree.ignoredPaths, undefined);
  assert.equal(
    tree.sha256,
    await hashBrowserPayloadDirectory(
      path.join(providersDirectory, "zenx-winapp-uia/bin"),
    ),
  );
  for (const file of f.provenance.files) {
    assert.ok(
      entry.assets.some(
        (asset) =>
          asset.path === `zenx-winapp-uia/${file.path}` &&
          asset.sha256 === file.sha256,
      ),
    );
  }
  assert.ok(
    entry.assets.some(
      (asset) =>
        asset.path === "zenx-winapp-uia/provenance.json" &&
        asset.sha256 === f.provenanceSha256,
    ),
  );
  // The producer's staging input is not changed by assembly.
  await verifyDownstreamCandidate(f);
});

test("untrusted or mutated staging inputs cannot enter the provider manifest", async (t) => {
  for (const mutate of [
    async (f) => {
      f.provenanceSha256 = "0".repeat(64);
    },
    async (f) =>
      writeFile(path.join(f.directory, "bin/winapp.exe"), "tampered"),
    async (f) =>
      writeFile(path.join(f.directory, "bin/libSkiaSharp.dll"), "tampered"),
    async (f) =>
      writeFile(path.join(f.directory, "bin/unreviewed.dll"), "injected"),
    async (f) => mkdir(path.join(f.directory, "bin/unreviewed")),
    async (f) => rm(path.join(f.directory, "UPSTREAM-LICENSE.txt")),
    async (f) => {
      f.provenance.providerBuild = "zenx-winapp-0.3.1-af0.1";
      f.provenanceSha256 = await f.seal();
    },
    async (f) => {
      f.provenance.featureContract.contractVersion = 2;
      f.provenanceSha256 = await f.seal();
    },
    async (f) => {
      f.provenance.featureContract.autoSetFocus = true;
      f.provenanceSha256 = await f.seal();
    },
    async (f) => {
      f.provenance.dependencyLockSha256 = "0".repeat(64);
      f.provenanceSha256 = await f.seal();
    },
    async (f) => {
      f.provenance.bitReproducibilityVerified = true;
      f.provenanceSha256 = await f.seal();
    },
    async (f) => {
      await writeFile(path.join(f.directory, "packages.lock.json"), "{}");
      Object.assign(f.provenance, await inventoryDownstreamFiles(f.directory));
      f.provenanceSha256 = await f.seal();
    },
  ]) {
    const f = await fixture(t);
    await mutate(f);
    await assert.rejects(
      assembleDownstreamProvider({
        ...f,
        providersDirectory: path.join(f.temporary, "providers"),
      }),
    );
  }
});

test(
  "symlink injection is rejected before copying a native payload",
  { skip: process.platform === "win32" },
  async (t) => {
    const f = await fixture(t);
    await symlink(
      path.join(f.directory, "bin/winapp.exe"),
      path.join(f.directory, "bin/linked.exe"),
    );
    await assert.rejects(verifyDownstreamCandidate(f), /regular files/u);
  },
);

test("the official WinApp npm archive pin is unchanged by downstream integration", async () => {
  const lock = JSON.parse(
    await readFile(
      path.join(root, "apps/zenx/resources/providers/provider-lock.json"),
      "utf8",
    ),
  );
  assert.equal(lock.providers["microsoft-winapp-cli"].version, "0.3.1");
  assert.equal(
    lock.providers["microsoft-winapp-cli"].sha256,
    "3c2f3a8488b9a49b7bed60f5e6c7e74713c895d9c36c605a5524999d67435196",
  );
  assert.equal(
    lock.providers["microsoft-winapp-cli"].tarball,
    "https://registry.npmjs.org/@microsoft/winappcli/-/winappcli-0.3.1.tgz",
  );
  const assembly = await readFile(
    path.join(root, "scripts/assemble-zenx-providers.mjs"),
    "utf8",
  );
  assert.match(
    assembly,
    /const winapp = await assembleNpmProvider\(\s*"microsoft-winapp-cli"/u,
  );
});
