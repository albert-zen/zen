import assert from "node:assert/strict";
import test from "node:test";
import { act, draft, withRuntimeDom } from "./agent-runtime-dom.js";
import { queueScenario, drainQueueHead } from "./fixtures/agent-queue-data.js";
import { requestQueuedSteer } from "../src/renderer/src/queue-steer-request.js";
import { i18n } from "../src/renderer/src/i18n.js";
import { queueEditIpcRejection } from "../src/preload/queue-edit-ipc.js";

const target = {
  threadId: "thread",
  queuedItemId: "queued",
  clientId: "client",
  expectedRevision: 0,
};
test("steer now targets the same queued identity once, leaves draft intact and awaits canonical removal", async () => {
  await withRuntimeDom(async (h) => {
    let finish!: (value: any) => void;
    const calls: unknown[] = [];
    let thread = queueScenario(2);
    await h.render(thread, {
      onSteerQueued: (params) => {
        calls.push(params);
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
    });
    const button = await h.click(".queue-row-steer");
    await act(async () => button.click());
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], {
      threadId: thread.id,
      queuedItemId: "queue-0",
      clientId: "queue-client-0",
      expectedRevision: 0,
    });
    assert.equal(button.disabled, true);
    assert.ok(button.querySelector('[role="status"]'));
    assert.equal(document.querySelectorAll(".queue-row").length, 2);
    assert.equal(document.querySelector("textarea")?.value, draft.draft.text);
    await act(async () =>
      finish({ ...target, status: "steered", turnId: "turn" }),
    );
    assert.equal(document.querySelectorAll(".queue-row").length, 2);
    thread = drainQueueHead(thread);
    await h.render(thread);
    assert.equal(document.querySelectorAll(".queue-row").length, 1);
  });
});
test("failed steering stays attached to the same row and does not disable reading or remove it", async () => {
  await withRuntimeDom(async (h) => {
    const thread = queueScenario(2);
    await h.render(thread, {
      onSteerQueued: async () => {
        throw new Error("Connection lost; refresh to check delivery.");
      },
    });
    await h.click('[data-queue-id="queue-1"] .queue-row-steer');
    assert.equal(document.querySelectorAll(".queue-row").length, 2);
    assert.match(
      document.querySelector('[data-queue-id="queue-1"] .queue-row-error')!
        .textContent!,
      /Connection lost/,
    );
    assert.equal(
      document.querySelector('[data-queue-id="queue-0"] .queue-row-error'),
      null,
    );
  });
});
test("steering label distinguishes active safe-point guidance from an idle send", async () => {
  await withRuntimeDom(async (h) => {
    await h.render(queueScenario(2), {
      onSteerQueued: async () => ({
        ...target,
        status: "steered",
        turnId: "turn",
      }),
    });
    assert.match(
      document.querySelector(".queue-row-steer")!.getAttribute("aria-label")!,
      /Steer/,
    );
    await h.render(
      { ...queueScenario(2), turns: [] },
      {
        onSteerQueued: async () => ({
          ...target,
          status: "started",
          turnId: "turn",
        }),
      },
    );
    assert.match(
      document.querySelector(".queue-row-steer")!.getAttribute("aria-label")!,
      /Send/,
    );
  });
});
test("unconfirmed transport reads the canonical identity, never cancel/resends or promotes a second time", async () => {
  const calls: string[] = [];
  const old = window.zenx;
  (window as any).zenx = {
    protocol: {
      request: async (method: string) => {
        calls.push(method);
        if (method.endsWith("/steer")) throw new Error("Lost response");
        return {
          thread: {
            id: "thread",
            items: [
              {
                type: "thread_message_queued",
                id: "queued",
                threadId: "thread",
                clientId: "client",
              },
              {
                type: "thread_message",
                id: "delivered",
                threadId: "thread",
                clientId: "client",
                turnId: "turn",
              },
            ],
          },
        };
      },
    },
  };
  try {
    assert.equal((await requestQueuedSteer(target)).status, "already_started");
    assert.deepEqual(calls, ["zen/thread/queue/steer", "zen/thread/read"]);
  } finally {
    window.zenx = old;
  }
});
test("definite native revision errors survive the Electron envelope and remain definite", async () => {
  const calls: string[] = [];
  const old = window.zenx;
  (window as any).zenx = {
    protocol: {
      request: async (method: string) => {
        calls.push(method);
        return queueEditIpcRejection({
          data: { zenCode: "queue_revision_conflict" },
        });
      },
    },
  };
  try {
    await assert.rejects(requestQueuedSteer(target), {
      message: i18n.t("shell:queueSteerConflict"),
    });
    assert.deepEqual(calls, ["zen/thread/queue/steer"]);
  } finally {
    window.zenx = old;
  }
});
