import "./dom-primitives.js";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { AppServerManager } from "../src/main/app-server-manager.js";
import {
  replayThreadProjection,
  updateThreadProjectionCache,
} from "../src/renderer/src/App.js";
import { projectNativeRecovery } from "../src/renderer/src/thread-view-state.js";
import { settingsFromSnapshot } from "../src/renderer/src/model-settings.js";
import {
  ThreadView,
  MessageForkContext,
} from "../src/renderer/src/ThreadView.js";
import { emptyComposerState } from "../src/renderer/src/composer-state.js";
import { parseSkillDraft } from "../src/renderer/src/skill-draft.js";
import type { Thread } from "../src/protocol-client/index.js";

test("real Host first-turn native projection owns quote/fork and Debug through compaction and restart", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-live-message-provenance-"),
  );
  const manager = new AppServerManager({
    entryPath: fileURLToPath(
      new URL("../src/main/app-server-host.ts", import.meta.url),
    ),
    tokenFile: path.join(directory, "app-server.token"),
    hostConfig: {
      cwd: directory,
      dataDirectory: path.join(directory, "data"),
      model: "fake",
      models: ["fake"],
      approvalPolicy: "never",
      provider: { type: "fake" },
      toolPresentation: "both",
    },
    execArgv: ["--import", "tsx"],
    startupTimeoutMs: 10_000,
  });
  let dispose = () => {};
  try {
    await writeFile(
      path.join(directory, "sample.json"),
      '{"values":[1,2,3,4]}',
    );
    await manager.start();
    const started = await manager.request("thread/start", {
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    });
    assert.equal(
      started.thread.canonicalItems,
      undefined,
      "creation returns a compatibility view, not quote authority",
    );
    const threadId = started.thread.id;
    const settings = settingsFromSnapshot(threadId, started);
    const cache = new Map([
      [threadId, replayThreadProjection(started.thread, settings, [])],
    ]);
    let finish!: () => void;
    const completed = new Promise<void>((resolve) => {
      finish = resolve;
    });
    dispose = manager.onNotification((method, params) => {
      if (method !== "zen/thread/event") return;
      const notification = { method, params } as Parameters<
        typeof updateThreadProjectionCache
      >[1];
      updateThreadProjectionCache(cache, notification);
      if (
        notification.method === "zen/thread/event" &&
        notification.params.threadId === threadId &&
        notification.params.event.type === "turn_completed"
      )
        finish();
    });
    const recovered = await manager.request("zen/thread/resume", { threadId });
    cache.set(
      threadId,
      replayThreadProjection(
        projectNativeRecovery(recovered),
        settings,
        cache.get(threadId)!.activeTurnNotifications,
        recovered,
      ),
    );
    await manager.request("zen/turn/send", {
      threadId,
      mode: "start",
      clientUserMessageId: "synthetic-first-input",
      input: [
        {
          type: "text",
          text: `!tool run_code ${JSON.stringify({ code: "const r = await tools.shell({command: 'cat sample.json'}); text({sum: JSON.parse(r.output).values.reduce((a,b)=>a+b,0)});" })}`,
        },
      ],
    });
    await within(completed);
    const live = cache.get(threadId)!;
    const message = live.thread.canonicalItems?.findLast(
      (item) => item.type === "agent_message",
    );
    assert.ok(message?.type === "agent_message");
    assert.match(message.text, /\{"sum":10\}/);
    const semantic = live.thread.itemList?.find(
      (item) => item.id === message.id,
    );
    assert.equal(semantic?.role, "assistant");
    assert.equal(semantic?.source.kind, "agent_message");
    await assertActions(live.thread, message.id, message.text);
    const rejected = updateThreadProjectionCache(cache, {
      method: "zen/thread/event",
      params: {
        processEpoch: "obsolete-host",
        threadId,
        watermark: live.watermark + 1,
        event: {
          type: "item_completed",
          item: { ...message, id: "untrusted-stale" },
        },
      },
    });
    assert.equal(
      rejected,
      live,
      "an established native epoch cannot be replaced by a stale event",
    );
    updateThreadProjectionCache(cache, {
      method: "zen/thread/event",
      params: {
        processEpoch: live.processEpoch!,
        threadId,
        watermark: live.watermark + 1,
        event: {
          type: "item_completed",
          item: { ...message, id: "cross-thread", threadId: "other-thread" },
        },
      },
    });
    assert.equal(
      cache
        .get(threadId)!
        .thread.canonicalItems?.some((item) => item.id === "cross-thread"),
      false,
    );
    const fork = await manager.request("zen/thread/fork", {
      sourceThreadId: threadId,
      through: { type: "item", itemId: message.id },
      workspace: { type: "same-directory" },
    });
    assert.ok(
      fork.thread.items.some(
        (item) =>
          item.type === "thread_forked" &&
          item.sourceBoundaryItemId === message.id &&
          item.sourceThreadId === threadId,
      ),
    );
    assert.ok(
      fork.thread.items.some(
        (item) =>
          item.type === "agent_message" &&
          item.text === message.text &&
          item.threadId === fork.thread.id,
      ),
    );
    await manager.request("thread/compact", {
      threadId,
      retention: {
        mode: "recent-items",
        recentItemCount: 1,
        finalMessages: "none",
      },
    });
    const compacted = await manager.request("zen/thread/resume", { threadId });
    assert.ok(
      compacted.thread.items.some((item) => item.type === "context_compaction"),
    );
    await assertActions(
      projectNativeRecovery(compacted),
      message.id,
      message.text,
    );
    dispose();
    await manager.stop();
    await manager.start();
    const restarted = await manager.request("zen/thread/resume", { threadId });
    assert.notEqual(restarted.processEpoch, recovered.processEpoch);
    await assertActions(
      projectNativeRecovery(restarted),
      message.id,
      message.text,
    );
  } finally {
    dispose();
    await manager.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

async function assertActions(thread: Thread, itemId: string, text: string) {
  const prior = { window: globalThis.window, document: globalThis.document };
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const root = createRoot(document.getElementById("root")!);
  let draft = "";
  const forks: unknown[] = [];
  const noop = async () => {};
  try {
    await act(async () =>
      root.render(
        React.createElement(
          MessageForkContext.Provider,
          {
            value: async (target) => {
              forks.push(target);
            },
          },
          React.createElement(ThreadView, {
            thread,
            approvals: [],
            composer: emptyComposerState(),
            onDraftChange: (value) => {
              draft = value;
            },
            onInterrupt: noop,
            onRespondToApproval: noop,
            onSubmit: noop,
          }),
        ),
      ),
    );
    const message = document.querySelector<HTMLElement>(
      `[data-quote-item-id="${itemId}"]`,
    );
    assert.ok(
      message,
      "durable native message is a quote source without navigating away",
    );
    assert.equal(message.dataset.quoteThreadId, thread.id);
    const body = message.querySelector("[data-message-quote-body] p")!;
    const range = document.createRange();
    range.selectNodeContents(body);
    const selection = dom.window.getSelection()!;
    await act(async () => {
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new dom.window.Event("selectionchange"));
    });
    assert.ok(document.querySelector(".message-selection-actions"));
    await act(async () => {
      document.dispatchEvent(
        new dom.window.KeyboardEvent("keydown", {
          key: "Enter",
          altKey: true,
          bubbles: true,
        }),
      );
    });
    const quote = parseSkillDraft(draft).references.find(
      (reference) => reference.kind === "message",
    );
    assert.equal(quote?.id, itemId);
    assert.equal(quote?.threadId, thread.id);
    assert.equal(quote?.excerpt, text);
    const fork = message.querySelector<HTMLButtonElement>(".message-fork")!;
    assert.ok(fork);
    await act(async () => fork.click());
    assert.deepEqual(forks, [{ sourceThreadId: thread.id, itemId }]);
    await act(async () =>
      root.render(
        React.createElement(ThreadView, {
          thread,
          debugMode: true,
          localModelDebug: true,
          approvals: [],
          composer: emptyComposerState(),
          onDraftChange: noop,
          onInterrupt: noop,
          onRespondToApproval: noop,
          onSubmit: noop,
        }),
      ),
    );
    assert.ok(document.querySelector(".thread-debugger"));
    assert.equal(
      document.querySelectorAll(".thread-debug-tabs button[aria-pressed]")
        .length,
      2,
    );
    assert.ok(
      document
        .querySelector(".thread-debug-items")
        ?.textContent?.includes(text),
    );
  } finally {
    await act(async () => root.unmount());
    Object.assign(globalThis, prior, { IS_REACT_ACT_ENVIRONMENT: undefined });
    dom.window.close();
  }
}

async function within(promise: Promise<void>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Timed out waiting for real Host completion")),
          15000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
