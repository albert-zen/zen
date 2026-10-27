import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { packageZenX } from "./package-zenx-portable.mjs";
import {
  createArtifactManifest,
  fileSha256,
  sourceIdentity,
  verifyArtifact,
  verifyMacSignature,
} from "./portable-artifact.mjs";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const run = promisify(execFile);
const args = process.argv.slice(2);
const outputIndex = args.indexOf("--output");
assert.ok(outputIndex >= 0 && args[outputIndex + 1], "--output is required");
const output = path.resolve(args[outputIndex + 1]);
args.splice(outputIndex, 2);
assert.ok(
  args.every(
    (arg, index) =>
      index % 2 === 1 || ["--downstream", "--downstream-sha256"].includes(arg),
  ),
  "Only existing downstream arguments are supported",
);
// New output prevents a failed attempt from presenting a stale successful receipt.
await mkdir(output, { recursive: false, mode: 0o700 });
const source = await sourceIdentity(root);
const result = await packageZenX(["--app", ...args]);
assert.deepEqual(
  await sourceIdentity(root),
  source,
  "Source changed while packaging",
);
const manifest = await createArtifactManifest({
  directory: result.packagedArtifact,
  source,
});
const archive = path.join(output, `${manifest.artifactDirectory}.tar.gz`);
await run(
  "tar",
  [
    "-czf",
    archive,
    "-C",
    path.dirname(result.packagedArtifact),
    "--",
    manifest.artifactDirectory,
  ],
  { timeout: 5 * 60_000 },
);
const archiveSha256 = await fileSha256(archive);
const extraction = await mkdtemp(
  path.join(os.tmpdir(), "zenx-delivery-verify-"),
);
let validated = false;
try {
  await run("tar", ["-xzf", archive, "-C", extraction], {
    timeout: 5 * 60_000,
  });
  const extracted = path.join(extraction, manifest.artifactDirectory);
  await verifyArtifact(extracted, manifest);
  const signing = await verifyMacSignature(extracted);
  const { smokePortableArtifact } =
    await import("./smoke-portable-artifact.ts");
  const acceptance = await smokePortableArtifact({
    artifactDirectory: extracted,
  });
  await verifyArtifact(extracted, manifest);
  await verifyArtifact(result.packagedArtifact, manifest);
  assert.equal(
    await fileSha256(archive),
    archiveSha256,
    "Archive changed during validation",
  );
  assert.deepEqual(
    await sourceIdentity(root),
    source,
    "Source changed during validation",
  );
  await writeFile(
    path.join(output, "portable-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  await writeFile(
    path.join(output, "portable-validation.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        source,
        target: manifest.target,
        archive: { filename: path.basename(archive), sha256: archiveSha256 },
        fileManifestSha256: manifest.fileManifestSha256,
        signing,
        acceptance,
        unchangedAfterValidation: true,
        publication: {
          allowed: false,
          reason:
            "Bundled Chrome for Testing binary redistribution authorization remains unverified; archive stays on ephemeral build runner, never uploaded.",
        },
      },
      null,
      2,
    )}\n`,
  );
  validated = true;
  console.log(
    JSON.stringify({
      source,
      target: manifest.target,
      archiveSha256,
      validation: "passed",
      publication: "blocked",
    }),
  );
} finally {
  // Failed runtime shutdown may leave an owned process; never remove its executable.
  if (validated) await rm(extraction, { recursive: true, force: true });
}
