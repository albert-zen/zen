import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  selectBrowserProvider,
  selectComputerProvider,
} from "./capabilities/provider-catalog.js";
import type { ExternalProviderProcessRunner } from "./capabilities/external-provider.js";
import type {
  WinAppCliRunOptions,
  WinAppCliRunner,
} from "./capabilities/windows-computer-provider.js";

const providerBytes = Buffer.from(
  "ZenX packaged provider smoke asset\n",
  "utf8",
);

class SmokeExternalRunner implements ExternalProviderProcessRunner {
  async run(
    _executable: string,
    args: readonly string[],
    _options: {
      timeoutMs: number;
      signal?: AbortSignal;
      maxOutputBytes?: number;
      verifyBeforeSpawn?: () => Promise<void>;
    },
  ): Promise<{ stdout: string; stderr: string }> {
    if (args.includes("--version")) {
      return { stdout: JSON.stringify({ version: "0.1.2" }), stderr: "" };
    }
    if (args.includes("list")) {
      return { stdout: JSON.stringify({ browsers: [] }), stderr: "" };
    }
    return { stdout: JSON.stringify({}), stderr: "" };
  }
}

class SmokeWinAppRunner implements WinAppCliRunner {
  async run(
    _executable: string,
    args: readonly string[],
    _options: WinAppCliRunOptions,
  ): Promise<{ stdout: string; stderr: string }> {
    if (args.includes("--version")) return { stdout: "0.3.1\n", stderr: "" };
    if (args.includes("--cli-schema")) {
      return {
        stdout: JSON.stringify({
          schemaVersion: "1.0",
          version: "0.3.1",
          subcommands: {
            ui: {
              subcommands: {
                inspect: {},
                invoke: {},
                "list-windows": {},
                screenshot: {},
                "set-value": {},
                "wait-for": {},
              },
            },
          },
        }),
        stderr: "",
      };
    }
    return { stdout: "[]", stderr: "" };
  }
}

const root = await mkdtemp(
  path.join(os.tmpdir(), "zenx-packaged-provider-smoke-"),
);
try {
  const providers = path.join(root, "providers");
  await mkdir(providers, { recursive: true });
  const playwrightAsset = path.join(providers, "playwright-cli.exe");
  const winAppAsset = path.join(providers, "winapp.exe");
  await writeFile(playwrightAsset, providerBytes);
  await writeFile(winAppAsset, providerBytes);
  const assetSha256 = createHash("sha256").update(providerBytes).digest("hex");
  const manifest = JSON.stringify({
    schemaVersion: 1,
    providers: {
      "playwright-cli": {
        executable: "playwright-cli.exe",
        version: "0.1.2",
        sha256: assetSha256,
        platforms: ["win32"],
      },
      "microsoft-winapp-cli": {
        executable: "winapp.exe",
        version: "0.3.1",
        sha256: assetSha256,
        platforms: ["win32"],
      },
    },
  });
  await writeFile(path.join(providers, "manifest.json"), manifest);
  const manifestSha256 = createHash("sha256").update(manifest).digest("hex");
  const browser = await selectBrowserProvider({
    userDataDirectory: root,
    resourcesDirectory: root,
    bundledProvidersOnly: true,
    bundledManifestSha256: manifestSha256,
    platform: "win32",
    runner: new SmokeExternalRunner(),
  });
  assert.equal(browser.diagnostics[0]?.status, "selected");
  assert.equal(browser.diagnostics[0]?.version, "0.1.2");
  assert.equal(browser.diagnostics[0]?.integrity, "verified");
  await browser.backend?.close();

  const computer = await selectComputerProvider({
    userDataDirectory: root,
    resourcesDirectory: root,
    bundledProvidersOnly: true,
    bundledManifestSha256: manifestSha256,
    platform: "win32",
    winAppRunner: new SmokeWinAppRunner(),
  });
  assert.equal(computer.diagnostics[0]?.status, "selected");
  assert.equal(computer.diagnostics[0]?.version, "0.3.1");
  assert.equal(computer.diagnostics[0]?.integrity, "verified");
  await computer.backend?.close();
} finally {
  await rm(root, { recursive: true, force: true });
}
