import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import WebSocket from "ws";
import {
  ChromeExtensionBridge,
  ZENX_CHROME_EXTENSION_ORIGIN,
} from "../src/main/chrome-extension-bridge.js";
import type { UserBrowserConnection } from "../src/main/capabilities/user-browser-provider.js";
import {
  fakeBrowserInputSnapshot,
  fakeInputScreenshotData,
  waitUntil,
} from "./fixtures/user-browser-cdp.js";

interface NativeCommand {
  type: string;
  method: string;
  requestId: string;
  tabId: number;
  params: Record<string, unknown>;
}

for (const interruption of [
  "navigate",
  "cancel",
  "disconnect",
  "dialog",
] as const) {
  test(`Chrome/Edge targeted input keeps equal tab IDs and ${interruption} local to one connection`, async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "zenx-input-bridge-"),
    );
    const bridge = await ChromeExtensionBridge.start({
      runtimeDirectory: directory,
      multiInstance: true,
    });
    const sockets: WebSocket[] = [];
    const providers: UserBrowserConnection[] = [];
    try {
      const descriptor = JSON.parse(
        await readFile(path.join(directory, "chrome-bridge.json"), "utf8"),
      ) as { nativeWebSocketUrl: string };
      const connect = async (
        instanceId: string,
        browser: "chrome" | "edge",
      ) => {
        const socket = new WebSocket(descriptor.nativeWebSocketUrl, {
          origin: ZENX_CHROME_EXTENSION_ORIGIN,
        });
        sockets.push(socket);
        const commands: NativeCommand[] = [];
        const snapshot = fakeBrowserInputSnapshot();
        snapshot.documentKey = `${instanceId}|https://${browser}.test/`;
        let hook: ((command: NativeCommand) => void) | undefined;
        socket.on("message", (raw) => {
          const command = JSON.parse(raw.toString()) as NativeCommand;
          if (command.type !== "cdp-command") return;
          commands.push(command);
          hook?.(command);
          let result: unknown = {};
          if (command.method === "Page.getFrameTree")
            result = {
              frameTree: {
                frame: {
                  id: "main",
                  loaderId: "loader-1",
                  url: `https://${browser}.test/`,
                },
              },
            };
          if (command.method === "Page.createIsolatedWorld")
            result = { executionContextId: 100 };
          if (command.method === "Page.captureScreenshot")
            result = { data: fakeInputScreenshotData() };
          if (command.method === "Runtime.evaluate") {
            const expression = String(command.params.expression);
            result = {
              result: {
                value: expression.includes("visibleText:")
                  ? {
                      visibleText: browser,
                      targets: [],
                      inputSnapshot: structuredClone(snapshot),
                    }
                  : expression === "void 0"
                    ? undefined
                    : {
                        ...structuredClone(snapshot),
                        ...(expression.includes("const hit = resolveHit")
                          ? { pointerPoint: { x: 1, y: 1 } }
                          : {}),
                      },
              },
            };
          }
          if (
            command.method === "Runtime.evaluate" &&
            command.params.returnByValue === false
          )
            result = {
              result: {
                subtype: "node",
                objectId: `${instanceId}:${command.tabId}:${String(command.params.expression).includes("state?.hitNode") ? "hitNode" : "focusNode"}`,
              },
            };
          if (command.method === "DOM.describeNode")
            result = {
              node: {
                backendNodeId:
                  command.params.backendNodeId ??
                  (String(command.params.objectId).includes("hitNode")
                    ? 102
                    : 101),
                nodeType: 1,
                localName: "div",
                attributes: [],
              },
            };
          if (command.method.startsWith("Input.")) snapshot.inputRevision++;
          if (socket.readyState === WebSocket.OPEN)
            socket.send(
              JSON.stringify({
                type: "cdp-result",
                requestId: command.requestId,
                result,
              }),
            );
        });
        await new Promise<void>((resolve, reject) => {
          socket.once("open", resolve);
          socket.once("error", reject);
        });
        socket.send(
          JSON.stringify({
            type: "hello",
            protocolVersion: 3,
            scope: "browser",
            instanceId,
            browser,
          }),
        );
        socket.send(
          JSON.stringify({
            type: "browser-connected",
            tabs: [{ id: 7, title: browser, url: `https://${browser}.test/` }],
          }),
        );
        await waitUntil(() =>
          bridge
            .connections()
            .some(
              (c) => c.connectionId === instanceId && c.state === "connected",
            ),
        );
        const generation = bridge
          .connections()
          .find((c) => c.connectionId === instanceId)!.generation;
        const provider = await bridge.connectInstance(instanceId, generation);
        providers.push(provider);
        await provider.backend.listTabs("same-session");
        return {
          socket,
          commands,
          provider,
          setHook(value: typeof hook) {
            hook = value;
          },
        };
      };
      const chrome = await connect(
        "11111111-1111-4111-8111-111111111111",
        "chrome",
      );
      const edge = await connect(
        "22222222-2222-4222-8222-222222222222",
        "edge",
      );
      const [chromeObserved, edgeObserved] = await Promise.all([
        chrome.provider.backend.inspect("same-session", "chrome-tab-7"),
        edge.provider.backend.inspect("same-session", "chrome-tab-7"),
      ]);
      await Promise.all([
        chrome.provider.backend.pointerClick!(
          "same-session",
          "chrome-tab-7",
          chromeObserved.observationId,
          17,
          19,
        ),
        edge.provider.backend.keyPress!(
          "same-session",
          "chrome-tab-7",
          edgeObserved.observationId,
          "Enter",
        ),
      ]);
      assert.deepEqual(
        chrome.commands
          .filter((c) => c.method.startsWith("Input."))
          .map((c) => [c.tabId, c.params.type]),
        [
          [7, "mousePressed"],
          [7, "mouseReleased"],
        ],
      );
      assert.deepEqual(
        edge.commands
          .filter((c) => c.method.startsWith("Input."))
          .map((c) => [c.tabId, c.params.type]),
        [
          [7, "keyDown"],
          [7, "keyUp"],
        ],
      );
      const observed = await chrome.provider.backend.inspect(
        "same-session",
        "chrome-tab-7",
      );
      const controller = new AbortController();
      chrome.setHook((command) => {
        if (command.params.type !== "mousePressed") return;
        if (interruption === "cancel") controller.abort();
        if (interruption === "disconnect") chrome.socket.close();
        if (interruption === "dialog")
          chrome.socket.send(
            JSON.stringify({
              type: "cdp-event",
              tabId: 7,
              method: "Page.javascriptDialogOpening",
              params: { type: "alert", message: "fixture" },
            }),
          );
        if (interruption === "navigate")
          chrome.socket.send(
            JSON.stringify({
              type: "cdp-event",
              tabId: 7,
              method: "Page.frameStartedNavigating",
              params: { frameId: "main", url: "https://chrome.test/next" },
            }),
          );
      });
      await assert.rejects(
        chrome.provider.backend.pointerClick!(
          "same-session",
          "chrome-tab-7",
          observed.observationId,
          21,
          23,
          controller.signal,
        ),
        /outcome is unknown/,
      );
      assert.equal(
        chrome.commands.filter((c) => c.method === "Input.dispatchMouseEvent")
          .length,
        3,
        "no release or replay after the interrupted press",
      );
      await assert.rejects(
        chrome.provider.backend.inspect("same-session", "chrome-tab-7"),
        /tainted|outcome is unknown/,
      );
      const nextEdge = await edge.provider.backend.inspect(
        "same-session",
        "chrome-tab-7",
      );
      await edge.provider.backend.keyPress!(
        "same-session",
        "chrome-tab-7",
        nextEdge.observationId,
        "Tab",
      );
      assert.equal(
        edge.commands.filter((c) => c.method === "Input.dispatchKeyEvent")
          .length,
        4,
      );
      assert.ok(
        [...chrome.commands, ...edge.commands].every(
          (c) => !/activate|bringToFront/i.test(c.method),
        ),
      );
    } finally {
      await Promise.all(
        providers.map((provider) =>
          Promise.resolve(provider.backend.close()).catch(() => undefined),
        ),
      );
      for (const socket of sockets) socket.close();
      await bridge.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
}
