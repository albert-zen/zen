import "./dom-primitives.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { ZenAppServer } from "../../../src/app-server.js";
import { InMemoryThreadJournal } from "../../../src/journal.js";
import { InMemoryThreadMetadataStore } from "../../../src/thread-metadata.js";
import { StaticModelCatalog } from "../../../src/model-catalog.js";
import { ProviderRegistry } from "../../../src/provider-registry.js";
import { AgentRuntime } from "../../../src/runtime.js";
import { ToolEnvironment } from "../../../src/tool.js";
import { NativeRecoveryProjection } from "../../../src/protocol/native/recovery.js";
import { latestTurnEnd, turnEndPosition } from "../../../src/turn-end.js";
import { createThreadEndNotificationObserver } from "../src/renderer/src/thread-end-notifications.js";
import { ThreadView } from "../src/renderer/src/ThreadView.js";
import { emptyComposerState } from "../src/renderer/src/composer-state.js";
import {
  CONVERSATION_READ_KEY,
  conversationReadStore,
  createConversationReadStore,
  unreadThreadIds,
} from "../src/renderer/src/conversation-read-state.js";
import {
  applyNativeThreadEvent,
  markThreadViewAwaitingRecovery,
  projectNativeRecovery,
} from "../src/renderer/src/thread-view-state.js";

import { Sidebar } from "../src/renderer/src/Sidebar.js";
import { threadEndSidebarProps } from "./fixtures/thread-end-sidebar.js";
const noop = async () => {};
function bounds(top: number, bottom: number): DOMRect {
  return {
    top,
    bottom,
    left: 0,
    right: 500,
    x: 0,
    y: top,
    width: 500,
    height: bottom - top,
    toJSON: () => ({}),
  };
}

for (const outcome of ["normal", "empty", "failed", "aborted"] as const) {
  test(`actual ${outcome} execution end is unread until its visible Turn tail is read`, async () => {
    const dom = new JSDOM('<div id="root"></div><div id="sidebar"></div>', {
      url: "http://localhost",
      pretendToBeVisual: true,
    });
    Object.assign(globalThis, {
      window: dom.window,
      document: dom.window.document,
      IS_REACT_ACT_ENVIRONMENT: true,
    });
    window.localStorage.setItem(
      CONVERSATION_READ_KEY,
      JSON.stringify({
        baseline: 0,
        threadEndBaseline: 0,
        threads: {},
        rooms: {},
      }),
    );
    let focused = false;
    let hidden = false;
    let tail = 300;
    Object.defineProperty(document, "hasFocus", {
      configurable: true,
      value: () => focused,
    });
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => (hidden ? "hidden" : "visible"),
    });
    dom.window.HTMLElement.prototype.getBoundingClientRect = function () {
      if (this.classList.contains("bottom-zone")) return bounds(500, 600);
      if (this.classList.contains("turn")) return bounds(50, tail);
      return bounds(0, 500);
    };
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const server = new ZenAppServer({
      journal: new InMemoryThreadJournal(),
      threadMetadata: new InMemoryThreadMetadataStore(),
      runtime: new AgentRuntime({
        toolEnvironment: new ToolEnvironment({ runtimes: [] }),
      }),
      providerRegistry: new ProviderRegistry([
        {
          providerProfileId: "fixture",
          modelCatalog: new StaticModelCatalog([
            { id: "fixture", isDefault: true, contextWindow: 32768 },
          ]),
          adapter: {
            provider: "fixture",
            async *stream(request) {
              enter();
              await Promise.race([
                released,
                new Promise<void>((resolve, reject) => {
                  if (request.signal.aborted) reject(request.signal.reason);
                  else
                    request.signal.addEventListener(
                      "abort",
                      () => reject(request.signal.reason),
                      { once: true },
                    );
                }),
              ]);
              if (outcome === "failed")
                throw new Error("Synthetic provider failure");
              if (outcome === "normal")
                yield { type: "text_delta", delta: "A complete reply." };
            },
          },
        },
      ]),
      defaults: {
        cwd: process.cwd(),
        providerProfileId: "fixture",
        modelId: "fixture",
        reasoningEffort: "medium",
        sandbox: "read-only",
        approvalPolicy: "never",
      },
    });
    const recovery = new NativeRecoveryProjection(server);
    const started = await server.startThread();
    let live = projectNativeRecovery(await recovery.resume(started.id));
    const unsubscribe = server.subscribe((event) => {
      live = applyNativeThreadEvent(live, event);
    });
    const root = createRoot(document.getElementById("root")!);
    const sidebarRoot = createRoot(document.getElementById("sidebar")!);
    const flush = async () => {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
      });
    };
    const render = async () => {
      await act(async () =>
        root.render(
          React.createElement(ThreadView, {
            thread: live,
            approvals: [],
            composer: emptyComposerState(),
            onDraftChange: () => {},
            onInterrupt: noop,
            onRespondToApproval: noop,
            onSubmit: noop,
          }),
        ),
      );
      await flush();
      const summaries = await server.listThreadSummaries();
      await act(async () =>
        sidebarRoot.render(
          React.createElement(
            Sidebar,
            threadEndSidebarProps(
              summaries,
              unreadThreadIds(summaries, conversationReadStore().getSnapshot()),
            ),
          ),
        ),
      );
    };
    const seen = () =>
      conversationReadStore().getSnapshot().threads[started.id];
    try {
      const turn = await server.startTurn(started.id, "Synthetic request");
      await entered;
      await render();
      assert.equal(
        document.querySelector("section.turn[data-read-message-id]"),
        null,
      );
      assert.equal(seen(), undefined);
      assert.equal(
        unreadThreadIds(
          await server.listThreadSummaries(),
          conversationReadStore().getSnapshot(),
        ).size,
        0,
      );
      const disconnected = markThreadViewAwaitingRecovery(live);
      assert.equal(
        latestTurnEnd(disconnected.canonicalItems ?? []),
        undefined,
        "an optimistic interrupted view is not a durable end",
      );
      if (outcome === "aborted")
        await server.interruptTurn(started.id, turn.id);
      else release();
      await turn.done;
      const terminal = latestTurnEnd(live.canonicalItems ?? [])!;
      assert(
        terminal,
        "the live native stream carries the committed terminal Item without reloading",
      );
      const beforeDuplicate = live.canonicalItems?.length;
      live = applyNativeThreadEvent(live, {
        type: "item_completed",
        item: terminal,
      });
      assert.equal(
        live.canonicalItems?.length,
        beforeDuplicate,
        "replayed terminal events are idempotent",
      );
      const snapshot = projectNativeRecovery(await recovery.resume(started.id));
      assert.deepEqual(latestTurnEnd(snapshot.canonicalItems ?? []), terminal);
      const summaries = await server.listThreadSummaries();
      assert.equal(
        unreadThreadIds(summaries, conversationReadStore().getSnapshot()).size,
        1,
      );
      await render();
      assert.equal(
        document
          .querySelector("section.turn")
          ?.getAttribute("data-read-message-id"),
        terminal.id,
      );
      assert.equal(seen(), undefined, "opening while unfocused does not read");
      assert.equal(
        document.querySelectorAll(".thread-unread-failed").length,
        outcome === "failed" ? 1 : 0,
      );
      assert.equal(
        document.querySelectorAll(".thread-unread-dot").length,
        outcome === "failed" ? 0 : 1,
      );
      focused = true;
      hidden = true;
      window.dispatchEvent(new dom.window.Event("focus"));
      await flush();
      assert.equal(seen(), undefined, "hidden view does not read");
      hidden = false;
      tail = 700;
      document.dispatchEvent(new dom.window.Event("visibilitychange"));
      await flush();
      assert.equal(
        seen(),
        undefined,
        "the actual end below the viewport is unseen",
      );
      tail = 300;
      document
        .querySelector(".messages")!
        .dispatchEvent(new dom.window.Event("scroll"));
      await flush();
      assert.equal(seen()?.id, terminal.id);
      assert.equal(
        unreadThreadIds(summaries, conversationReadStore().getSnapshot()).size,
        0,
      );
      live = snapshot;
      await render();
      assert.equal(
        document.querySelector(".thread-unread-failed, .thread-unread-dot"),
        null,
        "reading the real terminal Turn clears the production Sidebar marker after recovery",
      );
      assert.equal(
        seen()?.id,
        terminal.id,
        "reload keeps the same read watermark",
      );
    } finally {
      release();
      await act(async () => {
        root.unmount();
        sidebarRoot.unmount();
      });
      unsubscribe();
      recovery.close();
      dom.window.close();
    }
  });
}

test("real later execution ends notify and advance read state after wall-clock rollback", async () => {
  let time = 150;
  const now = () => new Date(time).toISOString();
  const server = new ZenAppServer({
    now,
    journal: new InMemoryThreadJournal(),
    threadMetadata: new InMemoryThreadMetadataStore(),
    runtime: new AgentRuntime({
      now,
      toolEnvironment: new ToolEnvironment({ runtimes: [] }),
    }),
    providerRegistry: new ProviderRegistry([
      {
        providerProfileId: "fixture",
        modelCatalog: new StaticModelCatalog([
          { id: "fixture", isDefault: true, contextWindow: 32768 },
        ]),
        adapter: {
          provider: "fixture",
          async *stream() {
            yield {
              type: "text_delta",
              delta: "Synthetic reply or compaction summary",
            };
          },
        },
      },
    ]),
    defaults: {
      cwd: process.cwd(),
      providerProfileId: "fixture",
      modelId: "fixture",
      reasoningEffort: "medium",
      sandbox: "read-only",
      approvalPolicy: "never",
    },
  });
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
  const store = createConversationReadStore(storage, 200);
  const thread = await server.startThread();
  const recovery = new NativeRecoveryProjection(server);
  const observer = createThreadEndNotificationObserver(store, async () => ({
    processEpoch: recovery.processEpoch,
  }));
  await observer.connect();
  const stopObserving = recovery.subscribe((event) => {
    if (event.type === "thread_event") observer.observe(event.event);
  });
  let live = projectNativeRecovery(await recovery.resume(thread.id));
  const unsubscribe = server.subscribe((event) => {
    live = applyNativeThreadEvent(live, event);
  });
  await (
    await server.startTurn(thread.id, "first")
  ).done;
  const first = (await server.listThreadSummaries())[0]!;
  assert(first.status === "idle" && first.lastTurnEnd);
  const firstEnd = first.lastTurnEnd;
  assert.equal(
    unreadThreadIds([first], store.getSnapshot()).size,
    1,
    "a newly observed execution end after clock rollback is not old installation history",
  );
  assert.equal(
    unreadThreadIds(
      [first],
      createConversationReadStore(storage, 1000).getSnapshot(),
    ).size,
    1,
    "observed unread identity survives a window restart without a timestamp guess",
  );
  store.advance("threads", thread.id, {
    ...firstEnd,
    createdAt: Date.parse(firstEnd.createdAt),
  });
  await server.compactThread(thread.id, { includeOriginalReference: false });
  assert(
    live.canonicalItems?.some((item) => item.type === "context_compaction"),
  );
  assert.equal(
    turnEndPosition(live.canonicalItems!, latestTurnEnd(live.canonicalItems!)!),
    firstEnd.position,
  );
  time = 100;
  await (
    await server.startTurn(thread.id, "second after clock rollback")
  ).done;
  const second = (await server.listThreadSummaries())[0]!;
  assert(second.status === "idle" && second.lastTurnEnd);
  const secondEnd = second.lastTurnEnd;
  assert.equal(firstEnd.position, 0);
  assert.equal(
    secondEnd.position,
    1,
    "compaction and metadata do not change end ordinals",
  );
  assert.equal(
    turnEndPosition(live.canonicalItems!, latestTurnEnd(live.canonicalItems!)!),
    secondEnd.position,
  );
  const resumed = projectNativeRecovery(await recovery.resume(thread.id));
  assert.equal(
    turnEndPosition(
      resumed.canonicalItems!,
      latestTurnEnd(resumed.canonicalItems!)!,
    ),
    secondEnd.position,
  );
  assert.equal(
    unreadThreadIds([second], store.getSnapshot()).size,
    1,
    "canonical later end cannot disappear behind the old timestamp",
  );
  store.advance(
    "threads",
    thread.id,
    { ...secondEnd, createdAt: Date.parse(secondEnd.createdAt) },
    [firstEnd.id, secondEnd.id],
  );
  const reloaded = createConversationReadStore(storage, 1000);
  assert.equal(reloaded.getSnapshot().threads[thread.id]?.id, secondEnd.id);
  assert.equal(unreadThreadIds([second], reloaded.getSnapshot()).size, 0);
  assert.equal(
    unreadThreadIds([first], reloaded.getSnapshot()).size,
    0,
    "a stale earlier summary cannot relight",
  );
  reloaded.advance(
    "threads",
    thread.id,
    { ...firstEnd, createdAt: Date.parse(firstEnd.createdAt) },
    [firstEnd.id],
  );
  assert.equal(
    reloaded.getSnapshot().threads[thread.id]?.id,
    secondEnd.id,
    "a stale viewport cannot regress the cursor",
  );
  unsubscribe();
  const fork = await server.forkThread({
    sourceThreadId: thread.id,
    through: { type: "latest-complete" },
    workspace: { type: "same-directory" },
  });
  live = projectNativeRecovery(await recovery.resume(fork.id));
  assert.equal(latestTurnEnd(live.canonicalItems!), undefined);
  const stopFork = server.subscribe((event) => {
    live = applyNativeThreadEvent(live, event);
  });
  await (
    await server.startTurn(fork.id, "fork local execution")
  ).done;
  const forkSummary = (await server.listThreadSummaries()).find(
    (entry) => entry.threadId === fork.id,
  )!;
  assert(forkSummary.status === "idle" && forkSummary.lastTurnEnd);
  const forkEnd = latestTurnEnd(live.canonicalItems!)!;
  assert.equal(forkSummary.lastTurnEnd.id, forkEnd.id);
  assert.equal(
    forkSummary.lastTurnEnd.position,
    2,
    "inherited ends occupy fixed ordinal slots but never notify themselves",
  );
  assert.equal(
    turnEndPosition(live.canonicalItems!, forkEnd),
    forkSummary.lastTurnEnd.position,
  );
  const forkRecovery = projectNativeRecovery(await recovery.resume(fork.id));
  assert.equal(
    turnEndPosition(
      forkRecovery.canonicalItems!,
      latestTurnEnd(forkRecovery.canonicalItems!)!,
    ),
    forkSummary.lastTurnEnd.position,
  );
  stopFork();
  stopObserving();
  observer.disconnect();
  recovery.close();
});
