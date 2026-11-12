import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { recordChromeNativeHostFailure } from "../src/main/chrome-native-host-diagnostics.js";

test("native host cause persists owner-local, stderr only receives its location", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-native-diagnostic-"),
  );
  try {
    const error = new Error("bridge connection failed", {
      cause: new Error("ws://127.0.0.1/?token=synthetic-bridge-secret"),
    });
    const notice = await recordChromeNativeHostFailure(
      directory,
      "resolve-user-data",
      error,
    );
    assert.match(notice, /Local details:/);
    assert.doesNotMatch(notice, /synthetic-bridge-secret/);
    const file = path.join(
      directory,
      "diagnostics",
      "chrome-native-host.jsonl",
    );
    const record = JSON.parse(await readFile(file, "utf8"));
    assert.match(record.detail, /synthetic-bridge-secret/);
    assert.match(record.detail, /chrome-native-host-diagnostics.test/);
    if (process.platform !== "win32")
      assert.equal((await stat(file)).mode & 0o777, 0o600);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test("unresolved directory and unwritable destination explicitly report missing evidence", async () => {
  assert.match(
    await recordChromeNativeHostFailure(
      undefined,
      "resolve-user-data",
      new Error("x"),
    ),
    /not resolved/,
  );
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-native-diagnostic-blocked-"),
  );
  try {
    const file = path.join(directory, "not-a-directory");
    await writeFile(file, "synthetic");
    assert.match(
      await recordChromeNativeHostFailure(
        file,
        "resolve-user-data",
        new Error("x"),
      ),
      /storage failed/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
