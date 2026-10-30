import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import WebSocket from "ws";
import {
  fakeBrowserInputSnapshot,
  fakeInputScreenshotData,
} from "./fixtures/user-browser-cdp.js";

import {
  ChromeExtensionBridge,
  ZENX_CHROME_EXTENSION_ID,
  ZENX_CHROME_EXTENSION_ORIGIN,
} from "../src/main/chrome-extension-bridge.js";
import {
  chromeNativeHostFailureDiagnostic,
  chromeNativeHostUserDataDirectory,
  CHROME_NATIVE_INPUT_MAX_BYTES,
  ChromeNativeMessageDecoder,
  encodeChromeNativeMessage,
} from "../src/main/chrome-native-host.js";
import {
  configureChromeNativeHostActivationPolicy,
  chromeNativeHostManifestPath,
  chromeNativeHostExecutablePath,
  chromeNativeHostRegistryKey,
  readBrowserRegistrationTarget,
  chromeNativeHostRegistered,
  registerChromeNativeHost,
  unregisterChromeNativeHost,
} from "../src/main/chrome-native-host-registration.js";

test("native messaging framing preserves split UTF-8 messages and rejects oversized frames", () => {
  const decoder = new ChromeNativeMessageDecoder();
  const framed = encodeChromeNativeMessage({
    type: "hello",
    label: "当前标签",
  });
  assert.deepEqual(decoder.push(framed.subarray(0, 5)), []);
  assert.deepEqual(decoder.push(framed.subarray(5)), [
    { type: "hello", label: "当前标签" },
  ]);
  const oversized = Buffer.alloc(4);
  oversized.writeUInt32LE(CHROME_NATIVE_INPUT_MAX_BYTES + 1);
  assert.throws(() => decoder.push(oversized), /exceeds/u);
});

test("native host resolves an explicit isolated user data directory without leaking diagnostics", () => {
  const isolated = path.resolve(os.tmpdir(), "zenx native fixture");
  assert.equal(
    chromeNativeHostUserDataDirectory({
      argv: ["ZenX", `--user-data-dir=${isolated}`],
    }),
    isolated,
  );
  assert.equal(
    chromeNativeHostUserDataDirectory({
      argv: ["ZenX"],
      commandLineValue: isolated,
    }),
    isolated,
  );
  assert.equal(
    chromeNativeHostUserDataDirectory({ argv: ["ZenX"] }),
    undefined,
  );
  assert.equal(
    chromeNativeHostUserDataDirectory({
      argv: ["ZenX", `--user-data-dir=${isolated}`],
      commandLineValue: path.resolve(os.tmpdir(), "normalized elsewhere"),
    }),
    isolated,
  );
  const diagnostic = chromeNativeHostFailureDiagnostic(
    Object.assign(new Error("ws://127.0.0.1/native/private-token"), {
      code: "ENOENT",
    }),
    "read-descriptor",
  );
  assert.equal(
    diagnostic,
    "ZenX Chrome native host failed [read-descriptor] (ENOENT)\n",
  );
  assert.doesNotMatch(diagnostic, /private-token|127\.0\.0\.1/u);
  assert.equal(
    chromeNativeHostFailureDiagnostic(
      Object.assign(new Error("connect failed"), {
        cause: Object.assign(new Error("secret endpoint"), {
          code: "ECONNREFUSED",
        }),
      }),
      "connect",
    ),
    "ZenX Chrome native host failed [connect] (ECONNREFUSED)\n",
  );
  assert.equal(
    chromeNativeHostFailureDiagnostic(
      new Error("Unexpected server response: 403 at a private URL"),
      "connect",
    ),
    "ZenX Chrome native host failed [connect] {http-response}\n",
  );
  assert.equal(
    chromeNativeHostFailureDiagnostic(
      new Error("Implement me. Unknown stream file type!"),
      "stdio",
    ),
    "ZenX Chrome native host failed [stdio] {unsupported-stdio}\n",
  );
});

test("bundled extension key has the native-host allowlisted extension ID", async () => {
  const manifest = JSON.parse(
    await readFile(
      path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        "../resources/chrome-extension/manifest.json",
      ),
      "utf8",
    ),
  ) as { key: string };
  const digest = createHash("sha256")
    .update(Buffer.from(manifest.key, "base64"))
    .digest()
    .subarray(0, 16)
    .toString("hex")
    .replace(/[0-9a-f]/gu, (value) =>
      String.fromCharCode("a".charCodeAt(0) + Number.parseInt(value, 16)),
    );
  assert.equal(digest, ZENX_CHROME_EXTENSION_ID);
});

test("Chrome bridge routes authenticated CDP across the connected browser", async () => {
  const runtimeDirectory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-chrome-bridge-"),
  );
  const bridge = await ChromeExtensionBridge.start({ runtimeDirectory });
  let native: WebSocket | undefined;
  try {
    const descriptor = JSON.parse(
      await readFile(path.join(runtimeDirectory, "chrome-bridge.json"), "utf8"),
    ) as { nativeWebSocketUrl: string };
    if (process.platform !== "win32") {
      assert.equal(
        (await stat(path.join(runtimeDirectory, "chrome-bridge.json"))).mode &
          0o077,
        0,
      );
    }

    const anonymous = await fetch(`${bridge.endpoint}/json/version`);
    assert.equal(anonymous.status, 401);

    native = new WebSocket(descriptor.nativeWebSocketUrl, {
      headers: { origin: ZENX_CHROME_EXTENSION_ORIGIN },
    });
    await new Promise<void>((resolve, reject) => {
      native!.once("open", resolve);
      native!.once("error", reject);
    });
    native.send(
      JSON.stringify({ type: "hello", protocolVersion: 2, scope: "browser" }),
    );
    native.send(
      JSON.stringify({
        type: "browser-connected",
        tabs: [
          {
            id: 42,
            title: "Signed in account",
            url: "https://example.test/account",
          },
          { id: 43, title: "Other tab", url: "https://other.test/" },
        ],
      }),
    );
    const forwardedMethods: string[] = [];
    const forwardedTargets: number[] = [];
    const inputCommands: Array<{
      method: string;
      tabId?: number;
      params?: Record<string, unknown>;
    }> = [];
    const inputSnapshots = new Map([
      [42, fakeBrowserInputSnapshot()],
      [43, fakeBrowserInputSnapshot()],
      [44, fakeBrowserInputSnapshot()],
    ]);
    let documentUrl = "https://example.test/account";
    native.on("message", (data) => {
      const message = JSON.parse(data.toString()) as {
        type?: string;
        requestId?: string;
        method?: string;
        tabId?: number;
        params?: Record<string, unknown>;
      };
      if (message.type !== "cdp-command" || message.requestId === undefined)
        return;
      const method = message.method ?? "";
      forwardedMethods.push(method);
      if (message.tabId !== undefined) forwardedTargets.push(message.tabId);
      let result: unknown = {};
      const inputSnapshot = inputSnapshots.get(message.tabId ?? 42)!;
      if (method.startsWith("Input.")) {
        inputCommands.push({
          method,
          tabId: message.tabId,
          params: message.params,
        });
        inputSnapshot.inputRevision++;
      } else if (method === "Target.createTarget") {
        documentUrl = String(message.params?.url);
        native!.send(
          JSON.stringify({
            type: "tab-updated",
            tab: { id: 44, title: "New tab", url: documentUrl },
          }),
        );
        result = {
          targetId: "chrome-tab-44",
          grouping: { status: "grouped", groupId: 73 },
        };
      } else if (method === "Page.getFrameTree") {
        result = {
          frameTree: {
            frame: { id: "main", loaderId: "loader", url: documentUrl },
          },
        };
      } else if (method === "Page.createIsolatedWorld") {
        result = { executionContextId: 100 };
      } else if (method === "DOM.describeNode") {
        result = {
          node: {
            backendNodeId:
              message.params?.backendNodeId ??
              (String(message.params?.objectId).includes("hitNode")
                ? 102
                : 101),
            nodeType: 1,
            localName: "input",
            attributes: ["type", "text"],
          },
        };
      } else if (method === "Runtime.evaluate") {
        const expression = String(message.params?.expression ?? "");
        result = {
          result: {
            value: expression.includes("const expected =")
              ? { ok: true }
              : expression === "void 0"
                ? undefined
                : expression.includes("zenx-browser-targeted-input-v2") &&
                    !expression.includes("visibleText:")
                  ? {
                      ...structuredClone(inputSnapshot),
                      ...(expression.includes("const hit = resolveHit")
                        ? { pointerPoint: { x: 1, y: 1 } }
                        : {}),
                    }
                  : {
                      inputSnapshot: structuredClone(inputSnapshot),
                      visibleText: "Signed in as Alice",
                      targets: [
                        {
                          selector: "#continue",
                          tag: "button",
                          role: "button",
                          name: "Continue",
                          type: "",
                          id: "continue",
                          fieldName: "",
                          autocomplete: "",
                          href: "",
                          actions: ["click"],
                        },
                      ],
                    },
          },
        };
        if (
          message.params?.returnByValue === false &&
          expression.includes("zenx-browser-targeted-input-v2")
        ) {
          result = {
            result: {
              subtype: "node",
              objectId: `${message.tabId}:${expression.includes("state?.hitNode") ? "hitNode" : "focusNode"}`,
            },
          };
        }
      } else if (method === "Network.getResponseBody") {
        result = { body: "synthetic response", base64Encoded: false };
      } else if (method === "Page.captureScreenshot") {
        // chrome.debugger rejects view captures; real attached Chrome requires
        // a compositor-surface capture, bounded to the viewport.
        if (
          message.params?.fromSurface !== true ||
          message.params?.captureBeyondViewport !== false
        ) {
          native!.send(
            JSON.stringify({
              type: "cdp-result",
              requestId: message.requestId,
              error: {
                code: -32000,
                message: "Only screenshots from surface are allowed.",
              },
            }),
          );
          return;
        }
        result = {
          data: fakeInputScreenshotData(),
        };
      } else if (method === "Page.navigate") {
        documentUrl = String(message.params?.url ?? documentUrl);
      }
      native!.send(
        JSON.stringify({
          type: "cdp-result",
          requestId: message.requestId,
          result,
        }),
      );
    });

    const connection = await bridge.connectProvider();
    try {
      assert.deepEqual(await connection.backend.listTabs("thread-1"), [
        {
          sessionId: "thread-1",
          tabId: "chrome-tab-42",
          title: "Signed in account",
          url: "https://example.test/account",
          loading: false,
        },
        {
          sessionId: "thread-1",
          tabId: "chrome-tab-43",
          title: "Other tab",
          url: "https://other.test/",
          loading: false,
        },
      ]);
      assert.deepEqual(await connection.backend.listTabs("thread-2"), []);
      const inspection = await connection.backend.inspect(
        "thread-1",
        "chrome-tab-42",
      );
      assert.match(inspection.visibleText, /Signed in as Alice/u);
      const actionTarget = inspection.targets[0];
      assert.equal(actionTarget?.name, "Continue");
      assert.ok(actionTarget);
      await connection.backend.click(
        "thread-1",
        "chrome-tab-42",
        inspection.observationId,
        actionTarget.targetId,
      );
      const pointerObservation = await connection.backend.inspect(
        "thread-1",
        "chrome-tab-42",
      );
      await connection.backend.pointerClick!(
        "thread-1",
        "chrome-tab-42",
        pointerObservation.observationId,
        10,
        20,
      );
      const keyObservation = await connection.backend.inspect(
        "thread-1",
        "chrome-tab-43",
      );
      await connection.backend.keyPress!(
        "thread-1",
        "chrome-tab-43",
        keyObservation.observationId,
        "Enter",
      );
      assert.deepEqual(
        inputCommands.map((command) => [
          command.tabId,
          command.method,
          command.params?.type,
        ]),
        [
          [42, "Input.dispatchMouseEvent", "mousePressed"],
          [42, "Input.dispatchMouseEvent", "mouseReleased"],
          [43, "Input.dispatchKeyEvent", "keyDown"],
          [43, "Input.dispatchKeyEvent", "keyUp"],
        ],
      );
      assert.equal(
        forwardedMethods.some((method) =>
          /activate|bringToFront/i.test(method),
        ),
        false,
      );
      const navigated = await connection.backend.navigate(
        "thread-1",
        "chrome-tab-42",
        "https://example.test/next",
      );
      assert.equal(navigated.url, "https://example.test/next");
      await connection.backend.inspect("thread-1", "chrome-tab-43");
      assert.ok(forwardedTargets.includes(42));
      assert.ok(forwardedTargets.includes(43));
      const created = await connection.backend.open(
        "thread-1",
        "https://example.test/new",
      );
      assert.equal(created.tabId, "chrome-tab-44");
      assert.equal(created.url, "https://example.test/new");
      assert.deepEqual(created.grouping, { status: "grouped", groupId: 73 });
      for (const method of [
        "Page.enable",
        "Runtime.enable",
        "Page.getFrameTree",
        "Page.createIsolatedWorld",
        "Runtime.evaluate",
        "Page.captureScreenshot",
        "Page.navigate",
      ])
        assert.ok(forwardedMethods.includes(method), method);
      assert.equal(
        forwardedMethods.some((method) =>
          /^(?:Network|Storage)\.|cookie/iu.test(method),
        ),
        false,
      );
      await connection.backend.extension!(
        "thread-1",
        "chrome-tab-42",
        "network_start",
        {},
      );
      await connection.backend.extension!(
        "thread-1",
        "chrome-tab-42",
        "console_start",
        {},
      );
      for (const [method, params] of [
        [
          "Network.responseReceived",
          {
            requestId: "fixture-request",
            response: { status: 200, url: "https://example.test/fixture" },
          },
        ],
        [
          "Runtime.consoleAPICalled",
          { type: "log", args: [{ value: "synthetic console" }] },
        ],
      ] as const)
        native.send(
          JSON.stringify({ type: "cdp-event", tabId: 42, method, params }),
        );
      const network = (await connection.backend.extension!(
        "thread-1",
        "chrome-tab-42",
        "network_read",
        {},
      )) as { events: unknown[] };
      assert.equal(network.events.length, 1);
      const consoleEvents = (await connection.backend.extension!(
        "thread-1",
        "chrome-tab-42",
        "console_read",
        {},
      )) as { events: unknown[] };
      assert.equal(consoleEvents.events.length, 1);
      assert.deepEqual(
        await connection.backend.extension!(
          "thread-1",
          "chrome-tab-42",
          "network_response",
          { requestId: "fixture-request" },
        ),
        { body: "synthetic response", base64Encoded: false },
      );
      assert.ok(forwardedMethods.includes("Network.enable"));
      assert.ok(forwardedMethods.includes("Network.getResponseBody"));
      native.send(
        JSON.stringify({
          type: "cdp-event",
          tabId: 42,
          method: "Page.frameNavigated",
          params: {
            frame: {
              id: "main",
              loaderId: "loader-2",
              url: "https://example.test/human-navigation",
            },
          },
        }),
      );
      await waitFor(() => bridge.status().tabCount === 3);
      assert.equal(
        (await connection.backend.listTabs("thread-1")).find(
          (tab) => tab.tabId === "chrome-tab-42",
        )?.url,
        "https://example.test/human-navigation",
      );
      await connection.backend.closeSession("thread-1");
      assert.deepEqual(bridge.status(), { state: "connected", tabCount: 3 });
    } finally {
      await connection.backend.close();
    }
  } finally {
    native?.close();
    await bridge.close();
    await rm(runtimeDirectory, { recursive: true, force: true });
  }
});

test("a competing native connection is rejected without revoking the current browser or pending action", async (t) => {
  const errorListenersAtRejection: number[] = [];
  const send = WebSocket.prototype.send;
  t.mock.method(
    WebSocket.prototype,
    "send",
    function (this: WebSocket, ...args: Parameters<WebSocket["send"]>) {
      if (String(args[0]).includes('"type":"connection-rejected"'))
        errorListenersAtRejection.push(this.listenerCount("error"));
      return send.apply(this, args);
    },
  );
  const runtimeDirectory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-chrome-generation-"),
  );
  const bridge = await ChromeExtensionBridge.start({ runtimeDirectory });
  const sockets: WebSocket[] = [];
  let connection:
    Awaited<ReturnType<typeof bridge.connectProvider>> | undefined;
  try {
    const descriptor = JSON.parse(
      await readFile(path.join(runtimeDirectory, "chrome-bridge.json"), "utf8"),
    ) as { nativeWebSocketUrl: string };
    const connect = async () => {
      const socket = new WebSocket(descriptor.nativeWebSocketUrl, {
        headers: { origin: ZENX_CHROME_EXTENSION_ORIGIN },
      });
      sockets.push(socket);
      await new Promise<void>((resolve, reject) => {
        socket.once("open", resolve);
        socket.once("error", reject);
      });
      socket.send(
        JSON.stringify({ type: "hello", protocolVersion: 2, scope: "browser" }),
      );
      return socket;
    };
    const oldSocket = await connect();
    let navigateRequestId: string | undefined;
    oldSocket.on("message", (data) => {
      const message = JSON.parse(data.toString()) as {
        type?: string;
        requestId?: string;
        method?: string;
      };
      if (message.type !== "cdp-command" || message.requestId === undefined)
        return;
      if (message.method === "Page.navigate") {
        navigateRequestId = message.requestId;
        return;
      }
      oldSocket.send(
        JSON.stringify({
          type: "cdp-result",
          requestId: message.requestId,
          result: {},
        }),
      );
    });
    oldSocket.send(
      JSON.stringify({
        type: "browser-connected",
        tabs: [{ id: 7, title: "Old", url: "https://old.test/" }],
      }),
    );
    await waitFor(() => bridge.status().tabCount === 1);
    connection = await bridge.connectProvider();
    assert.equal(
      (await connection.backend.listTabs("thread"))[0]?.tabId,
      "chrome-tab-7",
    );
    const navigation = connection.backend.navigate(
      "thread",
      "chrome-tab-7",
      "https://old.test/pending",
    );
    await waitFor(() => navigateRequestId !== undefined);

    const competitor = new WebSocket(descriptor.nativeWebSocketUrl, {
      headers: { origin: ZENX_CHROME_EXTENSION_ORIGIN },
    });
    sockets.push(competitor);
    const rejected = new Promise<{ type: string; message: string }>((resolve) =>
      competitor.once("message", (data) =>
        resolve(JSON.parse(data.toString())),
      ),
    );
    const closed = new Promise<number>((resolve) =>
      competitor.once("close", resolve),
    );
    assert.match((await rejected).message, /Disconnect.*before connecting/);
    assert.equal(await closed, 1008);
    assert.equal(oldSocket.readyState, WebSocket.OPEN);
    assert.deepEqual(bridge.status(), { state: "connected", tabCount: 1 });
    oldSocket.send(
      JSON.stringify({
        type: "cdp-result",
        requestId: navigateRequestId,
        result: {},
      }),
    );
    await navigation;
    assert.equal(
      (await connection.backend.listTabs("thread"))[0]?.tabId,
      "chrome-tab-7",
    );

    oldSocket.close();
    await waitFor(() => bridge.status().state === "waiting");
    const currentSocket = await connect();
    currentSocket.send(
      JSON.stringify({
        type: "browser-connected",
        tabs: [{ id: 8, title: "Current", url: "https://current.test/" }],
      }),
    );
    await waitFor(() => bridge.status().tabCount === 1);
    assert.equal(
      (await connection.backend.listTabs("new-session"))[0]?.tabId,
      "chrome-tab-8",
    );
    assert.deepEqual(
      errorListenersAtRejection,
      [1],
      "every socket must handle errors before rejection begins",
    );
  } finally {
    await connection?.backend.close();
    for (const socket of sockets) socket.close();
    await bridge.close();
    await rm(runtimeDirectory, { recursive: true, force: true });
  }
});

test("removing one tab rejects only its commands and zero-tab browser stays connected", async () => {
  const runtimeDirectory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-chrome-multiple-"),
  );
  const bridge = await ChromeExtensionBridge.start({ runtimeDirectory });
  let native: WebSocket | undefined;
  let connection:
    Awaited<ReturnType<typeof bridge.connectProvider>> | undefined;
  let otherConnection:
    Awaited<ReturnType<typeof bridge.connectProvider>> | undefined;
  try {
    const descriptor = JSON.parse(
      await readFile(path.join(runtimeDirectory, "chrome-bridge.json"), "utf8"),
    ) as { nativeWebSocketUrl: string };
    native = new WebSocket(descriptor.nativeWebSocketUrl, {
      headers: { origin: ZENX_CHROME_EXTENSION_ORIGIN },
    });
    await new Promise<void>((resolve, reject) => {
      native!.once("open", resolve);
      native!.once("error", reject);
    });
    const pending = new Map<number, string>();
    native.on("message", (data) => {
      const message = JSON.parse(data.toString()) as {
        type: string;
        method: string;
        tabId: number;
        requestId: string;
      };
      if (message.type !== "cdp-command") return;
      if (message.method === "Page.navigate") {
        pending.set(message.tabId, message.requestId);
        return;
      }
      native!.send(
        JSON.stringify({
          type: "cdp-result",
          requestId: message.requestId,
          result: {},
        }),
      );
    });
    native.send(
      JSON.stringify({ type: "hello", protocolVersion: 2, scope: "browser" }),
    );
    native.send(
      JSON.stringify({
        type: "browser-connected",
        tabs: [
          { id: 1, title: "One", url: "https://one.test/" },
          { id: 2, title: "Two", url: "https://two.test/" },
        ],
      }),
    );
    await waitFor(() => bridge.status().tabCount === 2);
    connection = await bridge.connectProvider();
    await connection.backend.listTabs("thread");
    const first = connection.backend.navigate(
      "thread",
      "chrome-tab-1",
      "https://one.test/next",
    );
    const rejectedFirst = assert.rejects(first);
    otherConnection = await bridge.connectProvider();
    await otherConnection.backend.listTabs("other-thread");
    const second = otherConnection.backend.navigate(
      "other-thread",
      "chrome-tab-2",
      "https://two.test/next",
    );
    await waitFor(() => pending.size === 2);
    native.send(JSON.stringify({ type: "tab-removed", tabId: 1 }));
    await rejectedFirst;
    native.send(
      JSON.stringify({
        type: "cdp-result",
        requestId: pending.get(2),
        result: {},
      }),
    );
    assert.equal((await second).url, "https://two.test/next");
    native.send(JSON.stringify({ type: "tab-removed", tabId: 2 }));
    await waitFor(() => bridge.status().tabCount === 0);
    assert.deepEqual(bridge.status(), { state: "connected", tabCount: 0 });
    native.close();
    await waitFor(() => bridge.status().state === "waiting");
  } finally {
    native?.close();
    await connection?.backend.close();
    await otherConnection?.backend.close();
    await bridge.close();
    await rm(runtimeDirectory, { recursive: true, force: true });
  }
});

test("old single-tab extensions cannot imply browser-wide consent", async () => {
  const runtimeDirectory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-chrome-old-extension-"),
  );
  const bridge = await ChromeExtensionBridge.start({ runtimeDirectory });
  let native: WebSocket | undefined;
  try {
    const descriptor = JSON.parse(
      await readFile(path.join(runtimeDirectory, "chrome-bridge.json"), "utf8"),
    ) as { nativeWebSocketUrl: string };
    native = new WebSocket(descriptor.nativeWebSocketUrl, {
      headers: { origin: ZENX_CHROME_EXTENSION_ORIGIN },
    });
    await new Promise<void>((resolve, reject) => {
      native!.once("open", resolve);
      native!.once("error", reject);
    });
    const closed = new Promise<number>((resolve) =>
      native!.once("close", (code) => resolve(code)),
    );
    native.send(JSON.stringify({ type: "hello", protocolVersion: 1 }));
    assert.equal(await closed, 1008);
    assert.deepEqual(bridge.status(), { state: "waiting", tabCount: 0 });
  } finally {
    native?.close();
    await bridge.close();
    await rm(runtimeDirectory, { recursive: true, force: true });
  }
});

test("native host registration pins the executable and exact extension origin and is removable", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "zenx-native-host-"));
  const options = {
    platform: "linux" as const,
    homeDirectory: root,
    runtimeDirectory: path.join(root, "runtime"),
    executablePath: path.join(root, "ZenX"),
  };
  try {
    const manifestFile = await registerChromeNativeHost(options);
    assert.equal(manifestFile, chromeNativeHostManifestPath(options));
    const manifest = JSON.parse(await readFile(manifestFile, "utf8")) as {
      path: string;
      allowed_origins: string[];
    };
    assert.equal(manifest.path, options.executablePath);
    assert.deepEqual(manifest.allowed_origins, [ZENX_CHROME_EXTENSION_ORIGIN]);
    assert.equal(await chromeNativeHostRegistered(options), true);
    await unregisterChromeNativeHost(options);
    assert.equal(await chromeNativeHostRegistered(options), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Windows native host manifest selects the no-console launcher", () => {
  const options = {
    platform: "win32" as const,
    homeDirectory: "unused",
    runtimeDirectory: path.resolve("runtime"),
    executablePath: path.resolve("ZenX.exe"),
    windowsLauncherPath: path.resolve("resources/zenx-native-host.cmd"),
  };
  assert.equal(
    chromeNativeHostExecutablePath(options),
    options.windowsLauncherPath,
  );
});

test("only the macOS native host process becomes a Dockless accessory", () => {
  const policies: string[] = [];
  for (const [platform, nativeHostMode] of [
    ["darwin", true],
    ["darwin", false],
    ["linux", true],
  ] as const) {
    configureChromeNativeHostActivationPolicy({
      platform,
      nativeHostMode,
      setActivationPolicy: (policy) => policies.push(policy),
    });
  }
  assert.deepEqual(policies, ["accessory"]);
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline)
      throw new Error("Timed out waiting for fixture");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("Chrome and Edge registration paths stay independent on each supported platform", () => {
  const base = {
    homeDirectory: "/home/test",
    runtimeDirectory: "/runtime",
    executablePath: "/app/zenx",
    windowsLauncherPath: "/app/zenx.cmd",
  };
  for (const platform of ["linux", "darwin", "win32"] as const) {
    const chrome = chromeNativeHostManifestPath({
      ...base,
      platform,
      browser: "chrome",
    });
    const edge = chromeNativeHostManifestPath({
      ...base,
      platform,
      browser: "edge",
    });
    assert.notEqual(chrome, edge);
    assert.match(
      edge,
      platform === "linux"
        ? /microsoft-edge\/NativeMessagingHosts/
        : platform === "darwin"
          ? /Microsoft Edge\/NativeMessagingHosts/
          : /\.edge\.json$/,
    );
  }
  assert.match(
    chromeNativeHostRegistryKey({ browser: "edge" }),
    /Microsoft\\Edge\\NativeMessagingHosts/,
  );
  assert.match(
    chromeNativeHostRegistryKey({ browser: "chrome" }),
    /Google\\Chrome\\NativeMessagingHosts/,
  );
  assert.equal(readBrowserRegistrationTarget(undefined), "chrome");
  assert.equal(readBrowserRegistrationTarget("edge"), "edge");
  assert.throws(() => readBrowserRegistrationTarget("other"), /Unsupported/);
});

test("removing Edge registration leaves Chrome registration and origin restrictions intact", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "zenx-edge-registration-"));
  const base = {
    platform: "linux" as const,
    homeDirectory: root,
    runtimeDirectory: path.join(root, "runtime"),
    executablePath: "/app/ZenX",
  };
  try {
    await registerChromeNativeHost(base);
    await registerChromeNativeHost({ ...base, browser: "edge" });
    assert.equal(await chromeNativeHostRegistered(base), true);
    assert.equal(
      await chromeNativeHostRegistered({ ...base, browser: "edge" }),
      true,
    );
    const manifest = JSON.parse(
      await readFile(
        chromeNativeHostManifestPath({ ...base, browser: "edge" }),
        "utf8",
      ),
    );
    assert.deepEqual(manifest.allowed_origins, [ZENX_CHROME_EXTENSION_ORIGIN]);
    await unregisterChromeNativeHost({ ...base, browser: "edge" });
    assert.equal(
      await chromeNativeHostRegistered({ ...base, browser: "edge" }),
      false,
    );
    assert.equal(await chromeNativeHostRegistered(base), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
