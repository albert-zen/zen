import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { prepareRtkResource } from "../scripts/prepare-rtk.mjs";

const binary = Buffer.from(
  "Synthetic RTK fixture: data only, never executed.\n",
);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const archive = archiveContaining(binary);

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "zenx-rtk-cache-"));
  let requests = 0;
  let respond = (_request, response) => response.end(archive);
  const server = createServer((request, response) => {
    requests += 1;
    respond(request, response);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const options = {
    cacheDirectory: path.join(root, "cache"),
    platform: "darwin",
    arch: "arm64",
    archiveUrl: `http://127.0.0.1:${server.address().port}/rtk.tar.gz`,
    expectedArchiveSha256: sha256(archive),
    expectedBinarySha256: sha256(binary),
  };
  return {
    root,
    options,
    requests: () => requests,
    respondWith: (handler) => {
      respond = handler;
    },
    prepare: (name, overrides = {}) =>
      prepareRtkResource({
        ...options,
        resourcesDirectory: path.join(root, name),
        ...overrides,
      }),
    cacheFile: path.join(options.cacheDirectory, "sha256", sha256(archive)),
  };
}

test("separate RTK staging runs reuse a reverified archive without another request", async (t) => {
  const f = await fixture(t);
  assert.equal(await f.prepare("first"), true);
  // The first staging directory is disposable; only the archive cache survives.
  await rm(path.join(f.root, "first"), { recursive: true });
  f.respondWith((_request, response) => response.writeHead(503).end());
  assert.equal(await f.prepare("second"), true);
  assert.equal(f.requests(), 1);
  const destination = path.join(f.root, "second", "rtk");
  assert.deepEqual(await readFile(path.join(destination, "rtk")), binary);
  assert.deepEqual(
    await readFile(path.join(destination, "NOTICE.txt")),
    await readFile(new URL("../resources/rtk-NOTICE.txt", import.meta.url)),
  );
  if (process.platform !== "win32") {
    assert.equal(
      (await stat(path.join(destination, "rtk"))).mode & 0o777,
      0o755,
    );
    assert.equal((await stat(f.cacheFile)).mode & 0o222, 0);
  }
  assert.deepEqual(await readdir(path.join(f.root, "second")), ["rtk"]);
});

test("concurrent RTK staging runs share one verified acquisition", async (t) => {
  const f = await fixture(t);
  await Promise.all([
    f.prepare("first"),
    f.prepare("second"),
    f.prepare("third"),
  ]);
  assert.equal(f.requests(), 1);
  for (const name of ["first", "second", "third"]) {
    assert.deepEqual(
      await readFile(path.join(f.root, name, "rtk", "rtk")),
      binary,
    );
  }
});

test("RTK rejects truncated, stale and wrong-digest cache bytes before replacing them", async (t) => {
  const f = await fixture(t);
  await mkdir(path.dirname(f.cacheFile), { recursive: true });
  for (const [index, bytes] of [
    archive.subarray(0, 20),
    Buffer.from("old version"),
    Buffer.alloc(archive.length),
  ].entries()) {
    await chmod(f.cacheFile, 0o600).catch(() => {});
    await writeFile(f.cacheFile, bytes);
    await f.prepare(`staging-${index}`);
    assert.deepEqual(await readFile(f.cacheFile), archive);
  }
  assert.equal(f.requests(), 3);
});

test("a changed RTK digest cannot hit a previous pin's cache", async (t) => {
  const f = await fixture(t);
  await f.prepare("first");
  const newerBinary = Buffer.from("Different synthetic pin, never executed.\n");
  const newerArchive = archiveContaining(newerBinary);
  f.respondWith((_request, response) => response.end(newerArchive));
  await f.prepare("second", {
    expectedArchiveSha256: sha256(newerArchive),
    expectedBinarySha256: sha256(newerBinary),
  });
  assert.equal(f.requests(), 2);
  assert.deepEqual(
    await readFile(path.join(f.root, "second", "rtk", "rtk")),
    newerBinary,
  );
  assert.deepEqual(await readFile(f.cacheFile), archive);
});

test("RTK bad downloads and interrupted responses leave no archive or staging binary", async (t) => {
  const f = await fixture(t);
  const failures = [
    (_request, response) => response.end("wrong digest"),
    (_request, response) => {
      response.writeHead(200, { "content-length": archive.length });
      response.write(archive.subarray(0, 10));
      response.destroy();
    },
    (_request, response) => response.writeHead(503).end(),
  ];
  for (const [index, handler] of failures.entries()) {
    f.respondWith(handler);
    await assert.rejects(
      f.prepare(`failed-${index}`),
      /Verified artifact acquisition failed/,
    );
    assert.deepEqual(await readdir(path.join(f.root, `failed-${index}`)), []);
    assert.deepEqual(
      (await readdir(path.dirname(f.cacheFile))).filter(
        (name) => name !== ".transactions",
      ),
      [],
    );
  }
  f.respondWith((_request, response) => response.end(archive));
  assert.equal(await f.prepare("recovered"), true);
  assert.equal(f.requests(), 4);
});

test("RTK still verifies extracted bytes and skips unsupported platform/architecture", async (t) => {
  const f = await fixture(t);
  assert.equal(await f.prepare("windows", { platform: "win32" }), false);
  assert.equal(await f.prepare("intel", { arch: "x64" }), false);
  assert.equal(f.requests(), 0);
  await assert.rejects(
    f.prepare("wrong-binary", {
      expectedBinarySha256: sha256("not the fixture"),
    }),
    /RTK binary checksum mismatch/,
  );
  assert.deepEqual(await readdir(path.join(f.root, "wrong-binary")), []);
});

// Fixed tar header and gzip metadata make the synthetic pin deterministic.
function archiveContaining(bytes) {
  const header = Buffer.alloc(512);
  header.write("rtk", 0);
  header.write("0000755\0", 100);
  header.write("0000000\0", 108);
  header.write("0000000\0", 116);
  header.write(`${bytes.length.toString(8).padStart(11, "0")}\0`, 124);
  header.write("00000000000\0", 136);
  header.fill(32, 148, 156);
  header.write("0", 156);
  header.write("ustar\0", 257);
  header.write("00", 263);
  const checksum = header.reduce((sum, value) => sum + value, 0);
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148);
  return gzipSync(
    Buffer.concat([
      header,
      bytes,
      Buffer.alloc(((512 - (bytes.length % 512)) % 512) + 1024),
    ]),
  );
}
