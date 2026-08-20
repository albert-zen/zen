import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { app } from "electron";

import {
  selectBrowserProvider,
  selectComputerProvider,
} from "./capabilities/provider-catalog.js";
import { PACKAGED_PROVIDER_MANIFEST_SHA256 } from "./capabilities/packaged-provider-integrity.js";
import { packagedProviderSmokeExitCode } from "./packaged-provider-smoke-exit.js";

const portServer = createServer((_request, response) => {
  response.setHeader("content-type", "text/html; charset=utf-8");
  response.end(
    "<!doctype html><title>ZenX packaged provider</title><button aria-label='Packaged target'>Packaged target</button>",
  );
});

void app.whenReady().then(async () => {
  let failure: unknown;
  try {
    assert.equal(
      app.isPackaged,
      true,
      "packaged smoke must run from a packaged application",
    );
    assert.ok(
      process.resourcesPath.length > 0,
      "packaged smoke must use process.resourcesPath",
    );
    const manifestPath = path.join(
      process.resourcesPath,
      "providers",
      "manifest.json",
    );
    const manifestBytes = await readFile(manifestPath);
    assert.equal(
      await sha256(manifestBytes),
      PACKAGED_PROVIDER_MANIFEST_SHA256,
      "packaged manifest must match the immutable build-time digest",
    );
    const browser = await selectBrowserProvider({
      userDataDirectory: path.join(process.resourcesPath, "smoke-user-data"),
      resourcesDirectory: process.resourcesPath,
      bundledProvidersOnly: true,
      bundledManifestSha256: PACKAGED_PROVIDER_MANIFEST_SHA256,
      platform: process.platform,
    });
    const browserDiagnostic = browser.diagnostics.find(
      (diagnostic) =>
        diagnostic.providerId === "playwright-cli" &&
        diagnostic.status === "selected",
    );
    assert.ok(
      browser.backend,
      `bundled Browser provider unavailable: ${JSON.stringify(browser.diagnostics)}`,
    );
    assert.equal(browserDiagnostic?.version, "0.1.18");
    assert.equal(browserDiagnostic?.integrity, "verified");
    assert.equal(
      browserDiagnostic?.executable?.startsWith(process.resourcesPath),
      true,
    );
    const port = await listen();
    const opened = await browser.backend.open(
      "packaged-smoke",
      `http://127.0.0.1:${String(port)}/`,
    );
    const inspected = await browser.backend.inspect(
      "packaged-smoke",
      opened.tabId,
    );
    assert.equal(
      inspected.targets.some((target) => target.name === "Packaged target"),
      true,
    );
    await browser.backend.close();

    const computer = await selectComputerProvider({
      userDataDirectory: path.join(process.resourcesPath, "smoke-user-data"),
      resourcesDirectory: process.resourcesPath,
      bundledProvidersOnly: true,
      bundledManifestSha256: PACKAGED_PROVIDER_MANIFEST_SHA256,
      platform: process.platform,
    });
    if (process.platform === "win32") {
      const computerDiagnostic = computer.diagnostics.find(
        (diagnostic) =>
          diagnostic.providerId === "microsoft-winapp-cli" &&
          diagnostic.status === "selected",
      );
      assert.ok(
        computer.backend,
        `bundled Computer provider unavailable: ${JSON.stringify(computer.diagnostics)}`,
      );
      assert.equal(computerDiagnostic?.version, "0.3.1");
      assert.equal(computerDiagnostic?.integrity, "verified");
      assert.equal(
        computerDiagnostic?.executable?.startsWith(process.resourcesPath),
        true,
      );
      await computer.backend.close();
    }
    console.log(
      JSON.stringify(
        {
          passed: true,
          packaged: app.isPackaged,
          resourcesPath: process.resourcesPath,
          browser: browserDiagnostic,
          computer: computer.diagnostics,
          bundledOnly: true,
          syntheticFixtures: false,
        },
        null,
        2,
      ),
    );
  } catch (error) {
    failure = error;
    console.error("ZenX packaged provider smoke failed", error);
  } finally {
    try {
      await closeServer();
    } catch (error) {
      failure ??= error;
      console.error("ZenX packaged provider smoke cleanup failed", error);
    }
    app.exit(packagedProviderSmokeExitCode(failure));
  }
});

async function listen(): Promise<number> {
  return await new Promise((resolve, reject) => {
    portServer.once("error", reject);
    portServer.listen(0, "127.0.0.1", () => {
      portServer.removeListener("error", reject);
      const address = portServer.address();
      if (address === null || typeof address === "string") {
        reject(new Error("packaged provider smoke server did not bind"));
        return;
      }
      resolve(address.port);
    });
  });
}

async function closeServer(): Promise<void> {
  if (!portServer.listening) return;
  await new Promise<void>((resolve, reject) =>
    portServer.close((error) =>
      error === undefined ? resolve() : reject(error),
    ),
  );
}

async function sha256(bytes: Buffer): Promise<string> {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(bytes).digest("hex");
}
