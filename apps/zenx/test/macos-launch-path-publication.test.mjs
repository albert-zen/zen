import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { publishOwnershipReceipt } from "../scripts/macos-launch-path-ownership.mjs";

const writeFile = fs.writeFile;
const identity = {
  pid: 123,
  executable: "/fixture/ZenX",
  start: "native-start",
  bootId: "boot",
  receiptId: "receipt",
  round: "unit",
};

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "zx-lp-publish-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return { directory, ownershipFile: path.join(directory, "owner.json") };
}

function mockWrite(t, implementation) {
  t.mock.method(fs, "writeFile", implementation);
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
}

async function pausedWrite(t) {
  const started = Promise.withResolvers();
  const resume = Promise.withResolvers();
  mockWrite(t, async (file, data, options) => {
    await writeFile(file, "", options);
    started.resolve(file);
    await resume.promise;
    await writeFile(file, data, { ...options, flag: "w" });
  });
  t.after(() => resume.resolve());
  return { started: started.promise, resume: () => resume.resolve() };
}

test("ownership receipt is absent during writing and publishes complete identity with private permissions", async (t) => {
  const { directory, ownershipFile } = await fixture(t);
  const paused = await pausedWrite(t);
  const published = publishOwnershipReceipt(ownershipFile, identity);
  // Attach a rejection handler before inspecting the delayed filesystem write.
  const outcome = published.then(
    () => null,
    (error) => error,
  );
  const temporaryFile = await paused.started;
  try {
    assert.equal(await fs.readFile(temporaryFile, "utf8"), "");
    await assert.rejects(fs.readFile(ownershipFile), { code: "ENOENT" });
  } finally {
    paused.resume();
    await outcome;
  }
  await published;
  assert.deepEqual(
    JSON.parse(await fs.readFile(ownershipFile, "utf8")),
    identity,
  );
  if (process.platform !== "win32")
    assert.equal((await fs.stat(ownershipFile)).mode & 0o777, 0o600);
  assert.deepEqual(await fs.readdir(directory), ["owner.json"]);
});

test("receipt publication preserves an existing owner and cleans temporary files", async (t) => {
  const { directory, ownershipFile } = await fixture(t);
  const existing = '{"owner":"pre-existing"}';
  await writeFile(ownershipFile, existing);
  await assert.rejects(publishOwnershipReceipt(ownershipFile, identity), {
    code: "EEXIST",
  });
  assert.equal(await fs.readFile(ownershipFile, "utf8"), existing);
  assert.deepEqual(await fs.readdir(directory), ["owner.json"]);
});

test("receipt publication cannot overwrite an owner created while its write was pending", async (t) => {
  const { directory, ownershipFile } = await fixture(t);
  const paused = await pausedWrite(t);
  const published = publishOwnershipReceipt(ownershipFile, identity);
  const rejected = assert.rejects(published, { code: "EEXIST" });
  await paused.started;
  const existing = '{"owner":"concurrent"}';
  await writeFile(ownershipFile, existing);
  paused.resume();
  await rejected;
  assert.equal(await fs.readFile(ownershipFile, "utf8"), existing);
  assert.deepEqual(await fs.readdir(directory), ["owner.json"]);
});

test("failed receipt write leaves neither a published receipt nor temporary files", async (t) => {
  const { directory, ownershipFile } = await fixture(t);
  const failure = new Error("injected receipt write failure");
  mockWrite(t, async (file, data, options) => {
    await writeFile(file, "{", options);
    throw failure;
  });
  await assert.rejects(
    publishOwnershipReceipt(ownershipFile, identity),
    (error) => error === failure,
  );
  await assert.rejects(fs.readFile(ownershipFile), { code: "ENOENT" });
  assert.deepEqual(await fs.readdir(directory), []);
});
