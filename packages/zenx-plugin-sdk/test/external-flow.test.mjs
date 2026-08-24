import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const packageRoot = path.resolve(import.meta.dirname, "..");
const cli = path.join(packageRoot, "dist", "cli.js");

test("an external temp project completes create, public SDK import, validate, and standard pack", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "zenx-external-flow-"));
  const target = path.join(root, "external-plugin");
  try {
    const sdkPack = run("npm", ["pack", "--json", "--pack-destination", root], {
      cwd: packageRoot,
    });
    const [sdkResult] = JSON.parse(sdkPack.stdout);
    const sdkTarball = path.join(root, sdkResult.filename);

    run(process.execPath, [
      cli,
      "create",
      target,
      "--name",
      "external-plugin",
      "--id",
      "external-plugin",
    ]);
    const packageBeforeInstall = JSON.parse(
      await readFile(path.join(target, "package.json"), "utf8"),
    );
    assert.deepEqual(Object.keys(packageBeforeInstall.dependencies), [
      "@zenx/plugin-sdk",
    ]);
    assert.equal(
      packageBeforeInstall.dependencies["@zenx/plugin-sdk"],
      "^0.1.0",
    );

    run("npm", ["install", "--ignore-scripts", "--no-save", sdkTarball], {
      cwd: target,
    });
    const invocation = {
      version: 1,
      hostSdkVersion: 1,
      type: "invoke",
      id: "external-call",
      tool: "external_plugin_run",
      arguments: { value: "outside-repository" },
      context: { callId: "external-call", cwd: root },
    };
    const runtime = run(process.execPath, [path.join(target, "runtime.mjs")], {
      cwd: target,
      input: `${JSON.stringify(invocation)}\n${JSON.stringify({ version: 1, type: "close" })}\n`,
    });
    const messages = runtime.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.deepEqual(messages[0], {
      version: 1,
      type: "ready",
      pluginId: "external-plugin",
      packageVersion: "0.1.0",
    });
    assert.deepEqual(messages[1], {
      version: 1,
      type: "result",
      id: "external-call",
      result: {
        output: '{"value":"outside-repository"}',
        exitCode: 0,
      },
    });

    const validated = run(process.execPath, [cli, "validate", target]);
    assert.equal(JSON.parse(validated.stdout).pluginId, "external-plugin");
    const packed = run(process.execPath, [cli, "pack", target]);
    const [packResult] = JSON.parse(packed.stdout);
    assert.equal(packResult.filename, "external-plugin-0.1.0.tgz");
    assert.ok(
      packResult.files.some((file) => file.path === "zenx.plugin.json"),
    );
    assert.ok(packResult.files.some((file) => file.path === "runtime.mjs"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function run(executable, arguments_, options = {}) {
  const result = spawnSync(executable, arguments_, {
    encoding: "utf8",
    ...options,
  });
  assert.equal(result.status, 0, result.stderr);
  return result;
}
