import assert from "node:assert/strict";
import { execFile } from "node:child_process";
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
import { promisify } from "node:util";
import {
  assertPublicArtifactPath,
  createArtifactManifest,
  executableTarget,
  inventoryArtifact,
  sha256,
  verifyArtifact,
} from "../scripts/portable-artifact.mjs";

const run = promisify(execFile);
function elf() {
  const header = Buffer.alloc(64);
  header.write("7f454c46", "hex");
  header[4] = 2;
  header[5] = 1;
  header.writeUInt16LE(62, 18);
  return header;
}
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "zenx-portable-manifest-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, "ZenX-linux-x64");
  await mkdir(path.join(directory, "resources/app/out/main"), {
    recursive: true,
  });
  await mkdir(path.join(directory, "resources/providers"), { recursive: true });
  await writeFile(path.join(directory, "ZenX"), elf(), { mode: 0o755 });
  await writeFile(
    path.join(directory, "resources/app/package.json"),
    JSON.stringify({
      name: "zenx",
      main: "out/main/index.js",
      version: "0.1.0",
    }),
  );
  await writeFile(
    path.join(directory, "resources/app/out/main/index.js"),
    "// ordinary compiled application\n",
  );
  await writeFile(
    path.join(directory, "resources/providers/manifest.json"),
    "{}\n",
  );
  return { root, directory };
}
const source = { commit: "a".repeat(40), tree: "b".repeat(40), lockfiles: [] };
const manifestFor = (directory) =>
  createArtifactManifest({ directory, source, platform: "linux", arch: "x64" });

test("manifest binds complete files, source, executable architecture and provider bytes", async (t) => {
  const { directory } = await fixture(t);
  const manifest = await manifestFor(directory);
  assert.equal(manifest.source.commit, source.commit);
  assert.deepEqual(manifest.target, { platform: "linux", arch: "x64" });
  assert.equal(manifest.providerManifestSha256, sha256("{}\n"));
  await verifyArtifact(directory, manifest);
  await writeFile(
    path.join(directory, "resources/app/out/main/index.js"),
    "// changed application\n",
  );
  await assert.rejects(verifyArtifact(directory, manifest), /changed/u);
});

test("manifest rejects added files and changed targets", async (t) => {
  const { directory } = await fixture(t);
  const manifest = await manifestFor(directory);
  await writeFile(path.join(directory, "extra.txt"), "extra");
  await assert.rejects(verifyArtifact(directory, manifest), /changed/u);
  const macho = Buffer.alloc(64);
  macho.writeUInt32LE(0xfeedfacf);
  macho.writeUInt32LE(0x0100000c, 4);
  await writeFile(path.join(directory, "ZenX"), macho);
  await assert.rejects(manifestFor(directory), /target does not match/u);
});

test("architecture reads native executable headers, never client metadata", () => {
  assert.deepEqual(executableTarget(elf()), { platform: "linux", arch: "x64" });
  const macho = Buffer.alloc(64);
  macho.writeUInt32LE(0xfeedfacf);
  macho.writeUInt32LE(0x0100000c, 4);
  assert.deepEqual(executableTarget(macho), {
    platform: "darwin",
    arch: "arm64",
  });
  const pe = Buffer.alloc(256);
  pe.write("MZ");
  pe.writeUInt32LE(128, 0x3c);
  pe.writeUInt32LE(0x4550, 128);
  pe.writeUInt16LE(0x8664, 132);
  assert.deepEqual(executableTarget(pe), { platform: "win32", arch: "x64" });
  pe.writeUInt32LE(1024, 0x3c);
  assert.throws(() => executableTarget(pe), /offset/u);
  assert.throws(
    () => executableTarget(Buffer.from("not an executable")),
    /Unrecognized/u,
  );
});

test("publication inventory rejects private SDK/data/key paths", () => {
  for (const file of [
    "resources/app/.env",
    "resources/im_agent_sdk/code.py",
    "resources/.venv/python",
    "resources/trace/history",
    "host-profile.json",
    "signing.json",
    "secrets/signing.p12",
  ]) {
    assert.throws(
      () => assertPublicArtifactPath(file),
      /distribution|Fixture/u,
    );
  }
  assertPublicArtifactPath("resources/plugins/zenx-imzenx-plugin-1.0.3.tgz");
  assertPublicArtifactPath(
    "resources/app/node_modules/@zenx/plugin-sdk/dist/fixture-host.js",
  );
});

test("injected LaunchServices observer fails ordinary inventory", async (t) => {
  const { directory } = await fixture(t);
  await writeFile(
    path.join(directory, "resources/app/out/main/index.js"),
    "import * as __zenxLaunchPathObserver from './launch-path-observer.mjs';",
  );
  await assert.rejects(inventoryArtifact(directory), /Instrumented/u);
});

test(
  "internal links are recorded, escaping links fail without traversal",
  { skip: process.platform === "win32" },
  async (t) => {
    const { root, directory } = await fixture(t);
    await symlink("ZenX", path.join(directory, "internal-link"));
    const entries = await inventoryArtifact(directory);
    assert.equal(
      entries.find((entry) => entry.path === "internal-link").target,
      "ZenX",
    );
    await writeFile(path.join(root, "outside"), "not part of package");
    await symlink("../outside", path.join(directory, "escape"));
    await assert.rejects(inventoryArtifact(directory), /escapes/u);
  },
);

test("same archive extracts to exactly the manifest and remains unchanged", async (t) => {
  const { root, directory } = await fixture(t);
  const manifest = await manifestFor(directory);
  const archive = path.join(root, "package.tar.gz");
  const extraction = path.join(root, "extracted");
  await mkdir(extraction);
  await run("tar", [
    "-czf",
    archive,
    "-C",
    root,
    "--",
    path.basename(directory),
  ]);
  const before = sha256(await readFile(archive));
  await run("tar", ["-xzf", archive, "-C", extraction]);
  await verifyArtifact(
    path.join(extraction, path.basename(directory)),
    manifest,
  );
  assert.equal(sha256(await readFile(archive)), before);
});

test("source identity rejects dirty and uncommitted sources and binds lockfiles", async (t) => {
  const { root } = await fixture(t);
  const repository = path.join(root, "source");
  await mkdir(repository);
  await run("git", ["init", repository]);
  for (const file of [
    "package-lock.json",
    "apps/zenx/resources/providers/provider-lock.json",
    "apps/imzen/uv.lock",
  ]) {
    await mkdir(path.dirname(path.join(repository, file)), { recursive: true });
    await writeFile(path.join(repository, file), "synthetic lock\n");
  }
  await run("git", ["-C", repository, "add", "."]);
  await run("git", [
    "-C",
    repository,
    "-c",
    "user.name=Synthetic",
    "-c",
    "user.email=synthetic@example.invalid",
    "commit",
    "-m",
    "fixture",
  ]);
  const { sourceIdentity } = await import("../scripts/portable-artifact.mjs");
  const identity = await sourceIdentity(repository);
  assert.match(identity.commit, /^[a-f0-9]{40}$/u);
  assert.match(identity.tree, /^[a-f0-9]{40}$/u);
  assert.equal(identity.lockfiles.length, 3);
  assert.ok(
    identity.lockfiles.every(
      (file) => file.sha256 === sha256("synthetic lock\n"),
    ),
  );
  await writeFile(path.join(repository, "uncommitted.ts"), "// synthetic");
  await assert.rejects(sourceIdentity(repository), /committed/u);
  await rm(path.join(repository, "uncommitted.ts"));
  await writeFile(path.join(repository, "package-lock.json"), "dirty");
  await assert.rejects(sourceIdentity(repository), /clean tracked/u);
});

test("nested first-party plugin tarball cannot conceal profile or private SDK paths", async (t) => {
  const { root, directory } = await fixture(t);
  const staging = path.join(root, "plugin");
  await mkdir(path.join(staging, "package"), { recursive: true });
  await writeFile(path.join(staging, "package/host-profile.json"), "{}");
  await mkdir(path.join(directory, "resources/plugins"));
  await run("tar", [
    "-czf",
    path.join(directory, "resources/plugins/synthetic.tgz"),
    "-C",
    staging,
    "package",
  ]);
  await assert.rejects(inventoryArtifact(directory), /Non-distribution/u);
});

test("CI retains only exact portable evidence files while binary publication is blocked", async () => {
  const { parse } = await import("yaml");
  const workflow = parse(
    await readFile(
      new URL("../../../.github/workflows/ci.yml", import.meta.url),
      "utf8",
    ),
  );
  for (const jobName of [
    "zenx-capability-smoke",
    "zenx-windows-packaged-provider-smoke",
  ]) {
    const steps = workflow.jobs[jobName].steps;
    const prepare = steps.find((step) =>
      step.run?.includes("scripts/prepare-portable-delivery.mjs"),
    );
    assert.ok(prepare);
    assert.notEqual(prepare["continue-on-error"], true);
    const upload = steps.find((step) =>
      step.with?.name?.startsWith("zenx-portable-identity-"),
    );
    assert.equal(upload.with["if-no-files-found"], "error");
    assert.deepEqual(upload.with.path.trim().split("\n"), [
      "${{ runner.temp }}/zenx-portable-delivery/portable-manifest.json",
      "${{ runner.temp }}/zenx-portable-delivery/portable-validation.json",
    ]);
    if (jobName.includes("windows")) {
      assert.ok(
        prepare.run.includes(
          '--downstream "${{ runner.temp }}/zenx-winapp-downstream"',
        ),
      );
      assert.ok(
        prepare.run.includes(
          '--downstream-sha256 "${{ steps.build-downstream.outputs.provenance-sha256 }}"',
        ),
      );
    }
  }
});
