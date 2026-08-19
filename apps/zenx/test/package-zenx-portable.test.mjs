import assert from "node:assert/strict";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  packageManifest,
  stagePackage,
} from "../scripts/package-zenx-portable.mjs";

const placeholder = "__ZENX_PACKAGED_PROVIDER_MANIFEST_SHA256__";

test("stages the real app without modifying reusable build output", async () => {
  const fixture = await createFixture();
  try {
    const appDirectory = path.join(fixture.directory, "app");
    await stagePackage({
      target: "app",
      outDirectory: fixture.outDirectory,
      rootDirectory: fixture.rootDirectory,
      appDirectory,
      manifestSha256: "fixture-digest",
    });

    assert.equal(await readFile(fixture.integrityFile, "utf8"), placeholder);
    assert.equal(
      await readFile(
        path.join(appDirectory, "out", "main", "integrity.js"),
        "utf8",
      ),
      "fixture-digest",
    );
    await access(path.join(appDirectory, "out", "main", "app-server-host.js"));
    await access(path.join(appDirectory, "out", "preload", "index.cjs"));
    await access(path.join(appDirectory, "out", "renderer", "index.html"));
    await access(path.join(appDirectory, "node_modules", "ws", "index.js"));
    assert.deepEqual(
      packageManifest("app", {
        version: "0.1.0",
        dependencies: { ws: "^8.18.3" },
      }),
      {
        name: "zenx",
        version: "0.1.0",
        private: true,
        type: "module",
        main: "out/main/index.js",
        dependencies: { ws: "^8.18.3" },
      },
    );
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("stages only the provider smoke through the same digest path", async () => {
  const fixture = await createFixture();
  try {
    const appDirectory = path.join(fixture.directory, "smoke");
    await stagePackage({
      target: "smoke",
      outDirectory: fixture.outDirectory,
      rootDirectory: fixture.rootDirectory,
      appDirectory,
      manifestSha256: "smoke-digest",
    });

    assert.equal(await readFile(fixture.integrityFile, "utf8"), placeholder);
    assert.equal(
      await readFile(path.join(appDirectory, "main", "integrity.js"), "utf8"),
      "smoke-digest",
    );
    await assert.rejects(access(path.join(appDirectory, "out")), {
      code: "ENOENT",
    });
    await assert.rejects(access(path.join(appDirectory, "node_modules")), {
      code: "ENOENT",
    });
    assert.equal(
      packageManifest("smoke", {
        version: "0.1.0",
        dependencies: { ws: "^8.18.3" },
      }).main,
      "main/packaged-provider-smoke.js",
    );
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

async function createFixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zenx-package-test-"));
  const rootDirectory = path.join(directory, "root");
  const outDirectory = path.join(directory, "out");
  const integrityFile = path.join(outDirectory, "main", "integrity.js");
  await mkdir(path.dirname(integrityFile), { recursive: true });
  await mkdir(path.join(outDirectory, "preload"), { recursive: true });
  await mkdir(path.join(outDirectory, "renderer"), { recursive: true });
  await mkdir(path.join(rootDirectory, "node_modules", "ws"), {
    recursive: true,
  });
  await Promise.all([
    writeFile(integrityFile, placeholder),
    writeFile(path.join(outDirectory, "main", "app-server-host.js"), "host"),
    writeFile(path.join(outDirectory, "preload", "index.cjs"), "preload"),
    writeFile(path.join(outDirectory, "renderer", "index.html"), "renderer"),
    writeFile(path.join(rootDirectory, "node_modules", "ws", "index.js"), "ws"),
  ]);
  return { directory, rootDirectory, outDirectory, integrityFile };
}
