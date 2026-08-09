import assert from "node:assert/strict";
import { createServer } from "node:http";

import { app } from "electron";

import {
  BrowserZenXCapabilityPackage,
  ElectronBrowserBackend,
  type BrowserInspection,
} from "./capabilities/browser-provider.js";
import {
  ComputerZenXCapabilityPackage,
  ElectronMacComputerBackend,
} from "./capabilities/computer-provider.js";
import { MemoryZenXCapabilityGrantStore } from "./capabilities/grant-store.js";
import { ZenXCapabilityRegistry } from "./capabilities/registry.js";

const web = createServer((request, response) => {
  response.setHeader("content-type", "text/html; charset=utf-8");
  if (request.url === "/next") {
    response.end(
      "<!doctype html><title>Next</title><main>Navigation complete</main>",
    );
    return;
  }
  response.end(`<!doctype html>
    <title>ZenX capability smoke</title>
    <input id="name" aria-label="Name">
    <button id="mark" onclick="document.querySelector('output').textContent = 'Marked ' + document.querySelector('#name').value">Mark</button>
    <output></output>
    <a id="next" href="/next">Next</a>`);
});

void app.whenReady().then(async () => {
  const registry = new ZenXCapabilityRegistry(
    new MemoryZenXCapabilityGrantStore(),
  );
  try {
    const port = await listen();
    await registry.initialize();
    registry.register(
      new BrowserZenXCapabilityPackage(new ElectronBrowserBackend()),
    );
    registry.register(
      new ComputerZenXCapabilityPackage(new ElectronMacComputerBackend()),
    );
    await registry.grant("browser");
    await registry.grant("computer");

    const opened = await invoke(registry, "browser_open", {
      sessionId: "desktop-smoke",
      url: `http://127.0.0.1:${String(port)}/`,
    });
    const tabId = requiredResultString(opened, "tabId");
    let inspected = (await invoke(registry, "browser_inspect", {
      sessionId: "desktop-smoke",
      tabId,
    })) as BrowserInspection;
    assert.match(inspected.visibleText, /Mark/u);
    await invoke(registry, "browser_type", {
      sessionId: "desktop-smoke",
      tabId,
      selector: "#name",
      text: "Browser",
    });
    await invoke(registry, "browser_click", {
      sessionId: "desktop-smoke",
      tabId,
      selector: "#mark",
    });
    inspected = (await invoke(registry, "browser_inspect", {
      sessionId: "desktop-smoke",
      tabId,
    })) as BrowserInspection;
    assert.match(inspected.visibleText, /Marked Browser/u);
    await invoke(registry, "browser_navigate", {
      sessionId: "desktop-smoke",
      tabId,
      url: `http://127.0.0.1:${String(port)}/next`,
    });
    inspected = (await invoke(registry, "browser_inspect", {
      sessionId: "desktop-smoke",
      tabId,
    })) as BrowserInspection;
    assert.match(inspected.visibleText, /Navigation complete/u);

    const computer = await invoke(registry, "computer_inspect", {});
    assert.equal((computer as { platform: string }).platform, "darwin");
    const screenshot = await invoke(registry, "computer_screenshot", {});
    assert.ok((screenshot as { bytes: number }).bytes > 0);

    if (process.env["ZENX_SMOKE_COMPUTER_INPUT"] === "1") {
      await invoke(registry, "browser_navigate", {
        sessionId: "desktop-smoke",
        tabId,
        url: `http://127.0.0.1:${String(port)}/`,
      });
      const targetInspection = (await invoke(registry, "browser_inspect", {
        sessionId: "desktop-smoke",
        tabId,
      })) as BrowserInspection;
      const input = targetInspection.targets.find(
        (target) => target.selector === "#name",
      );
      if (input?.screenPoint === undefined) {
        throw new Error("Browser smoke input did not expose a screen target");
      }
      await invoke(registry, "computer_click", {
        ...input.screenPoint,
        context: "ZenX Browser / capability smoke / Name input",
      });
      await invoke(registry, "computer_type", {
        text: "Computer",
        context: "ZenX Browser / capability smoke / Name input",
      });
      const afterInput = (await invoke(registry, "browser_inspect", {
        sessionId: "desktop-smoke",
        tabId,
      })) as BrowserInspection;
      assert.equal(
        afterInput.targets.find((target) => target.selector === "#name")?.value,
        "Computer",
      );
    }

    console.log(
      `ZenX capability desktop smoke passed: browser open/inspect/navigate/click/type; computer inspect/screenshot${
        process.env["ZENX_SMOKE_COMPUTER_INPUT"] === "1" ? "/click/type" : ""
      }`,
    );
  } catch (error) {
    console.error("ZenX capability desktop smoke failed", error);
    process.exitCode = 1;
  } finally {
    await registry.close();
    await closeWeb();
    app.quit();
  }
});

async function invoke(
  registry: ZenXCapabilityRegistry,
  name: string,
  arguments_: Record<string, unknown>,
): Promise<unknown> {
  const result = await registry.execute({
    callId: `smoke-${name}`,
    name,
    arguments: arguments_,
    cwd: process.cwd(),
    signal: new AbortController().signal,
  });
  const parsed = JSON.parse(result.output) as { result?: unknown };
  if (parsed.result === undefined) {
    throw new Error(`${name} returned no structured result`);
  }
  return parsed.result;
}

function requiredResultString(value: unknown, key: string): string {
  if (
    typeof value !== "object" ||
    value === null ||
    typeof (value as Record<string, unknown>)[key] !== "string"
  ) {
    throw new Error(`Smoke result is missing ${key}`);
  }
  return (value as Record<string, string>)[key]!;
}

async function listen(): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    web.once("error", reject);
    web.listen(0, "127.0.0.1", () => resolve());
  });
  const address = web.address();
  if (typeof address !== "object" || address === null) {
    throw new Error("Smoke HTTP server did not bind a TCP port");
  }
  return address.port;
}

async function closeWeb(): Promise<void> {
  if (!web.listening) return;
  await new Promise<void>((resolve, reject) =>
    web.close((error) => (error === undefined ? resolve() : reject(error))),
  );
}
