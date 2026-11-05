import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import test from "node:test";
import {
  stageAppShotDbus,
  APP_SHOT_DBUS_PACKAGES,
} from "../scripts/stage-app-shot-dbus.mjs";
import {
  APP_SHOT_DBUS_PATCH,
  dbusBlobHash,
} from "../scripts/patch-app-shot-dbus.mjs";

test("npm ci runs the pinned D-Bus preparer after preceding lifecycle steps succeed", async () => {
  const packageJson = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  assert.equal(packageJson.dependencies["dbus-next"], "0.10.2");
  assert.match(
    packageJson.scripts.postinstall,
    /&&\s*node \.\/scripts\/prepare-app-shot-dbus\.mjs\s*(?=&&|$)/,
  );
});

test("staged pure-JS D-Bus closure loads without connecting or optional usocket", async () => {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const target = await mkdtemp(path.join(tmpdir(), "zenx-dbus-stage-"));
  try {
    assert.equal(
      (await stageAppShotDbus(root, target)).length,
      APP_SHOT_DBUS_PACKAGES.length,
    );
    const require = createRequire(path.join(target, "package.json"));
    const dbus = require("dbus-next");
    assert.equal(typeof dbus.sessionBus, "function");
    assert.equal(typeof dbus.Message, "function");
    assert.equal(
      dbusBlobHash(
        await readFile(
          path.join(target, "node_modules/dbus-next/lib/connection.js"),
        ),
      ),
      APP_SHOT_DBUS_PATCH.patchedConnectionBlob,
    );
    await assert.rejects(access(path.join(target, "node_modules/usocket")), {
      code: "ENOENT",
    });
    assert.match(
      await readFile(
        path.join(target, "licenses/T3-App-Shot-D-Bus.txt"),
        "utf8",
      ),
      /MIT License/,
    );
    await stageAppShotDbus(root, target);
  } finally {
    await rm(target, { recursive: true, force: true });
  }
});
