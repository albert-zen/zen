import assert from "node:assert/strict";
import { createServer } from "node:http";
import { access } from "node:fs/promises";

import { app, screen } from "electron";

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
  if (request.url === "/storage-seed") {
    response.end(`<!doctype html><title>Storage seed</title>
      <main>Storage seeded</main>
      <script>
        document.cookie = "zenx_smoke_cookie=present; SameSite=Lax";
        sessionStorage.setItem("zenx_smoke_session", "present");
      </script>`);
    return;
  }
  if (request.url === "/storage-check") {
    response.end(`<!doctype html><title>Storage check</title>
      <main></main>
      <script>
        const cookieLeaked = document.cookie.includes("zenx_smoke_cookie=present");
        const sessionLeaked = sessionStorage.getItem("zenx_smoke_session") === "present";
        document.querySelector("main").textContent = cookieLeaked || sessionLeaked ? "Storage leaked" : "Storage clean";
      </script>`);
    return;
  }
  response.end(`<!doctype html>
    <title>ZenX capability smoke</title>
    <input id="name" aria-label="Name">
    <input id="password" type="password" aria-label="Password" value="must-not-leak">
    <button id="hidden" hidden>Hidden</button>
    <button id="mark" onclick="document.querySelector('output').textContent = 'Marked ' + document.querySelector('#name').value">Mark</button>
    <button id="volatile">Original identity</button>
    <output></output>
    <a id="next" href="/next">Next</a>
    <script>setTimeout(() => document.querySelector('#volatile').textContent = 'Changed identity', 5000)</script>`);
});

app.commandLine.appendSwitch("force-renderer-accessibility");

void app.whenReady().then(async () => {
  app.setAccessibilitySupportEnabled(true);
  const registry = new ZenXCapabilityRegistry(
    new MemoryZenXCapabilityGrantStore(),
  );
  try {
    const port = await listen();
    await registry.initialize();
    registry.register(
      new BrowserZenXCapabilityPackage(new ElectronBrowserBackend()),
    );
    const computerBackend = new ElectronMacComputerBackend();
    await computerBackend.prepareForegroundInput(new AbortController().signal);
    registry.register(new ComputerZenXCapabilityPackage(computerBackend));
    await registry.grant("browser");
    await registry.grant("computer");
    const cursorBefore = screen.getCursorScreenPoint();
    const foregroundBefore = await computerBackend.desktopContext();

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
    await access(inspected.screenshot.artifactPath);
    assert.equal(inspected.screenshot.observationId, inspected.observationId);
    assert.equal(
      inspected.targets.some(({ name }) => name === "Hidden"),
      false,
    );
    const password = inspected.targets.find(({ name }) => name === "Password");
    assert.equal(password?.value, undefined);
    assert.equal(password?.actions.includes("type"), true);
    if (password !== undefined) {
      await invoke(registry, "browser_type", {
        sessionId: "desktop-smoke",
        tabId,
        observationId: inspected.observationId,
        targetId: password.targetId,
        text: "ordinary-argument",
      });
    }
    inspected = (await invoke(registry, "browser_inspect", {
      sessionId: "desktop-smoke",
      tabId,
    })) as BrowserInspection;
    const input = requiredBrowserTarget(inspected, "Name", "type");
    await invoke(registry, "browser_type", {
      sessionId: "desktop-smoke",
      tabId,
      observationId: inspected.observationId,
      targetId: input.targetId,
      text: "Browser",
    });
    await assert.rejects(
      invoke(registry, "browser_click", {
        sessionId: "desktop-smoke",
        tabId,
        observationId: inspected.observationId,
        targetId: input.targetId,
      }),
      /stale or unknown/u,
    );
    inspected = (await invoke(registry, "browser_inspect", {
      sessionId: "desktop-smoke",
      tabId,
    })) as BrowserInspection;
    await assert.rejects(
      invoke(registry, "browser_click", {
        sessionId: "desktop-smoke",
        tabId,
        observationId: inspected.observationId,
        targetId: "forged-target",
      }),
      /forged/u,
    );
    const mark = requiredBrowserTarget(inspected, "Mark", "click");
    await invoke(registry, "browser_click", {
      sessionId: "desktop-smoke",
      tabId,
      observationId: inspected.observationId,
      targetId: mark.targetId,
    });
    inspected = (await invoke(registry, "browser_inspect", {
      sessionId: "desktop-smoke",
      tabId,
    })) as BrowserInspection;
    assert.match(inspected.visibleText, /Marked Browser/u);
    const volatile = requiredBrowserTarget(
      inspected,
      "Original identity",
      "click",
    );
    await new Promise((resolve) => setTimeout(resolve, 5200));
    await assert.rejects(
      invoke(registry, "browser_click", {
        sessionId: "desktop-smoke",
        tabId,
        observationId: inspected.observationId,
        targetId: volatile.targetId,
      }),
      /identity-changed/u,
    );
    inspected = (await invoke(registry, "browser_inspect", {
      sessionId: "desktop-smoke",
      tabId,
    })) as BrowserInspection;
    const staleNavigationTarget = requiredBrowserTarget(
      inspected,
      "Next",
      "click",
    );
    await invoke(registry, "browser_navigate", {
      sessionId: "desktop-smoke",
      tabId,
      url: `http://127.0.0.1:${String(port)}/next`,
    });
    await assert.rejects(
      invoke(registry, "browser_click", {
        sessionId: "desktop-smoke",
        tabId,
        observationId: inspected.observationId,
        targetId: staleNavigationTarget.targetId,
      }),
      /stale or unknown/u,
    );
    inspected = (await invoke(registry, "browser_inspect", {
      sessionId: "desktop-smoke",
      tabId,
    })) as BrowserInspection;
    assert.match(inspected.visibleText, /Navigation complete/u);

    await invoke(registry, "browser_navigate", {
      sessionId: "desktop-smoke",
      tabId,
      url: `http://127.0.0.1:${String(port)}/storage-seed`,
    });
    inspected = (await invoke(registry, "browser_inspect", {
      sessionId: "desktop-smoke",
      tabId,
    })) as BrowserInspection;
    assert.match(inspected.visibleText, /Storage seeded/u);
    const closedSeedSession = await invoke(registry, "browser_close_session", {
      sessionId: "desktop-smoke",
    });
    assert.equal((closedSeedSession as { closedTabs: number }).closedTabs, 1);
    const remainingTabs = (await invoke(registry, "browser_list_tabs", {
      sessionId: "desktop-smoke",
    })) as unknown[];
    assert.deepEqual(remainingTabs, []);

    const reopened = await invoke(registry, "browser_open", {
      sessionId: "desktop-smoke",
      url: `http://127.0.0.1:${String(port)}/storage-check`,
    });
    const reopenedTabId = requiredResultString(reopened, "tabId");
    inspected = (await invoke(registry, "browser_inspect", {
      sessionId: "desktop-smoke",
      tabId: reopenedTabId,
    })) as BrowserInspection;
    assert.match(inspected.visibleText, /Storage clean/u);
    assert.doesNotMatch(inspected.visibleText, /Storage leaked/u);
    await invoke(registry, "browser_close", {
      sessionId: "desktop-smoke",
      tabId: reopenedTabId,
    });
    const closedSession = await invoke(registry, "browser_close_session", {
      sessionId: "desktop-smoke",
    });
    assert.equal((closedSession as { closedTabs: number }).closedTabs, 0);
    const cursorAfter = screen.getCursorScreenPoint();
    const foregroundAfter = await computerBackend.desktopContext();
    assert.deepEqual(cursorAfter, cursorBefore);
    assert.equal(foregroundAfter.pid, foregroundBefore.pid);
    assert.equal(foregroundAfter.bundleId, foregroundBefore.bundleId);

    console.log(
      "ZenX capability desktop smoke passed: opaque browser observe/act IDs reject forged, stale, hidden, and changed targets while password input dispatches normally; close-session resets cookie/session storage before same-ID reopen; foreground helper compiled without running input; pointer and foreground app unchanged",
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

function requiredBrowserTarget(
  inspection: BrowserInspection,
  name: string,
  action: "click" | "type",
): BrowserInspection["targets"][number] {
  const target = inspection.targets.find(
    (candidate) =>
      candidate.name === name && candidate.actions.includes(action),
  );
  if (target === undefined) {
    throw new Error(
      `Smoke inspection did not return ${action} target ${name}: ${JSON.stringify(inspection.targets)}`,
    );
  }
  return target;
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
