import { ToolEnvironment, InMemoryToolPolicyStore } from "../../../src/tool.js";
import { BrowserBackendRegistry } from "../src/main/capabilities/browser-backend-registry.js";
import { ZenXHostToolBundle } from "../src/main/capability-tool-executor.js";
import type { ZenXBrowserBackend } from "../src/main/capabilities/browser-provider.js";
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

const chromeId = "11111111-1111-4111-8111-111111111111";
const edgeId = "22222222-2222-4222-8222-222222222222";

test("instance bridge keeps equal tab IDs and pending commands local to Chrome and Edge", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "zenx-instances-"));
  const bridge = await ChromeExtensionBridge.start({
    runtimeDirectory: root,
    multiInstance: true,
  });
  const sockets: WebSocket[] = [];
  const providers: Array<{ backend: { close(): void | Promise<void> } }> = [];
  try {
    const descriptor = JSON.parse(
      await readFile(path.join(root, "chrome-bridge.json"), "utf8"),
    );
    async function connect(id: string, browser: "chrome" | "edge") {
      const socket = new WebSocket(descriptor.nativeWebSocketUrl, {
        origin: ZENX_CHROME_EXTENSION_ORIGIN,
      });
      sockets.push(socket);
      const messages: Record<string, any>[] = [];
      socket.on("message", (data) => {
        const message = JSON.parse(data.toString());
        messages.push(message);
        if (
          message.type === "cdp-command" &&
          message.method !== "Page.navigate"
        )
          socket.send(
            JSON.stringify({
              type: "cdp-result",
              requestId: message.requestId,
              result: {},
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
          instanceId: id,
          browser,
        }),
      );
      await until(() =>
        messages.some(
          (message) =>
            message.type === "ready" || message.type === "connection-rejected",
        ),
      );
      if (messages.some((message) => message.type === "ready")) {
        socket.send(
          JSON.stringify({
            type: "browser-connected",
            tabs: [{ id: 7, title: browser, url: `https://${browser}.test/` }],
          }),
        );
        await until(() =>
          bridge
            .connections()
            .some(
              (entry) =>
                entry.connectionId === id && entry.state === "connected",
            ),
        );
      }
      return { socket, messages };
    }
    const chrome = await connect(chromeId, "chrome");
    const edge = await connect(edgeId, "edge");
    const catalog = bridge.connections();
    assert.equal(catalog.length, 2);
    assert.doesNotMatch(JSON.stringify(catalog), /https:|\.test|title/);
    const chromeGeneration = catalog.find(
      (entry) => entry.connectionId === chromeId,
    )!.generation;
    const edgeGeneration = catalog.find(
      (entry) => entry.connectionId === edgeId,
    )!.generation;
    const a = await bridge.connectInstance(chromeId, chromeGeneration);
    const b = await bridge.connectInstance(edgeId, edgeGeneration);
    providers.push(a, b);
    assert.equal((await a.backend.listTabs("same"))[0]!.title, "chrome");
    assert.equal((await b.backend.listTabs("same"))[0]!.title, "edge");
    const first = a.backend.navigate(
      "same",
      "chrome-tab-7",
      "https://chrome.test/next",
    );
    const second = b.backend.navigate(
      "same",
      "chrome-tab-7",
      "https://edge.test/next",
    );
    await until(
      () =>
        chrome.messages.some((message) => message.method === "Page.navigate") &&
        edge.messages.some((message) => message.method === "Page.navigate"),
    );
    const ca = chrome.messages.find(
      (message) => message.method === "Page.navigate",
    )!;
    const cb = edge.messages.find(
      (message) => message.method === "Page.navigate",
    )!;
    edge.socket.send(
      JSON.stringify({
        type: "cdp-result",
        requestId: ca.requestId,
        result: { targetId: "crossed" },
      }),
    );
    chrome.socket.send(
      JSON.stringify({
        type: "cdp-result",
        requestId: ca.requestId,
        result: { targetId: "chrome-only" },
      }),
    );
    edge.socket.send(
      JSON.stringify({
        type: "cdp-result",
        requestId: cb.requestId,
        result: { targetId: "edge-only" },
      }),
    );
    assert.deepEqual(
      (await Promise.all([first, second])).map((tab) => tab.url),
      ["https://chrome.test/next", "https://edge.test/next"],
    );
    // The real bridge, Registry, Host projection and Core admission operate together.
    const unused = async () => {
      throw new Error("unused fixture action");
    };
    const workspace: ZenXBrowserBackend = {
      listTabs: async (sessionId) => [
        {
          sessionId,
          tabId: "chrome-tab-7",
          title: "Workspace",
          url: "https://workspace.test/",
          loading: false,
        },
      ],
      open: unused,
      navigate: unused,
      inspect: unused,
      click: unused,
      type: unused,
      closeTab: () => {},
      closeSession: () => 0,
      close: () => {},
    };
    const registry = new BrowserBackendRegistry(
      workspace,
      undefined,
      undefined,
      bridge,
    );
    const names: string[] = [];
    const bundle = new ZenXHostToolBundle({
      capabilities: {
        definitions: registry.manifest.tools.map(
          ({ name, description, inputSchema }) => ({
            name,
            description,
            inputSchema,
          }),
        ),
        browserConnections: bridge.connections(),
      },
      send: (event) => {
        if (event.type !== "capability/invoke") return;
        void registry
          .invoke(event.invocation.name, {
            ...event.invocation,
            signal: new AbortController().signal,
          })
          .then(
            (result) =>
              bundle.handleResult({
                type: "capability/result",
                invocationId: event.invocationId,
                generationToken: event.generationToken,
                output: JSON.stringify(result),
                exitCode: 0,
              }),
            (error) =>
              bundle.handleResult({
                type: "capability/result",
                invocationId: event.invocationId,
                generationToken: event.generationToken,
                error: String(error),
              }),
          );
      },
    });
    const environment = new ToolEnvironment({
      runtimes: [],
      bundles: [bundle],
      policyStore: new InMemoryToolPolicyStore({
        browser_connected_list_tabs: "approved",
      }),
    });
    try {
      const run = async (name: string, arguments_: Record<string, unknown>) => {
        const signal = new AbortController().signal;
        const prepared = environment.prepare({
          name,
          arguments: { sessionId: "agent", ...arguments_ },
          callId: name,
          threadId: "agent-thread",
          cwd: root,
          signal,
        });
        await environment.admit(prepared, {
          policy: "ask_unknown",
          approvalRequest: {
            threadId: "agent-thread",
            turnId: "turn",
            itemId: "item",
            callId: name,
            command: name,
            cwd: root,
            signal,
          },
          requestApproval: async (request) => {
            names.push(request.command);
            return "accept";
          },
        });
        return JSON.parse((await environment.execute(prepared)).output);
      };
      const w = await run("browser_workspace_list_tabs", {});
      const x = await run("browser_connected_list_tabs", {
        connectionId: chromeId,
      });
      const y = await run("browser_connected_list_tabs", {
        connectionId: edgeId,
      });
      assert.deepEqual(
        [w[0].title, x[0].title, y[0].title],
        ["Workspace", "chrome", "edge"],
      );
      assert.equal(new Set([w[0].tabId, x[0].tabId, y[0].tabId]).size, 3);
      assert.equal(names.length, 3);
      assert.ok(names.some((name) => name.includes("Chrome · 11111111")));
      assert.ok(names.some((name) => name.includes("Edge · 22222222")));
    } finally {
      await environment.close();
      await registry.close();
    }

    const duplicate = await connect(chromeId, "edge");
    assert.equal(duplicate.messages[0]?.type, "connection-rejected");
    assert.equal((await a.backend.listTabs("same"))[0]!.title, "chrome");
    chrome.socket.close();
    await until(
      () =>
        !bridge
          .connections()
          .some(
            (entry) =>
              entry.connectionId === chromeId && entry.state === "connected",
          ),
    );
    assert.equal((await b.backend.listTabs("same"))[0]!.title, "edge");
    await connect(chromeId, "chrome");
    await assert.rejects(
      bridge.connectInstance(chromeId, chromeGeneration),
      /generation|connection.*changed/i,
    );
    await assert.rejects(
      bridge.connectProvider(),
      /explicit|instance|connectionId/i,
    );
  } finally {
    for (const provider of providers) await provider.backend.close();
    for (const socket of sockets) socket.close();
    await bridge.close();
    await rm(root, { recursive: true, force: true });
  }
});

async function until(predicate: () => boolean) {
  for (let i = 0; i < 200; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for instance fixture");
}
