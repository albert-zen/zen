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
const scriptPath = fileURLToPath(
  new URL("../scripts/prepare-legend-list.mjs", import.meta.url),
);
const patch = readFileSync(patchPath, "utf8").replace(/\r\n/g, "\n");
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
      ["apply", "--reverse", "--directory=node_modules/@legendapp/list", "-"],
      { cwd: directory, input: patch },
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
for (const autocrlf of [false, true]) {
  test(`preparer CLI accepts a core.autocrlf=${autocrlf} patch checkout without changing reviewed bytes`, () =>
    fixture((directory, module) => {
      const localScript = resolve(
        directory,
        "apps/zenx/scripts/prepare-legend-list.mjs",
      );
      const localPatch = resolve(
        directory,
        "apps/zenx/patches/legend-list-3.3.5-react.patch",
      );
      mkdirSync(dirname(localScript), { recursive: true });
      mkdirSync(dirname(localPatch), { recursive: true });
      copyFileSync(scriptPath, localScript);
      copyFileSync(
        resolve(dirname(modulePath), "package.json"),
        resolve(dirname(module), "package.json"),
      );
      writeFileSync(localPatch, patch);
      execFileSync("git", ["-c", "core.autocrlf=false", "add", localPatch], {
        cwd: directory,
      });
      rmSync(localPatch);
      execFileSync(
        "git",
        ["-c", `core.autocrlf=${autocrlf}`, "checkout", "--", localPatch],
        { cwd: directory },
      );
      const checkedOutPatch = readFileSync(localPatch);
      assert.equal(
        checkedOutPatch.toString(),
        autocrlf ? patch.replace(/\n/g, "\r\n") : patch,
      );
      assert.equal(blobHash(readFileSync(module)), originalBlob);
      for (const expected of ["patched", "already patched"]) {
        assert.equal(
          execFileSync(process.execPath, [localScript], {
            cwd: directory,
            encoding: "utf8",
          }).trim(),
          `LegendList web: ${expected}`,
        );
        assert.equal(blobHash(readFileSync(module)), patchedBlob);
        assert.deepEqual(readFileSync(localPatch), checkedOutPatch);
      }
    }));
}
test("unknown package bytes are rejected without a write", () =>
  fixture((directory, module) => {
    writeFileSync(module, "unexpected source");
    assert.throws(
      () => prepareLegendList({ root: directory, modulePath: module }),
      /Unexpected LegendList web source/,
    );
    assert.equal(readFileSync(module, "utf8"), "unexpected source");
  }));
test("CRLF installed source is rejected rather than normalized", () =>
  fixture((directory, module) => {
    const source = readFileSync(module, "utf8").replace(/\n/g, "\r\n");
    writeFileSync(module, source);
    assert.throws(
      () => prepareLegendList({ root: directory, modulePath: module }),
      /Unexpected LegendList web source/,
    );
    assert.equal(readFileSync(module, "utf8"), source);
  }));
test("a real dependency outside the requested checkout is rejected without a write", () =>
  fixture((directory, module) => {
    const otherCheckout = resolve(directory, "other-checkout");
    mkdirSync(otherCheckout);
    assert.throws(
      () => prepareLegendList({ root: otherCheckout, modulePath: module }),
      /outside this checkout/,
    );
    assert.equal(blobHash(readFileSync(module)), originalBlob);
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
test("a symlinked package directory is rejected before mutation", () =>
  fixture((directory, module) => {
    const external = resolve(directory, "shared-package/react.mjs");
    mkdirSync(dirname(external), { recursive: true });
    copyFileSync(module, external);
    rmSync(dirname(module), { recursive: true });
    symlinkSync(dirname(external), dirname(module), "junction");
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
