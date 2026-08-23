import assert from "node:assert/strict";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { discoverLocalCapabilityPackages } from "../src/main/capabilities/local-package.js";
import { JsonZenXCapabilityGrantStore } from "../src/main/capabilities/grant-store.js";
import { ZenXCapabilityRegistry } from "../src/main/capabilities/registry.js";
import { ZenXCapabilityService } from "../src/main/capability-service.js";
import { MemoryZenXCapabilityGrantStore } from "../src/main/capabilities/grant-store.js";

test("discovers and executes a local process package with a minimal JSON contract", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-local-capability-"),
  );
  const script = path.join(directory, "provider.mjs");
  const executable = path.join(
    directory,
    process.platform === "win32" ? "provider-node.exe" : "provider.mjs",
  );
  try {
    await writeFile(
      script,
      `#!/usr/bin/env node
let input = "";
for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input);
process.stdout.write(JSON.stringify({ tool: request.tool, value: request.arguments.value, leakedEnvironment: process.env.OPENAI_API_KEY ?? null }));
`,
      "utf8",
    );
    if (process.platform === "win32") {
      await copyFile(process.execPath, executable);
    } else {
      await chmod(executable, 0o700);
    }
    await writeFile(
      path.join(directory, "fixture.json"),
      JSON.stringify({
        schemaVersion: 2,
        id: "local-fixture",
        name: "Local fixture",
        version: "1.0.0",
        description: "Local process fixture",
        compatibility: { zenx: ">=0.1.0 <0.2.0" },
        mainDocument: "Run the local fixture through local_fixture_run.",
        provider: {
          id: "fixture-process",
          platforms: [process.platform],
          interactionModes: ["background_safe"],
          capabilities: ["fixture.run"],
        },
        permissions: [
          {
            id: "local-fixture.run",
            title: "Run fixture",
            description: "Run the local fixture",
            scope: "workspace",
          },
        ],
        tools: [
          {
            name: "local_fixture_run",
            description: "Run fixture",
            inputSchema: { type: "object" },
            permissions: ["local-fixture.run"],
            interactionMode: "background_safe",
            capabilities: ["fixture.run"],
          },
        ],
        resources: [],
        contributions: {
          pages: [
            {
              id: "home",
              title: "Local fixture",
              route: "/plugins/local-fixture/home",
            },
          ],
          sidebar: [
            {
              id: "home",
              label: "Local fixture",
              icon: "plug",
              pageId: "home",
            },
          ],
        },
        runtime: {
          type: "process",
          entry:
            process.platform === "win32"
              ? "./provider-node.exe"
              : "./provider.mjs",
          args: process.platform === "win32" ? ["./provider.mjs"] : [],
        },
      }),
      "utf8",
    );
    process.env.OPENAI_API_KEY = "must-not-cross-boundary";
    const discovered = await discoverLocalCapabilityPackages(directory);
    assert.deepEqual(discovered.errors, []);
    assert.equal(discovered.packages.length, 1);
    const registry = new ZenXCapabilityRegistry(
      new JsonZenXCapabilityGrantStore(path.join(directory, "catalog.json")),
      { pluginDataDirectory: path.join(directory, "plugin-data") },
    );
    await registry.initialize();
    await registry.install(discovered.packages[0]!, "local");
    await registry.grant("local-fixture");
    const result = await registry.execute({
      callId: "call-local",
      name: "local_fixture_run",
      arguments: { value: "ok" },
      cwd: "/workspace",
      signal: new AbortController().signal,
    });
    assert.match(result.output, /"value":"ok"/u);
    assert.match(result.output, /"leakedEnvironment":null/u);
    assert.doesNotMatch(result.output, /must-not-cross-boundary/u);

    await registry.setEnabled("local-fixture", false);
    assert.deepEqual(registry.hostSnapshot().definitions, []);
    assert.deepEqual(registry.pluginSnapshot().sidebar, []);
    await registry.setEnabled("local-fixture", true);
    await registry.uninstall("local-fixture");
    assert.deepEqual(registry.hostSnapshot().definitions, []);
    assert.deepEqual(registry.pluginSnapshot().pages, []);
    await registry.reinstall("local-fixture");
    assert.equal(
      registry.hostSnapshot().definitions[0]?.name,
      "local_fixture_run",
    );
  } finally {
    delete process.env.OPENAI_API_KEY;
    await rm(directory, { recursive: true, force: true });
  }
});

test("reports malformed local manifests without hiding other packages", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-local-invalid-"),
  );
  try {
    await writeFile(path.join(directory, "bad.json"), "{}", "utf8");
    await writeFile(
      path.join(directory, "bad-output-bound.json"),
      JSON.stringify({
        schemaVersion: 1,
        id: "bad-output-bound",
        displayName: "Bad output bound",
        version: "1.0.0",
        description: "Invalid local output bound",
        provider: {
          id: "fixture",
          platforms: [process.platform],
          interactionModes: ["background_safe"],
          capabilities: ["fixture.run"],
        },
        permissions: [],
        tools: [
          {
            name: "bad_output_bound",
            description: "Invalid",
            inputSchema: { type: "object" },
            permissions: [],
            interactionMode: "background_safe",
            capabilities: ["fixture.run"],
            maxOutputBytes: -1,
          },
        ],
        resources: [],
        runtime: { type: "process", command: "./missing" },
      }),
      "utf8",
    );
    const discovered = await discoverLocalCapabilityPackages(directory);
    assert.equal(discovered.packages.length, 0);
    assert.equal(discovered.errors.length, 2);
    assert.ok(
      discovered.errors.every((error) =>
        /manifest shape is invalid/u.test(error),
      ),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("selected local package updates v1 to v2 and migrates namespaced storage once", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "zenx-local-update-"));
  const v1Directory = path.join(root, "v1");
  const v2Directory = path.join(root, "v2");
  await mkdir(v1Directory);
  await mkdir(v2Directory);
  const writePackage = async (directory: string, version: string) => {
    const runtime = path.join(directory, "provider.mjs");
    await writeFile(
      runtime,
      `#!/usr/bin/env node
let input=""; for await (const chunk of process.stdin) input+=chunk;
const request=JSON.parse(input);
if(request.tool==="zenx_plugin_storage_migrate") process.stdout.write(JSON.stringify({...request.arguments.value,migratedBy:"${version}"}));
else process.stdout.write(JSON.stringify({version:"${version}"}));
`,
      "utf8",
    );
    await chmod(runtime, 0o700);
    const manifestPath = path.join(directory, "manifest.json");
    await writeFile(
      manifestPath,
      JSON.stringify({
        schemaVersion: 2,
        id: "local-update",
        name: "Local update",
        version,
        description: `Local update ${version}`,
        compatibility: { zenx: ">=0.1.0 <0.2.0" },
        mainDocument: "Use local_update_run.",
        storageVersion: version === "1.0.0" ? 1 : 2,
        provider: {
          id: "local-update-process",
          platforms: [process.platform],
          interactionModes: ["background_safe"],
          capabilities: ["local.update"],
        },
        permissions: [],
        tools: [
          {
            name: "local_update_run",
            description: "Read the installed version",
            inputSchema: { type: "object" },
            permissions: [],
            interactionMode: "background_safe",
            capabilities: ["local.update"],
          },
        ],
        resources: [],
        contributions: {
          pages: [
            {
              id: "home",
              title: `Local update ${version}`,
              route: "/plugins/local-update/home",
            },
          ],
        },
        runtime: { type: "process", entry: "./provider.mjs" },
      }),
      "utf8",
    );
    return manifestPath;
  };
  const v1Manifest = await writePackage(v1Directory, "1.0.0");
  const v2Manifest = await writePackage(v2Directory, "2.0.0");
  const service = new ZenXCapabilityService({
    userDataDirectory: root,
    grantStore: new MemoryZenXCapabilityGrantStore(),
    localDirectory: path.join(root, "none"),
    bundledProvidersOnly: true,
  });
  try {
    await service.initialize();
    await service.installLocalPackage(v1Manifest);
    const storageFile = path.join(
      root,
      "plugin-data",
      "local-update",
      "storage.json",
    );
    await writeFile(
      storageFile,
      JSON.stringify({ version: 1, value: { stable: true } }),
    );
    const snapshot = await service.installLocalPackage(
      v2Manifest,
      "local-update",
    );
    assert.equal(snapshot.plugins[0]?.version, "2.0.0");
    assert.equal(snapshot.pages[0]?.title, "Local update 2.0.0");
    const storage = JSON.parse(await readFile(storageFile, "utf8")) as {
      version: number;
      value: unknown;
    };
    assert.deepEqual(storage, {
      version: 2,
      value: { stable: true, migratedBy: "2.0.0" },
    });
  } finally {
    await service.close();
    await rm(root, { recursive: true, force: true });
  }
});
