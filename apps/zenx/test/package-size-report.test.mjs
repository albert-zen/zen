import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { reportPackageSize } from "../../../scripts/report-zenx-package-size.mjs";

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zenx-size-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, "package");
  await mkdir(root);
  return { directory, root, platformKey: "linux-x64" };
}
async function put(root, file, bytes) {
  await mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await writeFile(path.join(root, file), bytes);
}

test("partitions assembly payloads, shares runtime once, and does not fabricate missing savings", async (t) => {
  const options = await fixture(t);
  for (const [file, bytes] of Object.entries({
    "app.asar": "123",
    "providers/runtime/node": "12345",
    "providers/playwright-cli/node_modules/playwright/index.js": "12",
    "providers/playwright-browsers/chromium-1237/chrome": "1234567",
    "providers/microsoft-winapp-cli/dist/cli.js": "1234",
  }))
    await put(options.root, file, bytes);
  const manifest = {
    schemaVersion: 1,
    providers: {
      "playwright-cli": { runtime: { path: "runtime/node" } },
      "microsoft-winapp-cli": { runtime: { path: "runtime/node" } },
    },
  };
  await put(options.root, "providers/manifest.json", JSON.stringify(manifest));
  const result = await reportPackageSize(options);
  assert.equal(result.components.runtime.logicalBytes, 5);
  assert.equal(result.components["playwright-cli"].logicalBytes, 2);
  assert.equal(result.components["playwright-browsers"].logicalBytes, 7);
  assert.equal(result.components["microsoft-winapp-cli"].logicalBytes, 4);
  assert.equal(result.components["application-remainder"].logicalBytes, 3);
  assert.equal(
    result.total.logicalBytes,
    21 + Buffer.byteLength(JSON.stringify(manifest)),
  );
  assert.equal(result.manifest.verification, "not-performed");
  assert.equal(result.archives.length, 6);
  assert.ok(
    result.archives.every(
      (entry) => entry.status === "unknown" && entry.compressedBytes === null,
    ),
  );
  assert.equal(result.estimatedSavingsBytes, null);
  assert.deepEqual(result, await reportPackageSize(options));
});

test("missing payloads and absent manifest remain unknown; accepts nested packaged layout", async (t) => {
  const options = await fixture(t);
  await put(options.root, "resources/providers/runtime/node", "abc");
  const result = await reportPackageSize({
    ...options,
    providersRelative: "resources/providers",
  });
  assert.equal(result.components.runtime.logicalBytes, 3);
  assert.equal(result.components["playwright-browsers"], null);
  assert.equal(result.manifest, null);
});

test(
  "never follows symlinks including dangling and component-root directory links",
  { skip: process.platform === "win32" },
  async (t) => {
    const options = await fixture(t);
    await put(options.directory, "outside/huge", "unrelated");
    await mkdir(path.join(options.root, "providers"));
    await symlink(
      path.join(options.directory, "outside"),
      path.join(options.root, "providers/runtime"),
    );
    await symlink("missing", path.join(options.root, "dangling"));
    const result = await reportPackageSize(options);
    assert.equal(result.total.logicalBytes, 0);
    assert.equal(result.total.symlinks, 2);
    assert.equal(result.components.runtime.files, 0);
    assert.equal(result.symlinks[0].path, "dangling");
    assert.equal(result.symlinks[1].component, "runtime");
    await assert.rejects(
      reportPackageSize({
        ...options,
        root: path.join(options.root, "providers/runtime"),
      }),
      /real directory/,
    );
  },
);

test("logical bytes include hardlink names; allocated blocks deduplicate inodes and handle sparse files", async (t) => {
  const options = await fixture(t);
  await put(options.root, "providers/runtime/node", "x");
  await truncate(
    path.join(options.root, "providers/runtime/node"),
    1024 * 1024,
  );
  await link(
    path.join(options.root, "providers/runtime/node"),
    path.join(options.root, "second-name"),
  );
  const result = await reportPackageSize(options);
  assert.equal(result.total.logicalBytes, 2 * 1024 * 1024);
  assert.equal(result.total.hardlinkDuplicates, 1);
  if (process.platform === "win32")
    assert.equal(result.total.allocatedBytes, null);
  else {
    let blocks = 0;
    for (const name of [
      "",
      "providers",
      "providers/runtime",
      "providers/runtime/node",
    ])
      blocks += (await lstat(path.join(options.root, name))).blocks;
    assert.equal(result.total.allocatedBytes, blocks * 512);
  }
});

test("only verified existing archives get compressed byte counts; cache is unchanged", async (t) => {
  const options = await fixture(t);
  const lock = JSON.parse(
    await readFile(
      new URL("../resources/providers/provider-lock.json", import.meta.url),
      "utf8",
    ),
  );
  const payload = Buffer.from(
    "synthetic compressed fixture; not a production download",
  );
  const digest = createHash("sha256").update(payload).digest("hex");
  lock.node.platformArchives[options.platformKey].sha256 = digest;
  options.lockPath = path.join(options.directory, "lock.json");
  options.cache = path.join(options.directory, "cache");
  await writeFile(options.lockPath, JSON.stringify(lock));
  await put(options.cache, `sha256/${digest}`, payload);
  const browserDigest =
    lock.browser.platformArchives[options.platformKey].sha256;
  await put(options.cache, `sha256/${browserDigest}`, "corrupt");
  const result = await reportPackageSize(options);
  assert.equal(result.archives[0].status, "verified");
  assert.equal(result.archives[0].compressedBytes, payload.length);
  assert.equal(result.archives[1].status, "digest-mismatch");
  assert.equal(result.archives[1].compressedBytes, null);
  assert.equal(result.archives[2].status, "missing");
  assert.equal(
    await readFile(path.join(options.cache, `sha256/${browserDigest}`), "utf8"),
    "corrupt",
  );
});

test("rejects unsupported schema, platform and escaping paths, and malformed manifests", async (t) => {
  const options = await fixture(t);
  await assert.rejects(
    reportPackageSize({ ...options, providersRelative: "../providers" }),
    /Invalid/,
  );
  await assert.rejects(
    reportPackageSize({ ...options, platformKey: "imaginary" }),
    /platform/,
  );
  await put(options.root, "providers/manifest.json", "bad json");
  await assert.rejects(reportPackageSize(options), SyntaxError);
  const lockPath = path.join(options.directory, "lock.json");
  await writeFile(lockPath, '{"schemaVersion":2}');
  await assert.rejects(reportPackageSize({ ...options, lockPath }), /schema/);
});

test("CLI emits JSON without assembly or installation and rejects unknown options", async (t) => {
  const options = await fixture(t);
  const script = new URL(
    "../../../scripts/report-zenx-package-size.mjs",
    import.meta.url,
  );
  const { stdout } = await promisify(execFile)(process.execPath, [
    fileURLToPath(script),
    "--root",
    options.root,
    "--platform",
    options.platformKey,
  ]);
  assert.equal(JSON.parse(stdout).total.logicalBytes, 0);
  await assert.rejects(
    promisify(execFile)(process.execPath, [
      fileURLToPath(script),
      "--download",
      "true",
    ]),
    /Expected unique/,
  );
});

test(
  "cache links are never read as verified archives",
  { skip: process.platform === "win32" },
  async (t) => {
    const options = await fixture(t);
    const lock = JSON.parse(
      await readFile(
        new URL("../resources/providers/provider-lock.json", import.meta.url),
        "utf8",
      ),
    );
    const digest = lock.node.platformArchives[options.platformKey].sha256;
    options.cache = path.join(options.directory, "cache");
    await mkdir(path.join(options.cache, "sha256"), { recursive: true });
    await put(options.directory, "outside", "do not hash this");
    await symlink(
      path.join(options.directory, "outside"),
      path.join(options.cache, "sha256", digest),
    );
    const result = await reportPackageSize(options);
    assert.equal(result.archives[0].status, "not-regular-file");
    assert.equal(result.archives[0].compressedBytes, null);
    const alias = path.join(options.directory, "cache-alias");
    await symlink(options.cache, alias);
    await assert.rejects(
      reportPackageSize({ ...options, cache: alias }),
      /real directory/,
    );
  },
);
