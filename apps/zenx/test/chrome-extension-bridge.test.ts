import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import WebSocket from "ws";

import {
  ChromeExtensionBridge,
  ZENX_CHROME_EXTENSION_ID,
  ZENX_CHROME_EXTENSION_ORIGIN,
} from "../src/main/chrome-extension-bridge.js";
import {
  CHROME_NATIVE_INPUT_MAX_BYTES,
  ChromeNativeMessageDecoder,
  encodeChromeNativeMessage,
} from "../src/main/chrome-native-host.js";
import {
  chromeNativeHostManifestPath,
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

test("Chrome bridge exposes only the explicitly attached tab over authenticated CDP", async () => {
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
    native.send(JSON.stringify({ type: "hello", protocolVersion: 1 }));
    native.send(
      JSON.stringify({
        type: "tab-attached",
        tab: {
          id: 42,
          title: "Signed in account",
          url: "https://example.test/account",
        },
      }),
    );
    const forwardedMethods: string[] = [];
    native.on("message", (data) => {
      const message = JSON.parse(data.toString()) as {
        type?: string;
        requestId?: string;
        method?: string;
      };
      if (message.type !== "cdp-command" || message.requestId === undefined)
        return;
      forwardedMethods.push(message.method ?? "");
      native!.send(
        JSON.stringify({
          type: "cdp-result",
          requestId: message.requestId,
          result: {},
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
      ]);
      assert.deepEqual(await connection.backend.listTabs("thread-2"), []);
      const navigated = await connection.backend.navigate(
        "thread-1",
        "chrome-tab-42",
        "https://example.test/next",
      );
      assert.equal(navigated.url, "https://example.test/next");
      assert.deepEqual(forwardedMethods, [
        "Page.enable",
        "Runtime.enable",
        "Page.navigate",
      ]);
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
      await waitFor(
        () =>
          bridge.status().connectedTab?.url ===
          "https://example.test/human-navigation",
      );
      await connection.backend.closeSession("thread-1");
      assert.equal(bridge.status().connectedTab?.title, "Signed in account");
    } finally {
      await connection.backend.close();
    }
  } finally {
    native?.close();
    await bridge.close();
    await rm(runtimeDirectory, { recursive: true, force: true });
  }
});

test("Chrome bridge ignores a replaced native connection's late tab message", async () => {
  const runtimeDirectory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-chrome-generation-"),
  );
  const bridge = await ChromeExtensionBridge.start({ runtimeDirectory });
  const sockets: WebSocket[] = [];
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
      return socket;
    };
    const oldSocket = await connect();
    const currentSocket = await connect();
    currentSocket.send(
      JSON.stringify({
        type: "tab-attached",
        tab: { id: 8, title: "Current", url: "https://current.test/" },
      }),
    );
    oldSocket.send(
      JSON.stringify({
        type: "tab-attached",
        tab: { id: 7, title: "Stale", url: "https://stale.test/" },
      }),
    );
    await waitFor(() => bridge.status().connectedTab?.id === 8);
    assert.deepEqual(bridge.status().connectedTab, {
      id: 8,
      title: "Current",
      url: "https://current.test/",
    });
  } finally {
    for (const socket of sockets) socket.close();
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

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline)
      throw new Error("Timed out waiting for fixture");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
