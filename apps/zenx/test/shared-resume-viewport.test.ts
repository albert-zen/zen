import "./dom-primitives.js";
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { createHostedAppServer } from "../../../apps/cli/src/host.js";
import { InMemoryThreadJournal } from "../../../src/journal.js";
import { InMemoryThreadMetadataStore } from "../../../src/thread-metadata.js";
import { serveCodexWebSocket } from "../../../src/protocol/codex/websocket.js";
import { AppServerManager } from "../src/main/app-server-manager.js";
import { ThreadConversationViewport } from "../src/renderer/src/thread-conversation-viewport.js";
import { emptyComposerState } from "../src/renderer/src/composer-state.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test(
  "background manager resume cannot hide a completed input from two already-mounted same-thread viewports",
  { timeout: 15000 },
  async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "zenx-shared-viewport-"),
    );
    const metadata = new InMemoryThreadMetadataStore();
    const hostConfig = {
      cwd: directory,
      dataDirectory: directory,
      model: "fake",
      models: ["fake"],
      approvalPolicy: "never" as const,
      provider: { type: "fake" as const },
    };
    const host = createHostedAppServer({
      ...hostConfig,
      journal: new InMemoryThreadJournal(),
      threadMetadata: metadata,
      toolPresentation: "direct",
    });
    const server = await serveCodexWebSocket({
      appServer: host,
      zenHome: directory,
      listen: "ws://127.0.0.1:0",
    });
    // Only the process-ready/shutdown handshake is a fixture. The production
    // manager, WebSocket client/server, recovery barrier and Host are unmodified.
    // Keeping Host in this process allows a deterministic real metadata-read gate.
    const entry = path.join(directory, "ready-fixture.mjs");
    await writeFile(
      entry,
      `process.on("message", m => { if (m.type === "start") process.send({type:"ready",url:${JSON.stringify(server.url)},processEpoch:${JSON.stringify(host.processEpoch)}}); if (m.type === "shutdown") process.disconnect(); });`,
    );
    const manager = new AppServerManager({
      entryPath: entry,
      tokenFile: path.join(directory, "token"),
      hostConfig,
      execArgv: [],
      shutdownGraceMs: 1000,
      terminationGraceMs: 1000,
    });
    const previous = {
      window: globalThis.window,
      document: globalThis.document,
    };
    const dom = new JSDOM("<div id='root'></div>", { url: "http://localhost" });
    Object.assign(globalThis, {
      window: dom.window,
      document: dom.window.document,
      IS_REACT_ACT_ENVIRONMENT: true,
    });
    Object.assign(dom.window.HTMLElement.prototype, {
      attachEvent() {},
      detachEvent() {},
    });
    const root = createRoot(document.getElementById("root")!);
    const gate = deferred();
    try {
      await manager.start();
      const thread = await host.startThread();
      const firstReady = deferred();
      const ready = deferred();
      let recovered = 0;
      Object.defineProperty(dom.window, "zenx", {
        value: {
          platform: "darwin",
          protocol: {
            request: manager.request.bind(manager),
            onNotification: manager.onNotification.bind(manager),
          },
          imageAttachments: { forThread: async () => ({}) },
          modelUsage: {
            forThread: async () => ({
              thread: { responseCount: 0, inputTokens: 0, outputTokens: 0 },
              turns: {},
              context: {
                inputTokens: null,
                inputTokenSource: null,
                contextWindow: null,
                ratio: null,
              },
            }),
          },
        },
      });
      const composer = emptyComposerState();
      const serverStatus = { type: "ready" as const, reconnected: false };
      const draw = (names: string[]) => {
        root.render(
          React.createElement(
            React.Fragment,
            {},
            ...names.map((name) =>
              React.createElement(
                "section",
                { key: name, "data-consumer": name },
                React.createElement(ThreadConversationViewport, {
                  threadId: thread.id,
                  onRecovery: () => {
                    recovered++;
                    if (recovered === 1) firstReady.resolve();
                    if (recovered === 2) ready.resolve();
                  },
                  composer,
                  readComposer: () => composer,
                  updateComposer: () => {},
                  deliver: async () => {},
                  cancelQueued: async () => ({ results: [] }),
                  onOpenMessageLink: () => {},
                  models: [],
                  providerProfiles: [],
                  serverStatus,
                  approvals: [],
                  respondToApproval: async () => {},
                  pluginSnapshot: null,
                  composerSendMode: "soft",
                  onComposerSendModeChange: async () => {},
                  workflowCommands: [],
                }),
              ),
            ),
          ),
        );
      };
      await act(async () => {
        draw(["main"]);
      });
      await act(async () => {
        await firstReady.promise;
      });
      await act(async () => {
        draw(["main", "side"]);
      });
      await act(async () => {
        await ready.promise;
      });
      assert.equal(recovered, 2);
      const read = metadata.read.bind(metadata);
      const entered = deferred();
      let armed = true;
      metadata.read = async (id) => {
        if (armed && id === thread.id) {
          armed = false;
          entered.resolve();
          await gate.promise;
        }
        return await read(id);
      };
      const background = manager.request("zen/thread/resume", {
        threadId: thread.id,
      });
      await entered.promise;
      await (
        await host.startTurn(thread.id, "SHARED_RESUME_VISIBLE_INPUT")
      ).done;
      assert.doesNotMatch(
        document.body.textContent ?? "",
        /SHARED_RESUME_VISIBLE_INPUT/,
      );
      await act(async () => {
        gate.resolve();
        await background;
      });
      for (const name of ["main", "side"]) {
        const section = document.querySelector(`[data-consumer="${name}"]`)!;
        assert.equal(
          [...section.querySelectorAll(".user-bubble")].filter(
            (bubble) => bubble.textContent === "SHARED_RESUME_VISIBLE_INPUT",
          ).length,
          1,
        );
      }
      assert.equal(
        recovered,
        2,
        "existing viewports did not need a new recovery, remount or focus event",
      );
      await act(async () => {
        await manager.request("zen/thread/resume", { threadId: thread.id });
      });
      assert.equal(
        [...document.querySelectorAll(".user-bubble")].filter(
          (bubble) => bubble.textContent === "SHARED_RESUME_VISIBLE_INPUT",
        ).length,
        2,
      );
    } finally {
      gate.resolve();
      await act(async () => root.unmount());
      await manager.stop();
      await server.close();
      await host.closeHostResources();
      dom.window.close();
      Object.assign(globalThis, previous);
      await rm(directory, { recursive: true, force: true });
    }
  },
);
