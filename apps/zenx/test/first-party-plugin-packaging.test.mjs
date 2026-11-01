import {
  concurrentBrowserManifest,
  multiBrowserManifest,
} from "../src/main/capabilities/browser-backend-registry.js";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { browserModelDocument } from "../../../packages/zenx-browser-plugin/src/model-contract.ts";

import {
  firstPartyPluginStagingPrefix,
  FIRST_PARTY_PLUGINS,
} from "../scripts/pack-first-party-plugins.mjs";
import { firstPartyProviderTarball } from "../src/main/first-party-profile-loader.ts";
import { browserCapabilityManifest } from "../src/main/capabilities/browser-provider.ts";
import { boundComputerCapabilityManifest } from "../src/main/capabilities/computer-provider.ts";
import { windowsStrictUiaCapabilityManifest } from "../src/main/capabilities/windows-strict-uia-provider.ts";
import { windowsComputerCapabilityManifest } from "../src/main/capabilities/windows-computer-provider.ts";
import {
  selectBrowserProviderVariant,
  selectComputerProvider,
} from "../src/main/capabilities/provider-catalog.ts";

const run = promisify(execFile);
const repositoryRoot = path.resolve(import.meta.dirname, "..", "..", "..");
const preparedPluginsDirectory = path.resolve(
  import.meta.dirname,
  "..",
  "resources",
  "plugins",
);

const expected = [
  ["@zenx/board-plugin", "zenx-board-plugin-1.0.0.tgz"],
  ["@zenx/fleet-plugin", "zenx-fleet-plugin-1.0.0.tgz"],
  ["@zenx/subagents-plugin", "zenx-subagents-plugin-1.0.0.tgz"],
  ["@zenx/imzenx-plugin", "zenx-imzenx-plugin-1.0.3.tgz"],
  ["@zenx/browser-plugin", "zenx-browser-plugin-electron-1.2.0.tgz"],
  ["@zenx/browser-plugin", "zenx-browser-plugin-multi-1.2.0.tgz"],
  ["@zenx/browser-plugin", "zenx-browser-plugin-concurrent-1.2.0.tgz"],
  ["@zenx/browser-plugin", "zenx-browser-plugin-playwright-1.2.0.tgz"],
  ["@zenx/browser-plugin", "zenx-browser-plugin-user-session-1.2.0.tgz"],
  ["@zenx/computer-plugin", "zenx-computer-plugin-macos-1.5.0.tgz"],
  ["@zenx/computer-plugin", "zenx-computer-plugin-peekaboo-1.5.0.tgz"],
  ["@zenx/computer-plugin", "zenx-computer-plugin-win32-1.5.0.tgz"],
  ["@zenx/computer-plugin", "zenx-computer-plugin-win32-strict-1.5.0.tgz"],
  ["@zenx/rooms-plugin", "zenx-rooms-plugin-1.0.9.tgz"],
  ["@zenx/self-control-plugin", "zenx-self-control-plugin-1.1.0.tgz"],
  ["@zenx/triggers-plugin", "zenx-triggers-plugin-1.0.2.tgz"],
];

const providerVariants = new Map([
  [
    "zenx-computer-plugin-win32-strict-1.5.0.tgz",
    ["computer", "1.5.0", "zenx-winapp-uia", 6],
  ],
  [
    "zenx-browser-plugin-multi-1.2.0.tgz",
    ["browser", "1.2.0", "multi-browser", 43],
  ],
  [
    "zenx-browser-plugin-concurrent-1.2.0.tgz",
    ["browser", "1.2.0", "concurrent-browser", 42],
  ],
  [
    "zenx-browser-plugin-electron-1.2.0.tgz",
    ["browser", "1.2.0", "electron-dedicated-browser", 21],
  ],
  [
    "zenx-browser-plugin-playwright-1.2.0.tgz",
    ["browser", "1.2.0", "playwright-cli", 12],
  ],
  [
    "zenx-browser-plugin-user-session-1.2.0.tgz",
    ["browser", "1.2.0", "user-browser-cdp", 21],
  ],
  [
    "zenx-computer-plugin-macos-1.5.0.tgz",
    ["computer", "1.5.0", "macos-desktop", 17],
  ],
  [
    "zenx-computer-plugin-peekaboo-1.5.0.tgz",
    ["computer", "1.5.0", "peekaboo-cli", 8],
  ],
  [
    "zenx-computer-plugin-win32-1.5.0.tgz",
    ["computer", "1.5.0", "microsoft-winapp-cli", 6],
  ],
]);

test("all packaged Browser and Computer manifests match their runtime observation contracts", async (t) => {
  assert.match(browserModelDocument, /Discard.*prior continuation pages/u);
  const options = {
    userDataDirectory: path.join(os.tmpdir(), "zenx-manifest-parity"),
    environment: { PATH: "" },
    platform: "darwin",
    electronBrowserFactory: () => ({ close() {} }),
  };
  const playwright = await selectBrowserProviderVariant(
    "playwright-cli",
    options,
  );
  const userSession = await selectBrowserProviderVariant(
    "user-browser-cdp",
    options,
  );
  const peekaboo = await selectComputerProvider({
    ...options,
    environment: { PATH: "", ZENX_PEEKABOO_CLI: process.execPath },
    runner: {
      async run(_executable, args) {
        if (args[0] === "--version")
          return { stdout: "Peekaboo 3.1.2", stderr: "" };
        const data =
          args[0] === "tools"
            ? {
                tools: ["see", "click", "set_value", "image"].map((name) => ({
                  name,
                  description: name,
                })),
              }
            : { permissions: [] };
        return { stdout: JSON.stringify({ success: true, data }), stderr: "" };
      },
    },
  });
  for (const selection of [playwright, userSession, peekaboo]) {
    t.after(() => selection.backend?.close());
  }
  assert.equal(peekaboo.manifest.provider.id, "peekaboo-cli");
  for (const [relative, runtime] of [
    [
      "zenx-computer-plugin/variants/win32-strict.zenx.plugin.json",
      windowsStrictUiaCapabilityManifest,
    ],
    ["zenx-browser-plugin/zenx.plugin.json", browserCapabilityManifest],
    [
      "zenx-browser-plugin/variants/multi.zenx.plugin.json",
      multiBrowserManifest(),
    ],
    [
      "zenx-browser-plugin/variants/concurrent.zenx.plugin.json",
      concurrentBrowserManifest(),
    ],
    [
      "zenx-browser-plugin/variants/playwright.zenx.plugin.json",
      playwright.manifest,
    ],
    [
      "zenx-browser-plugin/variants/user-session.zenx.plugin.json",
      userSession.manifest,
    ],
    ["zenx-computer-plugin/zenx.plugin.json", boundComputerCapabilityManifest],
    [
      "zenx-computer-plugin/variants/peekaboo.zenx.plugin.json",
      peekaboo.manifest,
    ],
    [
      "zenx-computer-plugin/variants/win32.zenx.plugin.json",
      windowsComputerCapabilityManifest,
    ],
  ]) {
    const manifest = JSON.parse(
      await readFile(path.join(repositoryRoot, "packages", relative), "utf8"),
    );
    assert.equal(
      manifest.runtime.entry,
      "./dist/runtime.js",
      "package entry must remain a real bundled file, not the Host's virtual entry",
    );
    for (const field of [
      "version",
      "description",
      "mainDocument",
      "provider",
      "permissions",
      "tools",
    ]) {
      assert.deepEqual(
        manifest[field],
        JSON.parse(JSON.stringify(runtime[field])),
        `${relative}: ${field}`,
      );
    }
    const inspect = manifest.tools.find(({ name }) =>
      name.endsWith("_inspect"),
    );
    assert.equal(inspect.maxOutputBytes, 128 * 1024);
    assert.ok(inspect.inputSchema.properties.cursor);
    assert.ok(inspect.inputSchema.properties.baseObservationId);
    assert.ok(inspect.inputSchema.properties.full);
    assert.match(manifest.mainDocument, /Discard.*prior continuation pages/u);
  }
});

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

test("all prepared first-party plugins are self-contained ordinary npm tarballs", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-first-party-packaging-"),
  );
  try {
    // npm test/check has just run the real packer for every variant. Inspect
    // those same artifacts instead of rebuilding and packing all packages twice.
    // The clean-source test below still covers standalone packer preparation.
    await cp(preparedPluginsDirectory, path.join(directory, "plugins"), {
      recursive: true,
    }).catch((cause) => {
      throw new Error(
        "First-party test artifacts are missing; run npm run prepare:first-party-plugins --workspace @zen/zenx",
        { cause },
      );
    });
    const packed = FIRST_PARTY_PLUGINS;
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
      if (packageName === "@zenx/imzenx-plugin") {
        assert(files.includes("python/src/imzen/zenx.py"));
        assert(files.includes("python/uv.lock"));
        assert(
          !files.some(
            (file) => file.includes(".venv") || file.includes("__pycache__"),
          ),
        );
      } else if (packageName === "@zenx/board-plugin") {
        assert.deepEqual(files, [
          "README.md",
          "dist/board.d.ts",
          "dist/board.js",
          "dist/manifest.d.ts",
          "dist/manifest.js",
          "dist/runtime.d.ts",
          "dist/runtime.js",
          "package.json",
          "zenx.plugin.json",
        ]);
        const manifest = JSON.parse(
          (
            await run("tar", [
              "-xOf",
              path.join(directory, "plugins", filename),
              "package/zenx.plugin.json",
            ])
          ).stdout,
        );
        assert.equal(manifest.id, "zenx-board");
        assert.equal(manifest.runtime.entry, "./dist/runtime.js");
        assert.deepEqual(manifest.contributions.information, [
          { id: "board", title: "Board", surfaceId: "board" },
        ]);
        assert.deepEqual(
          manifest.tools.map((tool) => tool.name),
          ["zenx_board_put", "zenx_board_read", "zenx_board_ui"],
        );
        assert.equal(
          manifest.contributions.panels,
          undefined,
          "Board is not a resource-tab panel",
        );
      } else if (packageName === "@zenx/browser-plugin")
        assert.deepEqual(files, [
          "README.md",
          "dist/model-contract.d.ts",
          "dist/model-contract.js",
          "dist/model-observation.d.ts",
          "dist/model-observation.js",
          "dist/runtime.d.ts",
          "dist/runtime.js",
          "dist/version.d.ts",
          "dist/version.js",
          "package.json",
          "zenx.plugin.json",
        ]);
      else if (packageName === "@zenx/computer-plugin")
        assert.deepEqual(files, [
          "README.md",
          "dist/model-contract.d.ts",
          "dist/model-contract.js",
          "dist/object-contract.d.ts",
          "dist/object-contract.js",
          "dist/runtime.d.ts",
          "dist/runtime.js",
          "dist/version.d.ts",
          "dist/version.js",
          "package.json",
          "zenx.plugin.json",
        ]);
      else
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
        assert.equal(manifest.runtime.entry, "./dist/runtime.js");
        assert(
          files.includes(manifest.runtime.entry.replace(/^\.\//u, "")),
          "tarball must contain its exact runtime entry",
        );
        if (filename.includes("computer-plugin")) {
          assert.equal(
            manifest.tools.some(
              ({ name }) => name === "computer_background_type",
            ),
            filename.includes("-macos-"),
          );
          assert.equal(
            manifest.permissions.some(
              ({ id }) => id === "computer.app.background_keyboard",
            ),
            filename.includes("-macos-"),
          );
          assert.equal(
            manifest.tools.some(({ name }) => name === "computer_list_windows"),
            !filename.includes("peekaboo"),
          );
        }
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

    assert.equal(path.basename(tarball), "zenx-rooms-plugin-1.0.9.tgz");
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("Host provider selection maps every real manifest variant deterministically", () => {
  assert.deepEqual(
    [
      firstPartyProviderTarball("browser", "electron-dedicated-browser"),
      firstPartyProviderTarball("browser", "concurrent-browser"),
      firstPartyProviderTarball("browser", "multi-browser"),
      firstPartyProviderTarball("browser", "playwright-cli"),
      firstPartyProviderTarball("browser", "user-browser-cdp"),
      firstPartyProviderTarball("computer", "macos-desktop"),
      firstPartyProviderTarball("computer", "peekaboo-cli"),
      firstPartyProviderTarball("computer", "microsoft-winapp-cli"),
    ],
    [
      "zenx-browser-plugin-electron-1.2.0.tgz",
      "zenx-browser-plugin-concurrent-1.2.0.tgz",
      "zenx-browser-plugin-multi-1.2.0.tgz",
      "zenx-browser-plugin-playwright-1.2.0.tgz",
      "zenx-browser-plugin-user-session-1.2.0.tgz",
      "zenx-computer-plugin-macos-1.5.0.tgz",
      "zenx-computer-plugin-peekaboo-1.5.0.tgz",
      "zenx-computer-plugin-win32-1.5.0.tgz",
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
