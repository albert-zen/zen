import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { selectBrowserProvider } from "./capabilities/provider-catalog.js";
import { windowsBrowserExecutableCandidates } from "./capabilities/user-browser-provider.js";

if (process.platform !== "win32") {
  throw new Error("The real user-browser CDP smoke is Windows-only");
}

const server = createServer((request, response) => {
  if (request.url === "/seed") {
    response.statusCode = 302;
    response.setHeader(
      "set-cookie",
      "zenx_smoke_auth=present; HttpOnly; SameSite=Lax",
    );
    response.setHeader("location", "/account");
    response.end();
    return;
  }
  const authenticated =
    request.headers.cookie?.includes("zenx_smoke_auth=present") === true;
  response.setHeader("content-type", "text/html; charset=utf-8");
  response.end(
    `<!doctype html><title>User session smoke</title><main><p>${authenticated ? "Signed in through existing browser state" : "Signed out"}</p><p id="visibility">Visibility ${"${document.visibilityState}"}</p><button id="continue" onclick="this.textContent='Attached action complete'">Continue</button><script>const visibility = document.querySelector('#visibility'); const updateVisibility = () => visibility.textContent = 'Visibility ' + document.visibilityState; updateVisibility(); document.addEventListener('visibilitychange', updateVisibility);</script></main>`,
  );
});

let browser: ChildProcess | undefined;
let directory: string | undefined;

try {
  const executable = await findBrowserExecutable();
  directory = await mkdtemp(path.join(os.tmpdir(), "zenx-user-browser-smoke-"));
  const port = await listen();
  browser = spawn(
    executable,
    [
      `--user-data-dir=${directory}`,
      "--remote-debugging-port=0",
      "--no-first-run",
      "--no-default-browser-check",
      `http://127.0.0.1:${String(port)}/seed`,
    ],
    { stdio: "ignore", windowsHide: true },
  );
  const debuggingPort = await readDevToolsPort(directory);
  const endpoint = `http://127.0.0.1:${debuggingPort}`;
  const selection = await selectBrowserProvider({
    userDataDirectory: directory,
    platform: "win32",
    environment: {
      ZENX_BROWSER_MODE: "user-session",
      ZENX_USER_BROWSER_CDP_ENDPOINT: endpoint,
    },
  });
  const backend = selection.backend;
  assert.ok(
    backend,
    `Expected user-browser provider: ${JSON.stringify(selection.diagnostics)}`,
  );
  const selected = selection.diagnostics.find(
    (diagnostic) => diagnostic.status === "selected",
  );
  assert.equal(selected?.providerId, "user-browser-cdp");
  assert.equal(selection.manifest.provider.id, "user-browser-cdp");
  const tabs = await retry(async () => {
    const current = await backend.listTabs("windows-smoke");
    return current.some((tab) => tab.url.includes("/account"))
      ? current
      : undefined;
  });
  const account = tabs.find((tab) => tab.url.includes("/account"));
  assert.ok(account, "Expected the already-running authenticated account tab");
  const inspection = await backend.inspect("windows-smoke", account.tabId);
  assert.match(
    inspection.visibleText,
    /Signed in through existing browser state/u,
  );
  assert.doesNotMatch(
    JSON.stringify(inspection),
    /zenx_smoke_auth|cookie|storageState|authorization/iu,
  );
  const target = inspection.targets.find(
    (candidate) => candidate.name === "Continue",
  );
  assert.ok(target, "Expected the existing user tab action target");
  await backend.click(
    "windows-smoke",
    account.tabId,
    inspection.observationId,
    target.targetId,
  );
  const verified = await backend.inspect("windows-smoke", account.tabId);
  assert.match(verified.visibleText, /Attached action complete/u);
  const accountVisibilityBeforeOpen = visibilityState(verified.visibleText);
  const foregroundBeforeOpen = foregroundWindowHandle();
  const opened = await backend.open(
    "windows-smoke",
    `http://127.0.0.1:${String(port)}/opened`,
  );
  const foregroundAfterOpen = foregroundWindowHandle();
  assert.equal(
    foregroundAfterOpen,
    foregroundBeforeOpen,
    "background_safe browser_open must not change the foreground window",
  );
  const accountAfterOpen = await backend.inspect(
    "windows-smoke",
    account.tabId,
  );
  assert.equal(
    visibilityState(accountAfterOpen.visibleText),
    accountVisibilityBeforeOpen,
    "background_safe browser_open must preserve existing-tab visibility",
  );
  const openedInspection = await backend.inspect("windows-smoke", opened.tabId);
  assert.equal(
    visibilityState(openedInspection.visibleText),
    "hidden",
    "background_safe browser_open must leave the created tab hidden",
  );
  const detached = await backend.closeSession("windows-smoke");
  await backend.close();
  assert.equal(detached, tabs.length + 1);
  assert.equal(
    browser.exitCode,
    null,
    "Closing ZenX must leave the user browser running",
  );
  const browserTargets = (await (
    await fetch(`${endpoint}/json/list`)
  ).json()) as unknown[];
  assert.ok(
    browserTargets.length > 0,
    "Closing ZenX must leave user tabs intact",
  );
  console.log(
    JSON.stringify({
      passed: true,
      provider: "user-browser-cdp",
      product: selected?.version,
      inheritedAuthenticatedState: true,
      agentReceivedSessionMaterial: false,
      browserAndTabsSurvivedDetach: true,
      providerOpenPreservedForegroundWindow: true,
      providerOpenPreservedActiveTab: true,
    }),
  );
} finally {
  await closeServer();
  if (browser?.pid !== undefined) {
    await stopProcessTree(browser.pid);
  }
  if (directory !== undefined) {
    await rm(directory, {
      recursive: true,
      force: true,
      maxRetries: 20,
      retryDelay: 250,
    });
  }
}

function foregroundWindowHandle(): string {
  const script = [
    "Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class ZenXForeground { [DllImport(\"user32.dll\")] public static extern IntPtr GetForegroundWindow(); }'",
    "[ZenXForeground]::GetForegroundWindow().ToInt64()",
  ].join("; ");
  return execFileSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { encoding: "utf8", windowsHide: true },
  ).trim();
}

function visibilityState(visibleText: string): "visible" | "hidden" {
  const match = /Visibility (visible|hidden)/u.exec(visibleText);
  assert.ok(match, "Expected the smoke page to expose document visibility");
  return match[1] as "visible" | "hidden";
}

async function findBrowserExecutable(): Promise<string> {
  const candidates = [
    process.env.ZENX_USER_BROWSER_EXECUTABLE,
    ...windowsBrowserExecutableCandidates(process.env),
  ].filter(
    (candidate): candidate is string =>
      candidate !== undefined && candidate.length > 0,
  );
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Keep probing the explicit finite list.
    }
  }
  throw new Error(
    "No supported Chrome or Edge executable found for the Windows user-browser smoke",
  );
}

async function readDevToolsPort(userDataDirectory: string): Promise<string> {
  return await retry(async () => {
    try {
      const [port] = (
        await readFile(
          path.join(userDataDirectory, "DevToolsActivePort"),
          "utf8",
        )
      ).split(/\r?\n/u);
      return /^\d+$/u.test(port ?? "") ? port : undefined;
    } catch {
      return undefined;
    }
  });
}

async function retry<T>(operation: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const result = await operation();
    if (result !== undefined) return result;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    "Timed out waiting for the real user browser CDP smoke fixture",
  );
}

async function listen(): Promise<number> {
  return await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      const address = server.address();
      if (address === null || typeof address === "string")
        reject(new Error("Smoke server did not bind"));
      else resolve(address.port);
    });
  });
}

async function closeServer(): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error === undefined ? resolve() : reject(error))),
  );
}

async function stopProcessTree(pid: number): Promise<void> {
  await new Promise<void>((resolve) => {
    const cleanup = spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    cleanup.once("exit", () => resolve());
    cleanup.once("error", () => resolve());
  });
}
