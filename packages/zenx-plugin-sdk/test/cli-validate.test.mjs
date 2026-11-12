import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const cli = path.resolve(import.meta.dirname, "..", "dist", "cli.js");

test("validate rejects UI contributions that target missing pages, commands, or surfaces", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "zenx-invalid-ui-"));
  const target = path.join(root, "ui-plugin");
  try {
    create(target, "ui-plugin");
    const manifestPath = path.join(target, "zenx.plugin.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.contributions = {
      subroutes: [
        {
          id: "details",
          title: "Details",
          route: "/plugins/ui-plugin/home/details",
          pageId: "missing",
          surfaceId: "missing",
        },
      ],
      menus: [
        {
          id: "run",
          label: "Run",
          commandId: "missing",
          location: "page",
        },
      ],
    };
    await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`, "utf8");

    const result = validate(target);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /invalid or dangling subroute/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("validate rejects invalid sidebar and result-renderer metadata", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "zenx-invalid-ui-metadata-"),
  );
  const target = path.join(root, "ui-metadata-plugin");
  try {
    create(target, "ui-metadata-plugin");
    const manifestPath = path.join(target, "zenx.plugin.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.contributions = {
      pages: [
        {
          id: "home",
          title: "Home",
          route: "/plugins/ui-metadata-plugin/home",
        },
      ],
      sidebar: [
        {
          id: "home",
          label: "Home",
          icon: "unknown-icon",
          pageId: "home",
        },
      ],
    };
    await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`, "utf8");

    const result = validate(target);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /invalid sidebar contribution/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("validate rejects malformed metadata, incompatible manifests, and unsafe package paths", async (t) => {
  const cases = [
    {
      name: "malformed package.json#zenx.plugin",
      mutate(packageJson) {
        packageJson.zenx.plugin = { path: "./zenx.plugin.json" };
      },
      pattern: /package\.json#zenx\.plugin must be a non-empty string/u,
    },
    {
      name: "manifest and package version mismatch",
      mutate(_packageJson, manifest) {
        manifest.version = "9.0.0";
      },
      pattern: /does not match package version/u,
    },
    {
      name: "escaping manifest path",
      mutate(packageJson) {
        packageJson.zenx.plugin = "../outside.json";
      },
      pattern: /manifest escapes the package directory/u,
    },
    {
      name: "missing runtime entry",
      mutate(_packageJson, manifest) {
        manifest.runtime.entry = "./missing.mjs";
      },
      pattern: /runtime entry does not exist/u,
    },
    {
      name: "invalid runtime descriptor",
      mutate(_packageJson, manifest) {
        manifest.runtime = { type: "worker", entry: "./runtime.mjs" };
      },
      pattern: /invalid runtime type/u,
    },
    {
      name: "invalid tool schema",
      mutate(_packageJson, manifest) {
        manifest.tools[0].inputSchema = [];
      },
      pattern: /invalid input schema/u,
    },
    {
      name: "invalid tool output bound",
      mutate(_packageJson, manifest) {
        manifest.tools[0].maxOutputBytes = 10;
      },
      pattern: /maxOutputBytes must be an integer between 1024 and 1048576/u,
    },
    {
      name: "missing main document",
      mutate(_packageJson, manifest) {
        manifest.mainDocument = " ";
      },
      pattern: /mainDocument must be a non-empty string/u,
    },
  ];
  for (const fixture of cases) {
    await t.test(fixture.name, async () => {
      const root = await mkdtemp(
        path.join(os.tmpdir(), "zenx-invalid-package-"),
      );
      const target = path.join(root, "fixture-plugin");
      try {
        create(target, "fixture-plugin");
        const packageJsonPath = path.join(target, "package.json");
        const manifestPath = path.join(target, "zenx.plugin.json");
        const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
        const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
        fixture.mutate(packageJson, manifest);
        await Promise.all([
          writeFile(
            packageJsonPath,
            `${JSON.stringify(packageJson)}\n`,
            "utf8",
          ),
          writeFile(manifestPath, `${JSON.stringify(manifest)}\n`, "utf8"),
        ]);
        const result = validate(target);
        assert.equal(result.status, 1);
        assert.match(result.stderr, fixture.pattern);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});

function create(target, id) {
  const result = spawnSync(
    process.execPath,
    [cli, "create", target, "--name", id, "--id", id],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
}

function validate(target) {
  return spawnSync(process.execPath, [cli, "validate", target], {
    encoding: "utf8",
  });
}
