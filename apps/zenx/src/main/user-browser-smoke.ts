import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import WebSocket, { type RawData } from "ws";

import { selectBrowserProvider } from "./capabilities/provider-catalog.js";
import {
  UserBrowserDocumentChangedBeforeDispatchError,
  windowsBrowserExecutableCandidates,
} from "./capabilities/user-browser-provider.js";

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
  const title =
    request.url === "/opened"
      ? "ZenX provider background target"
      : "ZenX original active target";
  response.end(
    `<!doctype html><title>${title}</title><main><p>${authenticated ? "Signed in through existing browser state" : "Signed out"}</p><p id="visibility">Visibility ${"${document.visibilityState}"}</p><button id="continue" onclick="this.textContent='Attached action complete'">Continue</button><script>const visibility = document.querySelector('#visibility'); const updateVisibility = () => visibility.textContent = 'Visibility ' + document.visibilityState; updateVisibility(); document.addEventListener('visibilitychange', updateVisibility);</script></main>`,
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
  const inspection = await retryDocumentInspection(() =>
    backend.inspect("windows-smoke", account.tabId),
  );
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
  await activateBrowserTarget(endpoint, account.tabId);
  const fixtureBrowserHwnd = foregroundSmokeBrowserWindow();
  await retry(async () => {
    const snapshot = await browserTargetSnapshot(endpoint, fixtureBrowserHwnd);
    return snapshot.activeTargetId === account.tabId ? snapshot : undefined;
  });
  const verified = await retryDocumentInspection(() =>
    backend.inspect("windows-smoke", account.tabId),
  );
  assert.match(verified.visibleText, /Attached action complete/u);
  const accountVisibilityBeforeOpen = visibilityState(verified.visibleText);
  const foregroundBeforeOpen = foregroundWindowHandle();
  const targetsBeforeOpen = await browserTargetSnapshot(
    endpoint,
    fixtureBrowserHwnd,
  );
  assert.equal(
    targetsBeforeOpen.activeTargetId,
    account.tabId,
    "the authenticated fixture must be the actual active target before open",
  );
  const opened = await backend.open(
    "windows-smoke",
    `http://127.0.0.1:${String(port)}/opened`,
  );
  const foregroundAfterOpen = foregroundWindowHandle();
  const targetsAfterOpen = await browserTargetSnapshot(
    endpoint,
    fixtureBrowserHwnd,
  );
  assert.equal(
    foregroundAfterOpen,
    foregroundBeforeOpen,
    "background_safe browser_open must not change the foreground window",
  );
  assert.equal(
    targetsAfterOpen.activeTargetId,
    targetsBeforeOpen.activeTargetId,
    "background_safe browser_open must preserve the actual active target",
  );
  assert.equal(
    targetsAfterOpen.visibilityByTarget.get(opened.tabId),
    "hidden",
    "the provider-created target must be hidden at the browser target boundary",
  );
  const accountAfterOpen = await retryDocumentInspection(() =>
    backend.inspect("windows-smoke", account.tabId),
  );
  assert.equal(
    visibilityState(accountAfterOpen.visibleText),
    accountVisibilityBeforeOpen,
    "background_safe browser_open must preserve existing-tab visibility",
  );
  const openedInspection = await retryDocumentInspection(() =>
    backend.inspect("windows-smoke", opened.tabId),
  );
  assert.equal(
    visibilityState(openedInspection.visibleText),
    "hidden",
    "background_safe browser_open must leave the created tab hidden",
  );
  const detached = await backend.closeSession("windows-smoke");
  await backend.close();
  const foregroundAfterClose = foregroundWindowHandle();
  const targetsAfterClose = await browserTargetSnapshot(
    endpoint,
    fixtureBrowserHwnd,
  );
  assert.equal(detached, tabs.length + 1);
  assert.equal(
    browser.exitCode,
    null,
    "Closing ZenX must leave the user browser running",
  );
  assert.equal(
    foregroundAfterClose,
    foregroundBeforeOpen,
    "provider close must preserve the foreground window",
  );
  assert.equal(
    targetsAfterClose.activeTargetId,
    targetsBeforeOpen.activeTargetId,
    "provider close must preserve the actual active target",
  );
  assert.equal(
    targetsAfterClose.visibilityByTarget.get(account.tabId),
    accountVisibilityBeforeOpen,
    "the original target must survive close with its visibility unchanged",
  );
  assert.equal(
    targetsAfterClose.visibilityByTarget.get(opened.tabId),
    "hidden",
    "the provider-created target must survive detach in the background",
  );
  const browserTargets = targetsAfterClose.targetIds;
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
      providerClosePreservedForegroundWindow: true,
      activeTargetBeforeOpen: targetsBeforeOpen.activeTargetId,
      activeTargetAfterOpen: targetsAfterOpen.activeTargetId,
      activeTargetAfterClose: targetsAfterClose.activeTargetId,
      originalTargetSurvived: targetsAfterClose.targetIds.includes(
        account.tabId,
      ),
      providerCreatedTargetSurvivedHidden:
        targetsAfterClose.visibilityByTarget.get(opened.tabId) === "hidden",
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

function foregroundSmokeBrowserWindow(): string {
  const script = [
    'Add-Type -TypeDefinition \'using System; using System.Runtime.InteropServices; public static class ZenXSmokeWindow { [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow); [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd); }\'',
    "$process = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -like '*ZenX original active target*' } | Select-Object -First 1",
    "if ($null -eq $process) { throw 'Smoke browser window was not found' }",
    "[void][ZenXSmokeWindow]::ShowWindowAsync($process.MainWindowHandle, 9)",
    "[void][ZenXSmokeWindow]::SetForegroundWindow($process.MainWindowHandle)",
    "$process.MainWindowHandle.ToInt64()",
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

async function browserTargetSnapshot(
  endpoint: string,
  browserHwnd: string,
): Promise<{
  activeTargetId: string;
  targetIds: string[];
  visibilityByTarget: Map<string, "visible" | "hidden">;
}> {
  const response = await fetch(`${endpoint}/json/list`, {
    signal: AbortSignal.timeout(5_000),
    redirect: "error",
  });
  assert.equal(response.ok, true, "Expected the real browser target list");
  const raw: unknown = await response.json();
  assert.ok(Array.isArray(raw), "Expected a real browser target array");
  const targets = raw.filter(
    (value): value is Record<string, unknown> =>
      typeof value === "object" && value !== null && !Array.isArray(value),
  );
  const visibilityByTarget = new Map<string, "visible" | "hidden">();
  const titleByTarget = new Map<string, string>();
  for (const target of targets) {
    if (
      target.type !== "page" ||
      typeof target.id !== "string" ||
      typeof target.webSocketDebuggerUrl !== "string"
    ) {
      continue;
    }
    const visibility = await evaluateTargetVisibility(
      target.webSocketDebuggerUrl,
    );
    visibilityByTarget.set(target.id, visibility);
    if (typeof target.title === "string") {
      titleByTarget.set(target.id, target.title);
    }
  }
  const nativeWindowTitle = browserWindowTitle(browserHwnd);
  const active = [...titleByTarget].filter(
    ([, title]) => title.length > 0 && nativeWindowTitle.includes(title),
  );
  assert.equal(
    active.length,
    1,
    `Expected the native browser window title to identify one target: ${JSON.stringify({ nativeWindowTitle, targets: [...titleByTarget] })}`,
  );
  return {
    activeTargetId: active[0]?.[0] ?? "",
    targetIds: [...visibilityByTarget.keys()],
    visibilityByTarget,
  };
}

function browserWindowTitle(browserHwnd: string): string {
  const script = [
    `$handle = [Int64]${browserHwnd}`,
    "$process = Get-Process | Where-Object { $_.MainWindowHandle.ToInt64() -eq $handle } | Select-Object -First 1",
    "if ($null -eq $process) { throw 'Smoke browser HWND no longer exists' }",
    "$process.MainWindowTitle",
  ].join("; ");
  return execFileSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { encoding: "utf8", windowsHide: true },
  ).trim();
}

async function evaluateTargetVisibility(
  webSocketDebuggerUrl: string,
): Promise<"visible" | "hidden"> {
  const response = await sendCdpCommand(
    webSocketDebuggerUrl,
    "Runtime.evaluate",
    {
      expression: "document.visibilityState",
      returnByValue: true,
    },
  );
  const value = (
    response.result as { result?: { value?: unknown } } | undefined
  )?.result?.value;
  assert.ok(
    value === "visible" || value === "hidden",
    "Expected a real target visibility state",
  );
  return value;
}

async function activateBrowserTarget(
  endpoint: string,
  targetId: string,
): Promise<void> {
  const version = (await (
    await fetch(`${endpoint}/json/version`, {
      signal: AbortSignal.timeout(5_000),
      redirect: "error",
    })
  ).json()) as { webSocketDebuggerUrl?: unknown };
  assert.equal(
    typeof version.webSocketDebuggerUrl,
    "string",
    "Expected the real browser websocket endpoint",
  );
  await sendCdpCommand(
    version.webSocketDebuggerUrl as string,
    "Target.activateTarget",
    { targetId },
  );
}

async function sendCdpCommand(
  webSocketDebuggerUrl: string,
  method: string,
  params: Record<string, unknown>,
): Promise<{ result?: unknown; error?: unknown }> {
  const socket = new WebSocket(webSocketDebuggerUrl, {
    handshakeTimeout: 5_000,
  });
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    return await new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error(`${method} smoke command timed out`)),
        5_000,
      );
      const receive = (raw: RawData) => {
        const message = JSON.parse(raw.toString()) as {
          id?: unknown;
          result?: unknown;
          error?: unknown;
        };
        if (message.id !== 1) return;
        clearTimeout(timeout);
        socket.off("message", receive);
        if (message.error !== undefined) {
          reject(new Error(`${method} smoke command failed`));
        } else {
          resolve(message);
        }
      };
      socket.on("message", receive);
      socket.send(JSON.stringify({ id: 1, method, params }));
    });
  } finally {
    socket.close();
  }
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

async function retryDocumentInspection<T>(
  operation: () => Promise<T>,
): Promise<T> {
  return await retry(async () => {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof UserBrowserDocumentChangedBeforeDispatchError) {
        return undefined;
      }
      throw error;
    }
  });
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
