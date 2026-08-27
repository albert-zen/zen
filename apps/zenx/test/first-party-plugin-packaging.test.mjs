import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

import {
  firstPartyPluginStagingPrefix,
  packZenXFirstPartyPlugins,
} from "../scripts/pack-first-party-plugins.mjs";
import { firstPartyProviderTarball } from "../src/main/first-party-profile-loader.ts";

const run = promisify(execFile);
const repositoryRoot = path.resolve(import.meta.dirname, "..", "..", "..");

const expected = [
  ["@zenx/browser-plugin", "zenx-browser-plugin-electron-1.0.0.tgz"],
  ["@zenx/browser-plugin", "zenx-browser-plugin-playwright-1.0.0.tgz"],
  ["@zenx/browser-plugin", "zenx-browser-plugin-user-session-1.0.0.tgz"],
  ["@zenx/computer-plugin", "zenx-computer-plugin-macos-1.0.0.tgz"],
  ["@zenx/computer-plugin", "zenx-computer-plugin-peekaboo-1.0.0.tgz"],
  ["@zenx/computer-plugin", "zenx-computer-plugin-win32-1.1.0.tgz"],
  ["@zenx/rooms-plugin", "zenx-rooms-plugin-1.0.0.tgz"],
  ["@zenx/self-control-plugin", "zenx-self-control-plugin-1.0.0.tgz"],
  ["@zenx/triggers-plugin", "zenx-triggers-plugin-1.0.0.tgz"],
];

const providerVariants = new Map([
  [
    "zenx-browser-plugin-electron-1.0.0.tgz",
    ["browser", "1.0.0", "electron-dedicated-browser", 8],
  ],
  [
    "zenx-browser-plugin-playwright-1.0.0.tgz",
    ["browser", "1.0.0", "playwright-cli", 8],
  ],
  [
    "zenx-browser-plugin-user-session-1.0.0.tgz",
    ["browser", "1.0.0", "user-browser-cdp", 8],
  ],
  [
    "zenx-computer-plugin-macos-1.0.0.tgz",
    ["computer", "1.0.0", "macos-desktop", 7],
  ],
  [
    "zenx-computer-plugin-peekaboo-1.0.0.tgz",
    ["computer", "1.0.0", "peekaboo-cli", 7],
  ],
  [
    "zenx-computer-plugin-win32-1.1.0.tgz",
    ["computer", "1.1.0", "microsoft-winapp-cli", 4],
  ],
]);

test("first-party plugin staging shares the destination volume", () => {
  const pluginsDirectory = path.join(
    os.tmpdir(),
    "destination-volume",
    "plugins",
  );

  assert.equal(
    path.dirname(firstPartyPluginStagingPrefix(pluginsDirectory)),
    pluginsDirectory,
  );
});

test("all first-party plugins validate and pack as self-contained ordinary npm tarballs", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-first-party-packaging-"),
  );
  try {
    const packed = await packZenXFirstPartyPlugins({
      outputDirectory: directory,
    });
    assert.deepEqual(
      packed.map(({ packageName, tarball }) => [
        packageName,
        path.basename(tarball),
      ]),
      expected,
    );
    for (const [packageName, filename] of expected) {
      const listed = JSON.parse(
        (
          await run(
            "npm",
            [
              "pack",
              "--dry-run",
              "--json",
              path.join(directory, "plugins", filename),
            ],
            {
              maxBuffer: 1024 * 1024,
            },
          )
        ).stdout,
      );
      const files = listed[0]?.files?.map((entry) => entry.path).sort();
      assert.equal(listed[0]?.name, packageName);
      assert.deepEqual(files, [
        "README.md",
        "dist/runtime.js",
        "package.json",
        "zenx.plugin.json",
      ]);
      const expectedVariant = providerVariants.get(filename);
      if (expectedVariant !== undefined) {
        const manifest = JSON.parse(
          (
            await run("tar", [
              "-xOf",
              path.join(directory, "plugins", filename),
              "package/zenx.plugin.json",
            ])
          ).stdout,
        );
        assert.deepEqual(
          [
            manifest.id,
            manifest.version,
            manifest.provider?.id,
            manifest.tools?.length,
          ],
          expectedVariant,
        );
        assert.equal(
          manifest.tools.some(({ name }) =>
            name.startsWith("computer_foreground_"),
          ),
          filename.includes("computer-plugin") && !filename.includes("win32"),
        );
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("direct packaging establishes the plugin SDK clean-output prerequisite", async () => {
  const fixture = await mkdtemp(
    path.join(os.tmpdir(), "zenx-clean-plugin-packaging-"),
  );
  try {
    await Promise.all([
      cp(
        path.join(repositoryRoot, "packages", "zenx-plugin-sdk"),
        path.join(fixture, "packages", "zenx-plugin-sdk"),
        { recursive: true, filter: cleanSourceFilter },
      ),
      cp(
        path.join(repositoryRoot, "packages", "zenx-rooms-plugin"),
        path.join(fixture, "packages", "zenx-rooms-plugin"),
        { recursive: true, filter: cleanSourceFilter },
      ),
      cp(
        path.join(repositoryRoot, "apps", "zenx", "scripts"),
        path.join(fixture, "apps", "zenx", "scripts"),
        { recursive: true },
      ),
      cp(
        path.join(repositoryRoot, "package.json"),
        path.join(fixture, "package.json"),
      ),
      cp(
        path.join(repositoryRoot, "tsconfig.json"),
        path.join(fixture, "tsconfig.json"),
      ),
    ]);
    await installFixtureDependencies(fixture);
    const { packZenXRoomsPlugin } = await import(
      `${pathToFileURL(path.join(fixture, "apps", "zenx", "scripts", "pack-first-party-plugins.mjs")).href}?clean=${Date.now()}`
    );
    const output = path.join(fixture, "output");

    const tarball = await packZenXRoomsPlugin({ outputDirectory: output });

    assert.equal(path.basename(tarball), "zenx-rooms-plugin-1.0.0.tgz");
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("Host provider selection maps every real manifest variant deterministically", () => {
  assert.deepEqual(
    [
      firstPartyProviderTarball("browser", "electron-dedicated-browser"),
      firstPartyProviderTarball("browser", "playwright-cli"),
      firstPartyProviderTarball("browser", "user-browser-cdp"),
      firstPartyProviderTarball("computer", "macos-desktop"),
      firstPartyProviderTarball("computer", "peekaboo-cli"),
      firstPartyProviderTarball("computer", "microsoft-winapp-cli"),
    ],
    [
      "zenx-browser-plugin-electron-1.0.0.tgz",
      "zenx-browser-plugin-playwright-1.0.0.tgz",
      "zenx-browser-plugin-user-session-1.0.0.tgz",
      "zenx-computer-plugin-macos-1.0.0.tgz",
      "zenx-computer-plugin-peekaboo-1.0.0.tgz",
      "zenx-computer-plugin-win32-1.1.0.tgz",
    ],
  );
  assert.throws(
    () => firstPartyProviderTarball("browser", "near-playwright-cli"),
    /No provider variant/u,
  );
  assert.throws(
    () => firstPartyProviderTarball("computer", "near-peekaboo-cli"),
    /No provider variant/u,
  );
});

function cleanSourceFilter(source) {
  return !["dist", "node_modules"].includes(path.basename(source));
}

async function installFixtureDependencies(fixture) {
  const fixtureModules = path.join(fixture, "node_modules");
  await Promise.all([
    mkdir(path.join(fixtureModules, "@types"), { recursive: true }),
    mkdir(path.join(fixtureModules, "@zenx"), { recursive: true }),
    cp(
      path.join(repositoryRoot, "node_modules", ".bin"),
      path.join(fixtureModules, ".bin"),
      { recursive: true },
    ),
  ]);
  const linkType = process.platform === "win32" ? "junction" : "dir";
  await Promise.all([
    symlink(
      path.join(repositoryRoot, "node_modules", "typescript"),
      path.join(fixtureModules, "typescript"),
      linkType,
    ),
    symlink(
      path.join(repositoryRoot, "node_modules", "@types", "node"),
      path.join(fixtureModules, "@types", "node"),
      linkType,
    ),
    symlink(
      path.join(fixture, "packages", "zenx-plugin-sdk"),
      path.join(fixtureModules, "@zenx", "plugin-sdk"),
      linkType,
    ),
  ]);
}
