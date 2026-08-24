import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { packZenXFirstPartyPlugins } from "../scripts/pack-first-party-plugins.mjs";
import { firstPartyProviderTarball } from "../src/main/first-party-profile-loader.ts";

const run = promisify(execFile);

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
