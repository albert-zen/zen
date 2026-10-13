import "./dom-primitives.js";
import assert from "node:assert/strict";
import test from "node:test";
import * as React from "react";
import { JSDOM } from "jsdom";
import { createRoot } from "react-dom/client";
import type { NativeThreadSummary } from "../../../src/thread-summary.js";
const { act, createElement, useState } = React;
const { ArchivedThreadsPanel } =
  await import("../src/renderer/src/SettingsView.js");

const thread: NativeThreadSummary = {
  threadId: "archived",
  name: "Archived conversation",
  archived: true,
  lastItemId: "last-item",
  currentMetadata: {
    model: "fake",
    provider: "fake",
    cwd: "/project",
    sandbox: "danger-full-access",
    approvalPolicy: "never",
  },
  createdAt: "2026-10-13T00:00:00.000Z",
  updatedAt: "2026-10-13T00:00:00.000Z",
  preview: "",
  status: "idle",
};

test("Delete requires confirmation, Cancel leaves data intact, failure remains retryable and duplicates are fenced", async () => {
  let calls = 0;
  let reject!: (reason: Error) => void;
  const pending = new Promise<void>((_, fail) => {
    reject = fail;
  });
  await mounted(
    async () => {
      await click(button("Delete"));
      assert.match(
        document.querySelector('[role="dialog"]')?.textContent ?? "",
        /Project files, child conversations, and shared attachments are kept/u,
      );
      assert.equal(calls, 0);
      await click(button("Cancel"));
      assert.equal(document.querySelector('[role="dialog"]'), null);
      assert.equal(calls, 0);
      await click(button("Delete"));
      const confirm = button("Delete", '[role="dialog"]');
      await act(async () => {
        confirm.click();
        confirm.click();
      });
      assert.equal(calls, 1);
      assert.equal(button("Cancel").disabled, true);
      await act(async () => reject(new Error("Deletion failed")));
      assert.match(
        document.querySelector('[role="alert"]')?.textContent ?? "",
        /Deletion failed/u,
      );
      assert.equal(button("Delete", '[role="dialog"]').disabled, false);
      await click(button("Cancel"));
      assert.match(document.body.textContent ?? "", /Archived conversation/u);
    },
    async () => {
      calls += 1;
      await pending;
    },
  );
});

test("Deleted conversations have a working Restore to Archived action", async () => {
  let deletes = 0;
  let restores = 0;
  await mounted(
    async () => {
      await click(button("Delete"));
      await click(button("Delete", '[role="dialog"]'));
      assert.equal(deletes, 1);
      assert.equal(document.querySelector('[role="dialog"]'), null);
      assert.equal(
        document.querySelectorAll(
          ".deleted-threads-section .archived-thread-row",
        ).length,
        1,
      );
      await click(button("Restore to Archived"));
      assert.equal(restores, 1);
      assert.equal(
        document.querySelectorAll(
          ".deleted-threads-section .archived-thread-row",
        ).length,
        0,
      );
      assert.ok(button("Unarchive"));
    },
    async () => {
      deletes += 1;
    },
    async () => {
      restores += 1;
    },
  );
});

test("unreadable and running archived rows cannot be deleted", async () => {
  await mounted(
    async () => {
      assert.equal(button("Delete").disabled, true);
    },
    async () => undefined,
    async () => undefined,
    { ...thread, lastItemId: undefined },
  );
  await mounted(
    async () => {
      assert.equal(button("Delete").disabled, true);
    },
    async () => undefined,
    async () => undefined,
    { ...thread, status: "active" },
  );
});

function button(text: string, within = "body") {
  const result = [
    ...document.querySelectorAll<HTMLButtonElement>(`${within} button`),
  ].find((entry) => entry.textContent?.trim() === text);
  assert.ok(result, `Expected button ${text}`);
  return result;
}
async function click(target: HTMLButtonElement) {
  await act(async () => target.click());
}
async function mounted(
  run: () => Promise<void>,
  remove: () => Promise<void>,
  restore = async () => undefined,
  initial = thread,
) {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
  const previous = { window: globalThis.window, document: globalThis.document };
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const root = createRoot(document.getElementById("root")!);
  function Harness() {
    const [deleted, setDeleted] = useState(false);
    return createElement(ArchivedThreadsPanel, {
      error: null,
      loading: false,
      onRetry: () => undefined,
      threads: deleted ? [] : [initial],
      onUnarchive: async () => undefined,
      onDelete: async (target) => {
        assert.equal(target.threadId, thread.threadId);
        await remove();
        setDeleted(true);
      },
      onRestoreDeleted: async (target) => {
        assert.equal(target.deletionItemId, "delete-item");
        await restore();
        setDeleted(false);
      },
      deletedThreads: deleted
        ? [
            {
              threadId: thread.threadId,
              name: thread.name,
              cwd: "/project",
              deletedAt: "2026-10-13T00:00:00.000Z",
              deletionItemId: "delete-item",
            },
          ]
        : [],
    });
  }
  try {
    await act(async () => root.render(createElement(Harness)));
    await run();
  } finally {
    await act(async () => root.unmount());
    Object.assign(globalThis, previous, {
      IS_REACT_ACT_ENVIRONMENT: undefined,
    });
    dom.window.close();
  }
}
