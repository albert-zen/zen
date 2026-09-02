import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { npmInvocation } from "../src/npm-invocation.mjs";

const run = promisify(execFile);
const packageRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const expectedIdentity = "@zenx/plugin-sdk@0.1.0";
const expectedFilename = "zenx-plugin-sdk-0.1.0.tgz";

const result = await verifyPluginSdkPack();
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

export async function verifyPluginSdkPack() {
  const packageJson = JSON.parse(
    await readFile(path.join(packageRoot, "package.json"), "utf8"),
  );
  assert.equal(`${packageJson.name}@${packageJson.version}`, expectedIdentity);
  assert.equal(packageJson.private, undefined);
  assert.equal(packageJson.publishConfig?.access, "public");
  assert.equal(
    packageJson.repository?.url,
    "git+https://github.com/albert-zen/zen.git",
  );
  assert.equal(packageJson.repository?.directory, "packages/zenx-plugin-sdk");

  const directories = await Promise.all([
    mkdtemp(path.join(os.tmpdir(), "zenx-plugin-sdk-pack-a-")),
    mkdtemp(path.join(os.tmpdir(), "zenx-plugin-sdk-pack-b-")),
  ]);
  try {
    const [first, second] = await Promise.all(
      directories.map(async (directory) => {
        const invocation = npmInvocation([
          "pack",
          "--json",
          "--pack-destination",
          directory,
        ]);
        const packed = await run(invocation.executable, invocation.args, {
          cwd: packageRoot,
          maxBuffer: 1024 * 1024,
        });
        const [metadata] = JSON.parse(packed.stdout);
        assert.equal(metadata.id, expectedIdentity);
        assert.equal(metadata.filename, expectedFilename);
        assert.equal(metadata.entryCount, 27);
        const files = metadata.files.map(({ path: file }) => file).sort();
        assert.equal(files.length, 27);
        assert.deepEqual(
          files.filter(
            (file) =>
              file !== "README.md" &&
              file !== "package.json" &&
              !file.startsWith("dist/"),
          ),
          [],
        );
        for (const required of [
          "README.md",
          "dist/cli.js",
          "dist/index.d.ts",
          "dist/index.js",
          "dist/runtime.js",
          "dist/schema.js",
          "dist/types.d.ts",
          "dist/zenx.plugin.schema.json",
          "package.json",
        ]) {
          assert.equal(
            files.includes(required),
            true,
            `pack is missing ${required}`,
          );
        }
        const tarball = await readFile(path.join(directory, expectedFilename));
        return {
          bytes: tarball,
          integrity: metadata.integrity,
          shasum: metadata.shasum,
          size: metadata.size,
          unpackedSize: metadata.unpackedSize,
        };
      }),
    );
    assert.deepEqual(first.bytes, second.bytes);
    assert.equal(first.integrity, second.integrity);
    assert.equal(first.shasum, second.shasum);
    assert.equal(first.size, second.size);
    assert.equal(first.unpackedSize, second.unpackedSize);
    const sha256 = createHash("sha256").update(first.bytes).digest("hex");
    return {
      id: expectedIdentity,
      filename: expectedFilename,
      sha256,
      shasum: first.shasum,
      integrity: first.integrity,
      size: first.size,
      unpackedSize: first.unpackedSize,
      entryCount: 27,
      reproduciblePacks: 2,
      publicationWarnings: [
        "No repository LICENSE or NOTICE has been selected; choose and review legal terms before npm publication.",
      ],
    };
  } finally {
    await Promise.all(
      directories.map((directory) =>
        rm(directory, { recursive: true, force: true }),
      ),
    );
  }
}
