import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { discoverLocalCapabilityPackages } from "../src/main/capabilities/local-package.js";
import { MemoryZenXCapabilityGrantStore } from "../src/main/capabilities/grant-store.js";
import { ZenXCapabilityRegistry } from "../src/main/capabilities/registry.js";

test("discovers and executes a local process package with a minimal JSON contract", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-local-capability-"),
  );
  const executable = path.join(directory, "provider.mjs");
  try {
    await writeFile(
      executable,
      `#!/usr/bin/env node
let input = "";
for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input);
process.stdout.write(JSON.stringify({ tool: request.tool, value: request.arguments.value, leakedEnvironment: process.env.OPENAI_API_KEY ?? null }));
`,
      "utf8",
    );
    await chmod(executable, 0o700);
    await writeFile(
      path.join(directory, "fixture.json"),
      JSON.stringify({
        schemaVersion: 1,
        id: "local-fixture",
        displayName: "Local fixture",
        version: "1.0.0",
        description: "Local process fixture",
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
        runtime: { type: "process", command: "./provider.mjs" },
      }),
      "utf8",
    );
    process.env.OPENAI_API_KEY = "must-not-cross-boundary";
    const discovered = await discoverLocalCapabilityPackages(directory);
    assert.deepEqual(discovered.errors, []);
    assert.equal(discovered.packages.length, 1);
    const registry = new ZenXCapabilityRegistry(
      new MemoryZenXCapabilityGrantStore(),
    );
    await registry.initialize();
    registry.register(discovered.packages[0]!, "local");
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
