import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { resolveConfig } from "vite";
import {
  blobHash,
  originalBlob,
  patchedBlob,
  prepareLegendList,
} from "../scripts/prepare-legend-list.mjs";
const root = fileURLToPath(new URL("../../../", import.meta.url));
const modulePath = fileURLToPath(import.meta.resolve("@legendapp/list/react"));
const patchPath = fileURLToPath(
  new URL("../patches/legend-list-3.3.5-react.patch", import.meta.url),
);
const scratch = resolve(root, ".test-tmp");
mkdirSync(scratch, { recursive: true });
function fixture(run) {
  const directory = mkdtempSync(resolve(scratch, "legend-patch-"));
  const module = resolve(directory, "node_modules/@legendapp/list/react.mjs");
  mkdirSync(dirname(module), { recursive: true });
  copyFileSync(modulePath, module);
  execFileSync("git", ["init", "--quiet", directory]);
  if (blobHash(readFileSync(module)) === patchedBlob)
    execFileSync(
      "git",
      [
        "apply",
        "--reverse",
        "--directory=node_modules/@legendapp/list",
        patchPath,
      ],
      { cwd: directory },
    );
  assert.equal(blobHash(readFileSync(module)), originalBlob);
  try {
    run(directory, module);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
test("exact web-only patch applies once and produces the reviewed T3-plus-Zen blob", () =>
  fixture((directory, module) => {
    assert.equal(
      prepareLegendList({ root: directory, modulePath: module }),
      "patched",
    );
    assert.equal(blobHash(readFileSync(module)), patchedBlob);
    assert.equal(
      prepareLegendList({ root: directory, modulePath: module }),
      "already patched",
    );
  }));
test("unknown package bytes are rejected without a write", () =>
  fixture((directory, module) => {
    writeFileSync(module, "unexpected source");
    assert.throws(
      () => prepareLegendList({ root: directory, modulePath: module }),
      /Unexpected LegendList web source/,
    );
    assert.equal(readFileSync(module, "utf8"), "unexpected source");
  }));
test("an external/shared dependency symlink is rejected before mutation", () =>
  fixture((directory, module) => {
    const external = resolve(directory, "shared-package/react.mjs");
    mkdirSync(dirname(external), { recursive: true });
    copyFileSync(module, external);
    rmSync(module);
    symlinkSync(external, module);
    assert.throws(
      () => prepareLegendList({ root: directory, modulePath: module }),
      /symlinked\/shared/,
    );
    assert.equal(blobHash(readFileSync(external)), originalBlob);
  }));
test("Node ESM/tsx and Vite resolve react.mjs; CJS remains explicitly unpatched", async () => {
  assert.ok(modulePath.endsWith("/react.mjs"));
  assert.ok(
    createRequire(import.meta.url)
      .resolve("@legendapp/list/react")
      .endsWith("/react.js"),
  );
  const config = await resolveConfig(
    { root, configFile: false, logLevel: "silent" },
    "build",
  );
  const resolved = await config.createResolver()(
    "@legendapp/list/react",
    resolve(
      root,
      "apps/zenx/src/renderer/src/ExperimentalTranscriptViewport.tsx",
    ),
  );
  assert.equal(resolved, modulePath);
});
test("npm ci lifecycle keeps the dependency pin and invokes the local preparer", () => {
  const packageJson = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  );
  const lock = JSON.parse(
    readFileSync(resolve(root, "package-lock.json"), "utf8"),
  );
  assert.equal(packageJson.dependencies["@legendapp/list"], "3.3.5");
  assert.equal(
    lock.packages["apps/zenx"].dependencies["@legendapp/list"],
    "3.3.5",
  );
  assert.equal(
    packageJson.scripts["prepare:legend-list"],
    "node ./scripts/prepare-legend-list.mjs",
  );
  assert.match(
    packageJson.scripts.postinstall,
    /&& npm run prepare:legend-list$/,
  );
});
