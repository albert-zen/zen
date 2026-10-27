/** Keep packaged contracts equal to the selected native provider definition. No runtime is started. */
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { browserCapabilityManifest } from "../src/main/capabilities/browser-provider.js";
import {
  concurrentBrowserManifest,
  multiBrowserManifest,
} from "../src/main/capabilities/browser-backend-registry.js";
import { boundComputerCapabilityManifest } from "../src/main/capabilities/computer-provider.js";
import { windowsComputerCapabilityManifest } from "../src/main/capabilities/windows-computer-provider.js";
import { windowsStrictUiaCapabilityManifest } from "../src/main/capabilities/windows-strict-uia-provider.js";
import {
  userBrowserManifest,
  playwrightBrowserManifest,
  peekabooComputerManifest,
} from "../src/main/capabilities/provider-catalog.js";
import type { ZenXPluginManifestV2 } from "../src/main/capabilities/types.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const entries: Array<[string, ZenXPluginManifestV2]> = [
  ["zenx-browser-plugin/zenx.plugin.json", browserCapabilityManifest],
  [
    "zenx-browser-plugin/variants/concurrent.zenx.plugin.json",
    concurrentBrowserManifest(),
  ],
  [
    "zenx-browser-plugin/variants/multi.zenx.plugin.json",
    multiBrowserManifest(),
  ],
  [
    "zenx-browser-plugin/variants/playwright.zenx.plugin.json",
    playwrightBrowserManifest(),
  ],
  [
    "zenx-browser-plugin/variants/user-session.zenx.plugin.json",
    userBrowserManifest(),
  ],
  ["zenx-computer-plugin/zenx.plugin.json", boundComputerCapabilityManifest],
  [
    "zenx-computer-plugin/variants/win32.zenx.plugin.json",
    windowsComputerCapabilityManifest,
  ],
  [
    "zenx-computer-plugin/variants/win32-strict.zenx.plugin.json",
    windowsStrictUiaCapabilityManifest,
  ],
  [
    "zenx-computer-plugin/variants/peekaboo.zenx.plugin.json",
    peekabooComputerManifest(),
  ],
];
for (const [relative, source] of entries) {
  const file = resolve(root, "packages", relative);
  const manifest = JSON.parse(await readFile(file, "utf8"));
  for (const field of [
    "version",
    "description",
    "mainDocument",
    "provider",
    "permissions",
    "tools",
  ] as const)
    manifest[field] = source[field];
  await writeFile(file, JSON.stringify(manifest, null, 2) + "\n");
}
for (const [name, version] of [
  ["zenx-browser-plugin", browserCapabilityManifest.version],
  ["zenx-computer-plugin", boundComputerCapabilityManifest.version],
]) {
  const file = resolve(root, "packages", name!, "package.json");
  const pkg = JSON.parse(await readFile(file, "utf8"));
  pkg.version = version;
  pkg.files = ["dist/", "zenx.plugin.json", "README.md"];
  await writeFile(file, JSON.stringify(pkg, null, 2) + "\n");
}
for (const relative of [
  "apps/zenx/src/main/first-party-profile-loader.ts",
  "apps/zenx/scripts/pack-first-party-plugins.mjs",
  "apps/zenx/test/concurrent-browser-profile.test.ts",
  "apps/zenx/test/first-party-plugin-packaging.test.mjs",
]) {
  const file = resolve(root, relative);
  const text = (await readFile(file, "utf8"))
    .replace(
      /(zenx-browser-plugin-[a-z0-9-]+-)\d+\.\d+\.\d+(\.tgz)/gu,
      `$1${browserCapabilityManifest.version}$2`,
    )
    .replace(
      /(zenx-computer-plugin-[a-z0-9-]+-)\d+\.\d+\.\d+(\.tgz)/gu,
      `$1${boundComputerCapabilityManifest.version}$2`,
    );
  await writeFile(file, text);
}
const lockPath = resolve(root, "package-lock.json");
const lock = JSON.parse(await readFile(lockPath, "utf8"));
lock.packages["packages/zenx-browser-plugin"].version =
  browserCapabilityManifest.version;
lock.packages["packages/zenx-computer-plugin"].version =
  boundComputerCapabilityManifest.version;
await writeFile(lockPath, JSON.stringify(lock, null, 2) + "\n");
