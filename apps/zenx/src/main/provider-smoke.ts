import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { app } from "electron";

import {
  selectBrowserProvider,
  selectComputerProvider,
} from "./capabilities/provider-catalog.js";

const web = createServer((_request, response) => {
  response.setHeader("content-type", "text/html; charset=utf-8");
  response.end(
    "<!doctype html><title>Provider smoke</title><main><button onclick=\"this.textContent='Clicked target'\">Smoke target</button></main>",
  );
});

void app.whenReady().then(async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-provider-smoke-"),
  );
  try {
    const port = await listen();
    const browser = await selectBrowserProvider({
      userDataDirectory: directory,
    });
    const selectedBrowser = browser.diagnostics.find(
      (diagnostic) => diagnostic.status === "selected",
    );
    assert.ok(
      browser.backend,
      `Browser provider is unavailable: ${JSON.stringify(browser.diagnostics)}`,
    );
    if (process.env.ZENX_REQUIRE_PLAYWRIGHT === "1") {
      assert.equal(
        selectedBrowser?.providerId,
        "playwright-cli",
        `Expected Playwright provider, got ${JSON.stringify(browser.diagnostics)}`,
      );
    }
    const opened = await browser.backend.open(
      "provider-smoke",
      `http://127.0.0.1:${String(port)}/`,
    );
    const inspection = await browser.backend.inspect(
      "provider-smoke",
      opened.tabId,
    );
    assert.match(inspection.visibleText, /Smoke target/u);
    const target = inspection.targets.find(
      (candidate) =>
        candidate.name === "Smoke target" &&
        candidate.actions.includes("click"),
    );
    assert.ok(target, "Expected an inspectable click target");
    await browser.backend.click(
      "provider-smoke",
      opened.tabId,
      inspection.observationId,
      target.targetId,
    );
    const verified = await browser.backend.inspect(
      "provider-smoke",
      opened.tabId,
    );
    assert.match(verified.visibleText, /Clicked target/u);
    await browser.backend.closeSession("provider-smoke");
    await browser.backend.close();

    const computer = await selectComputerProvider({
      userDataDirectory: directory,
    });
    await computer.backend?.close();
    console.log(
      JSON.stringify(
        {
          passed: true,
          browser: browser.diagnostics,
          computer: computer.diagnostics,
          note: "Computer discovery/permission probe only; this smoke never sends desktop input.",
        },
        null,
        2,
      ),
    );
  } catch (error) {
    console.error("ZenX provider smoke failed", error);
    process.exitCode = 1;
  } finally {
    await closeWeb();
    await rm(directory, { recursive: true, force: true });
    app.quit();
  }
});

async function listen(): Promise<number> {
  return await new Promise((resolve, reject) => {
    web.once("error", reject);
    web.listen(0, "127.0.0.1", () => {
      web.removeListener("error", reject);
      const address = web.address();
      if (address === null || typeof address === "string") {
        reject(new Error("Provider smoke server did not bind a TCP port"));
        return;
      }
      resolve(address.port);
    });
  });
}

async function closeWeb(): Promise<void> {
  if (!web.listening) return;
  await new Promise<void>((resolve, reject) =>
    web.close((error) => (error === undefined ? resolve() : reject(error))),
  );
}
