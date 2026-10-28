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
        throw new Error("Connection lost; refresh to check delivery.", {
          cause: new Error("Synthetic steer diagnostic"),
        });
      },
    });
    await h.click('[data-queue-id="queue-1"] .queue-row-steer');
    assert.equal(document.querySelectorAll(".queue-row").length, 2);
    assert.match(
      document.querySelector('[data-queue-id="queue-1"] .queue-row-error')!
        .textContent!,
      /Connection lost/,
    );
    assert.match(
      document.querySelector(
        '[data-queue-id="queue-1"] .queue-row-error details pre',
      )?.textContent ?? "",
      /Synthetic steer diagnostic/u,
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
    assert.match(
      document.querySelector(".queue-shelf-toggle")!.textContent!,
      /After this turn · 2/u,
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
    assert.match(
      document.querySelector(".queue-shelf-toggle")!.textContent!,
      /Pending send · 2/u,
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

test("a stale or malformed success reply cannot confirm a different queued send", async () => {
  const old = window.zenx;
  try {
    for (const reply of [
      undefined,
      { ...target, status: "steered", turnId: "" },
      { ...target, status: "pending", turnId: "turn" },
      {
        ...target,
        queuedItemId: "other-queued",
        status: "started",
        turnId: "turn",
      },
      {
        ...target,
        clientId: "other-client",
        status: "started",
        turnId: "turn",
      },
    ]) {
      const calls: string[] = [];
      (window as any).zenx = {
        protocol: {
          request: async (method: string) => {
            calls.push(method);
            return method.endsWith("/steer")
              ? reply
              : { thread: { id: target.threadId, items: [] } };
          },
        },
      };
      await assert.rejects(requestQueuedSteer(target), {
        message: i18n.t("shell:queueSteerUnconfirmed"),
      });
      assert.deepEqual(calls, ["zen/thread/queue/steer", "zen/thread/read"]);
    }
  } finally {
    window.zenx = old;
  }
});

test("recovery requires the original queued identity and matching source kind", async () => {
  const old = window.zenx;
  const original = {
    type: "thread_message_queued",
    id: target.queuedItemId,
    threadId: target.threadId,
    clientId: target.clientId,
  };
  const delivered = {
    type: "thread_message",
    id: "delivered",
    threadId: target.threadId,
    clientId: target.clientId,
    turnId: "turn",
  };
  try {
    for (const thread of [
      { id: "another-thread", items: [original, delivered] },
      { id: target.threadId, items: [delivered] },
      { id: target.threadId, items: [{ ...original, id: "other" }, delivered] },
      {
        id: target.threadId,
        items: [original, { ...delivered, clientId: "other" }],
      },
      {
        id: target.threadId,
        items: [original, { ...delivered, type: "user_message" }],
      },
      { id: target.threadId, items: [original, { ...delivered, turnId: "" }] },
    ]) {
      const calls: string[] = [];
      (window as any).zenx = {
        protocol: {
          request: async (method: string) => {
            calls.push(method);
            if (method.endsWith("/steer")) throw new Error("Lost response");
            return { thread };
          },
        },
      };
      await assert.rejects(requestQueuedSteer(target), {
        message: i18n.t("shell:queueSteerUnconfirmed"),
      });
      assert.deepEqual(calls, ["zen/thread/queue/steer", "zen/thread/read"]);
    }
  } finally {
    window.zenx = old;
  }
});

test("a pending steer and its late failure stay with their Thread after navigation", async () => {
  await withRuntimeDom(async (h) => {
    const original = queueScenario(2);
    const other = { ...queueScenario(2), id: "other-thread" };
    let reject!: (error: Error) => void;
    const onSteerQueued = () =>
      new Promise<any>((_resolve, fail) => {
        reject = fail;
      });
    await h.render(original, { onSteerQueued });
    await h.click(".queue-row-steer");
    await h.render(other, { onSteerQueued });
    assert.equal(
      document.querySelector<HTMLButtonElement>(".queue-row-steer")!.disabled,
      false,
    );
    await act(async () =>
      reject(new Error("Original Thread lost its connection")),
    );
    assert.equal(document.querySelector(".queue-row-error"), null);
    assert.equal(document.querySelector("textarea")?.value, draft.draft.text);
    await h.render(original, { onSteerQueued });
    assert.equal(
      document.querySelector<HTMLButtonElement>(".queue-row-steer")!.disabled,
      false,
    );
  });
});

test("canonical removal restores queue focus without clearing an edited composer draft", async () => {
  await withRuntimeDom(async (h) => {
    let thread = queueScenario(2);
    let finish!: (value: any) => void;
    const onSteerQueued = () =>
      new Promise<any>((resolve) => {
        finish = resolve;
      });
    await h.render(thread, { onSteerQueued });
    const button =
      document.querySelector<HTMLButtonElement>(".queue-row-steer")!;
    await act(async () => button.focus());
    await h.click(".queue-row-steer");
    const newerDraft = {
      ...draft,
      draftRevision: draft.draftRevision + 1,
      draft: { ...draft.draft, text: "New draft typed while steering" },
    };
    thread = drainQueueHead(thread);
    await h.render(thread, { composer: newerDraft, onSteerQueued });
    await act(async () =>
      finish({ ...target, status: "steered", turnId: "turn" }),
    );
    assert.equal(
      document.querySelector("textarea")?.value,
      newerDraft.draft.text,
    );
    assert.ok(document.activeElement?.closest(".queue-shelf"));
    assert.ok(
      document.activeElement?.matches("[data-queue-control]:not(:disabled)"),
    );
  });
});

test("recovery stays bound to the request identity captured before dispatch", async () => {
  const old = window.zenx;
  const request = { ...target };
  const calls: unknown[] = [];
  try {
    (window as any).zenx = {
      protocol: {
        request: async (method: string, params: unknown) => {
          calls.push({ method, params });
          if (method.endsWith("/steer")) {
            request.threadId = "new-thread";
            request.queuedItemId = "new-queued";
            request.clientId = "new-client";
            throw new Error("Lost response");
          }
          return {
            thread: {
              id: target.threadId,
              items: [
                {
                  type: "user_message_queued",
                  id: target.queuedItemId,
                  threadId: target.threadId,
                  clientId: target.clientId,
                },
                {
                  type: "user_message",
                  id: "delivered",
                  threadId: target.threadId,
                  clientId: target.clientId,
                  turnId: "turn",
                },
              ],
            },
          };
        },
      },
    };
    assert.deepEqual(await requestQueuedSteer(request), {
      queuedItemId: target.queuedItemId,
      clientId: target.clientId,
      status: "already_started",
      turnId: "turn",
    });
    assert.deepEqual(calls, [
      { method: "zen/thread/queue/steer", params: target },
      { method: "zen/thread/read", params: { threadId: target.threadId } },
    ]);
  } finally {
    window.zenx = old;
  }
});
