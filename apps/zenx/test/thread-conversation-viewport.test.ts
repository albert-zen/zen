import "./dom-primitives.js";
import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import type { Thread } from "../src/protocol-client/index.js";
import type { NativeThreadRecoverySnapshot } from "../../../src/protocol/native/recovery.js";
import { encodeModelKey } from "../../../src/protocol/codex/model-key.js";
import { ThreadConversationViewport } from "../src/renderer/src/thread-conversation-viewport.js";
import {
  emptyComposerState,
  editComposer,
  type ComposerState,
} from "../src/renderer/src/composer-state.js";
import { nativeRecoveryForThread } from "./native-recovery-fixture.js";

function recovery(id: string) {
  return nativeRecoveryForThread({
    id,
    sessionId: id,
    forkedFromId: null,
    parentThreadId: null,
    preview: "",
    ephemeral: false,
    isPinned: false,
    modelProvider: "fake",
    createdAt: 10,
    updatedAt: 10,
    recencyAt: null,
    status: { type: "idle" },
    path: null,
    cwd: "/workspace",
    cliVersion: "zen/0.1.0",
    source: "appServer",
    threadSource: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: null,
    turns: [],
  } satisfies Thread);
}
function model() {
  return {
    id: encodeModelKey({ providerProfileId: "fake", modelId: "fake" }),
    model: "fake",
    upgrade: null,
    upgradeInfo: null,
    availabilityNux: null,
    displayName: "Demo",
    description: "",
    hidden: false,
    supportedReasoningEfforts: [
      { reasoningEffort: "medium", description: "medium" },
    ],
    defaultReasoningEffort: "medium",
    inputModalities: ["text" as const],
    supportsPersonality: false as const,
    additionalSpeedTiers: [],
    serviceTiers: [],
    defaultServiceTier: null,
    isDefault: true,
  };
}

async function harness(
  run: (h: {
    render(ids: string[]): Promise<void>;
    resolve(id: string): Promise<void>;
    notify(
      id: string,
      watermark: number,
      event: unknown,
      epoch?: string,
    ): Promise<void>;
    states: Map<string, ComposerState>;
    sent: { id: string; text: string }[];
  }) => Promise<void>,
) {
  const previous = { window: globalThis.window, document: globalThis.document };
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
  const pending = new Map<
    string,
    (value: NativeThreadRecoverySnapshot) => void
  >();
  const listeners = new Set<(method: string, params: unknown) => void>();
  Object.defineProperty(dom.window, "zenx", {
    value: {
      platform: "darwin",
      protocol: {
        request: async (method: string, params: { threadId: string }) => {
          assert.equal(method, "zen/thread/resume");
          return await new Promise<NativeThreadRecoverySnapshot>((resolve) =>
            pending.set(params.threadId, resolve),
          );
        },
        onNotification: (
          listener: (method: string, params: unknown) => void,
        ) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
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
  const root = createRoot(document.getElementById("root")!);
  const states = new Map<string, ComposerState>();
  const sent: { id: string; text: string }[] = [];
  const serverStatus = { type: "ready" as const, reconnected: false };
  let shown: string[] = [];
  function draw() {
    root.render(
      React.createElement(
        React.Fragment,
        {},
        ...shown.map((id, index) =>
          React.createElement(ThreadConversationViewport, {
            key: index,
            threadId: id,
            composer: states.get(id) ?? emptyComposerState(),
            readComposer: () => states.get(id) ?? emptyComposerState(),
            updateComposer: (change) => {
              states.set(id, change(states.get(id) ?? emptyComposerState()));
              draw();
            },
            deliver: async (submission) => {
              sent.push({ id, text: submission.text });
            },
            cancelQueued: async () => ({ results: [] }),
            onOpenMessageLink: () => {},
            models: [model()],
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
    );
  }
  try {
    await run({
      states,
      sent,
      render: async (ids) => {
        shown = ids;
        await act(async () => draw());
      },
      resolve: async (id) => {
        assert.ok(pending.has(id));
        await act(async () => {
          pending.get(id)!(recovery(id));
        });
      },
      notify: async (id, watermark, event, epoch = "test-process-epoch") => {
        await act(async () => {
          for (const listener of listeners)
            listener("zen/thread/event", {
              threadId: id,
              processEpoch: epoch,
              watermark,
              event,
            });
        });
      },
    });
  } finally {
    await act(async () => root.unmount());
    assert.equal(listeners.size, 0);
    Object.assign(globalThis, previous, {
      IS_REACT_ACT_ENVIRONMENT: undefined,
    });
    dom.window.close();
  }
}

test("late resume from a previously selected child cannot replace the current viewport or its draft", async () => {
  await harness(async (h) => {
    h.states.set("a", editComposer(emptyComposerState(), "draft a"));
    h.states.set("b", editComposer(emptyComposerState(), "draft b"));
    await h.render(["a"]);
    await h.render(["b"]);
    await h.resolve("b");
    assert.equal(
      document.querySelector<HTMLTextAreaElement>("textarea")?.value,
      "draft b",
    );
    await h.resolve("a");
    assert.equal(document.querySelector("textarea")?.id, "side-composer-b");
    assert.equal(
      document.querySelector<HTMLTextAreaElement>("textarea")?.value,
      "draft b",
    );
    assert.equal(h.states.get("a")?.draft.text, "draft a");
  });
});

test("simultaneous viewports keep distinct composer labels and deliver to the chosen child", async () => {
  await harness(async (h) => {
    h.states.set("parent", editComposer(emptyComposerState(), "parent draft"));
    h.states.set("child", editComposer(emptyComposerState(), "child draft"));
    await h.render(["parent", "child"]);
    await h.resolve("parent");
    await h.resolve("child");
    assert.ok(document.getElementById("side-composer-parent"));
    assert.ok(document.getElementById("side-composer-child"));
    const child = document.getElementById(
      "side-composer-child",
    ) as HTMLTextAreaElement;
    await act(async () =>
      child.dispatchEvent(
        new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      ),
    );
    assert.deepEqual(h.sent, [{ id: "child", text: "child draft" }]);
    assert.equal(h.states.get("parent")?.draft.text, "parent draft");
  });
});

test("events arriving during resume replay once; stale process and foreign Thread events are ignored", async () => {
  await harness(async (h) => {
    await h.render(["child"]);
    const started = {
      type: "turn_started",
      threadId: "child",
      turnId: "turn-1",
    };
    const completed = (text: string) => ({
      type: "item_completed",
      item: {
        type: "agent_message",
        id: "reply-1",
        threadId: "child",
        turnId: "turn-1",
        createdAt: new Date(20000).toISOString(),
        text,
      },
    });
    await h.notify("child", 1, started);
    await h.notify("child", 2, completed("buffered reply"));
    await h.resolve("child");
    assert.ok(document.body.textContent?.includes("buffered reply"));
    await h.notify("child", 2, completed("duplicate overwritten reply"));
    await h.notify("foreign", 3, completed("wrong Thread reply"));
    await h.notify("child", 4, completed("wrong process reply"), "old-process");
    assert.ok(document.body.textContent?.includes("buffered reply"));
    assert.doesNotMatch(
      document.body.textContent ?? "",
      /duplicate overwritten|wrong Thread|wrong process/,
    );
  });
});
