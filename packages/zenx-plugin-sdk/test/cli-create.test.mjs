import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const packageRoot = path.resolve(import.meta.dirname, "..");
const cli = path.join(packageRoot, "dist", "cli.js");

test("create writes a normal npm plugin package that imports only the public SDK", async () => {
  const externalRoot = await mkdtemp(path.join(os.tmpdir(), "zenx-create-"));
  const target = path.join(externalRoot, "hello-plugin");
  try {
    const result = spawnSync(
      process.execPath,
      [
        cli,
        "create",
        target,
        "--name",
        "@fixture/hello-plugin",
        "--id",
        "hello-plugin",
      ],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);

    const packageJson = JSON.parse(
      await readFile(path.join(target, "package.json"), "utf8"),
    );
    assert.equal(packageJson.name, "@fixture/hello-plugin");
    assert.equal(packageJson.zenx.plugin, "./zenx.plugin.json");
    assert.equal(packageJson.dependencies["@zenx/plugin-sdk"], "^0.1.0");

    const manifest = JSON.parse(
      await readFile(path.join(target, "zenx.plugin.json"), "utf8"),
    );
    assert.equal(manifest.id, "hello-plugin");
    assert.equal(manifest.runtime.type, "process");
    assert.equal(manifest.runtime.entry, "./runtime.mjs");
    assert.equal(manifest.tools[0].name, "hello_plugin_run");

    const runtime = await readFile(path.join(target, "runtime.mjs"), "utf8");
    assert.match(runtime, /from "@zenx\/plugin-sdk"/u);
    assert.doesNotMatch(runtime, /apps\/zenx|src\/main/u);
  } finally {
    await rm(externalRoot, { recursive: true, force: true });
  }
});

test("validate rejects an unstable npm package identity", async () => {
  const externalRoot = await mkdtemp(path.join(os.tmpdir(), "zenx-identity-"));
  const target = path.join(externalRoot, "invalid-identity");
  try {
    const created = spawnSync(
      process.execPath,
      [
        cli,
        "create",
        target,
        "--name",
        "valid-identity",
        "--id",
        "valid-identity",
      ],
      { encoding: "utf8" },
    );
    assert.equal(created.status, 0, created.stderr);
    const packageJsonPath = path.join(target, "package.json");
    const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
    packageJson.name = "Invalid Package Name";
    await writeFile(
      packageJsonPath,
      `${JSON.stringify(packageJson)}\n`,
      "utf8",
    );

    const validated = spawnSync(process.execPath, [cli, "validate", target], {
      encoding: "utf8",
    });
    assert.equal(validated.status, 1);
    assert.match(
      validated.stderr,
      /package\.json#name is not a valid npm package name/u,
    );
  } finally {
    await rm(externalRoot, { recursive: true, force: true });
  }
});

test("validate accepts the created package through its public package-directory seam", async () => {
  const externalRoot = await mkdtemp(path.join(os.tmpdir(), "zenx-validate-"));
  const target = path.join(externalRoot, "valid-plugin");
  try {
    const created = spawnSync(
      process.execPath,
      [cli, "create", target, "--name", "valid-plugin", "--id", "valid-plugin"],
      { encoding: "utf8" },
    );
    assert.equal(created.status, 0, created.stderr);
    const validated = spawnSync(process.execPath, [cli, "validate", target], {
      encoding: "utf8",
    });
    assert.equal(validated.status, 0, validated.stderr);
    assert.deepEqual(JSON.parse(validated.stdout), {
      packageName: "valid-plugin",
      pluginId: "valid-plugin",
      manifestPath: "zenx.plugin.json",
    });
  } finally {
    await rm(externalRoot, { recursive: true, force: true });
  }
});
