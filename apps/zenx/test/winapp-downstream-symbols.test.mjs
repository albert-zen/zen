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
import test from "node:test";
import * as downstream from "../../../scripts/build-zenx-winapp-downstream.mjs";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function publishFixture(t) {
  const temporary = await mkdtemp(
    path.join(os.tmpdir(), "zenx-detached-symbols-"),
  );
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const outputDirectory = path.join(temporary, "product");
  const symbolsDirectory = path.join(temporary, "symbols");
  await mkdir(path.join(outputDirectory, "bin/nested"), { recursive: true });
  const contents = {
    "bin/winapp.exe": "native executable fixture",
    "bin/libSkiaSharp.dll": "native DLL fixture",
    "bin/winapp.pdb": "known native debug symbols fixture",
    "bin/unknown.dll": "unknown runtime dependency",
    "bin/other.pdb": "unknown asset with a symbol-like extension",
    "bin/nested/winapp.pdb": "unknown nested asset with the same basename",
    "bin/provenance.json": "unknown runtime asset with a metadata-like name",
  };
  for (const [name, bytes] of Object.entries(contents))
    await writeFile(path.join(outputDirectory, name), bytes);
  return { temporary, outputDirectory, symbolsDirectory, contents };
}

test("detaches only the exact known top-level PDB and proves the complete publish partition", async (t) => {
  const f = await publishFixture(t);
  assert.equal(typeof downstream.detachDownstreamDebugSymbols, "function");
  const result = await downstream.detachDownstreamDebugSymbols(f);
  assert.deepEqual(result.detachedDebugSymbols, {
    publishPath: "bin/winapp.pdb",
    fileName: "winapp.pdb",
    sizeBytes: Buffer.byteLength(f.contents["bin/winapp.pdb"]),
    sha256: digest(f.contents["bin/winapp.pdb"]),
  });
  assert.ok(
    (await readFile(path.join(f.symbolsDirectory, "winapp.pdb"))).equals(
      Buffer.from(f.contents["bin/winapp.pdb"]),
    ),
  );
  await assert.rejects(
    readFile(path.join(f.outputDirectory, "bin/winapp.pdb")),
    { code: "ENOENT" },
  );
  assert.equal(
    result.originalPublish.files.length,
    Object.keys(f.contents).length,
  );
  for (const [name, bytes] of Object.entries(f.contents)) {
    if (name === "bin/winapp.pdb") continue;
    assert.ok(
      (await readFile(path.join(f.outputDirectory, name))).equals(
        Buffer.from(bytes),
      ),
    );
    assert.ok(
      result.runtimePublish.files.some(
        (file) => file.path === name && file.sha256 === digest(bytes),
      ),
    );
  }
  assert.deepEqual(
    result.originalPublish.directories,
    result.runtimePublish.directories,
  );
  assert.equal(
    result.originalPublish.files.length,
    result.runtimePublish.files.length + 1,
  );
});

test("known PDB absence, unexpected type, or non-fresh symbols output fail closed", async (t) => {
  for (const change of [
    async (f) => rm(path.join(f.outputDirectory, "bin/winapp.pdb")),
    async (f) => {
      await rm(path.join(f.outputDirectory, "bin/winapp.pdb"));
      await mkdir(path.join(f.outputDirectory, "bin/winapp.pdb"));
    },
    async (f) => mkdir(f.symbolsDirectory),
  ]) {
    const f = await publishFixture(t);
    await change(f);
    await assert.rejects(downstream.detachDownstreamDebugSymbols(f));
  }
});

test("symbol output cannot be the product root, inside it, or its ancestor", async (t) => {
  const f = await publishFixture(t);
  for (const symbolsDirectory of [
    f.outputDirectory,
    path.join(f.outputDirectory, "symbols"),
    f.temporary,
  ]) {
    await assert.rejects(
      downstream.detachDownstreamDebugSymbols({ ...f, symbolsDirectory }),
      /separate|overlap/u,
    );
    assert.equal(
      await readFile(path.join(f.outputDirectory, "bin/winapp.pdb"), "utf8"),
      f.contents["bin/winapp.pdb"],
    );
  }
});

test(
  "a PDB symlink is rejected without moving its target",
  { skip: process.platform === "win32" },
  async (t) => {
    const f = await publishFixture(t);
    await rm(path.join(f.outputDirectory, "bin/winapp.pdb"));
    await symlink(
      path.join(f.outputDirectory, "bin/winapp.exe"),
      path.join(f.outputDirectory, "bin/winapp.pdb"),
    );
    await assert.rejects(
      downstream.detachDownstreamDebugSymbols(f),
      /regular files/u,
    );
    assert.equal(
      await readFile(path.join(f.outputDirectory, "bin/winapp.exe"), "utf8"),
      f.contents["bin/winapp.exe"],
    );
  },
);

function productProvenance(partition) {
  return Buffer.from(
    `${JSON.stringify(
      {
        schemaVersion: 1,
        providerBuild: "zenx-winapp-0.3.1-af0.2",
        upstream: {
          repository: "microsoft/winappCli",
          tag: "v0.3.1",
          commit: "c8ada4a403c43b96780b87abc454cba51f649c60",
        },
        patchSha256: "a".repeat(64),
        sourceLockSha256: "b".repeat(64),
        dependencyLockSha256: "c".repeat(64),
        dotnetSdk: "10.0.401",
        runtimeVersion: "10.0.12",
        targetRid: "win-x64",
        ...partition.runtimePublish,
        detachedDebugSymbols: partition.detachedDebugSymbols,
      },
      null,
      2,
    )}\n`,
  );
}

test("detached symbol evidence binds original publish files to exact product provenance bytes", async (t) => {
  const f = await publishFixture(t);
  const partition = await downstream.detachDownstreamDebugSymbols(f);
  const productProvenanceBytes = productProvenance(partition);
  const result = await downstream.writeDownstreamSymbolsEvidence({
    ...f,
    partition,
    productProvenanceBytes,
  });
  const bytes = await readFile(
    path.join(f.symbolsDirectory, "symbols-provenance.json"),
  );
  assert.equal(digest(bytes), result.symbolsProvenanceSha256);
  const evidence = JSON.parse(bytes);
  assert.equal(
    evidence.productProvenanceSha256,
    digest(productProvenanceBytes),
  );
  assert.deepEqual(evidence.originalPublish, partition.originalPublish);
  assert.deepEqual(
    evidence.detachedDebugSymbols,
    partition.detachedDebugSymbols,
  );
  assert.deepEqual(evidence.files, [
    {
      path: "winapp.pdb",
      sizeBytes: partition.detachedDebugSymbols.sizeBytes,
      sha256: partition.detachedDebugSymbols.sha256,
    },
  ]);
  assert.equal(evidence.bitReproducibilityVerified, false);
  assert.equal(evidence.productIntegrationVerified, false);
  await assert.rejects(
    downstream.writeDownstreamSymbolsEvidence({
      ...f,
      partition,
      productProvenanceBytes,
    }),
  );
});

test("changed symbols, omitted original files and additional symbols-directory files cannot be finalized", async (t) => {
  for (const mutate of [
    async (f) =>
      writeFile(path.join(f.symbolsDirectory, "winapp.pdb"), "tampered"),
    async (f) =>
      writeFile(path.join(f.symbolsDirectory, "provenance.json"), "unexpected"),
    async (_f, partition) => {
      partition.originalPublish.files.pop();
    },
    async (_f, partition) => {
      partition.originalPublish.files.push(partition.originalPublish.files[0]);
    },
  ]) {
    const f = await publishFixture(t);
    const partition = await downstream.detachDownstreamDebugSymbols(f);
    const productProvenanceBytes = productProvenance(partition);
    await mutate(f, partition);
    await assert.rejects(
      downstream.writeDownstreamSymbolsEvidence({
        ...f,
        partition,
        productProvenanceBytes,
      }),
    );
    await assert.rejects(
      readFile(path.join(f.symbolsDirectory, "symbols-provenance.json")),
      { code: "ENOENT" },
    );
  }
});

test("both native workflows keep symbols in separate explicit fourteen-day evidence", async () => {
  const root = new URL("../../../", import.meta.url);
  for (const workflow of [
    ".github/workflows/ci.yml",
    ".github/workflows/zenx-winapp-downstream.yml",
  ]) {
    const text = await readFile(new URL(workflow, root), "utf8");
    assert.match(
      text,
      /--output "\$\{\{ runner\.temp \}\}\/zenx-winapp-downstream" --symbols-output "\$\{\{ runner\.temp \}\}\/zenx-winapp-symbols"/u,
    );
    assert.match(
      text,
      /name: zenx-winapp-debug-symbols-\$\{\{ github\.sha \}\}/u,
    );
    assert.match(
      text,
      /zenx-winapp-symbols\/winapp\.pdb\s+\$\{\{ runner\.temp \}\}\/zenx-winapp-symbols\/symbols-provenance\.json\s+if-no-files-found: warn\s+retention-days: 14/u,
    );
  }
  const assembler = await readFile(
    new URL("scripts/assemble-zenx-providers.mjs", root),
    "utf8",
  );
  assert.doesNotMatch(
    assembler,
    /winapp\.pdb|detachedDebugSymbols|symbols-provenance/u,
  );
});
