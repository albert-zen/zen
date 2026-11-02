import assert from "node:assert/strict";
import type { Thread } from "../src/protocol-client/index.js";
import test from "node:test";
import type { CanonicalItem, SteerRecalledItem } from "../../../src/item.js";
import type {
  NativeSteerRecallParams,
  NativeSteerRecallResult,
} from "../../../src/protocol/native/wire.js";
import {
  pendingSteerMessages,
  recoverSteerRecall,
} from "../../../src/steer-recall.js";
import { act, withRuntimeDom } from "./agent-runtime-dom.js";
import {
  queueScenario,
  applyQueueItem,
  queueItem,
} from "./fixtures/agent-queue-data.js";
import {
  createSteerRecallStore,
  restoreRecalledComposer,
} from "../src/renderer/src/steer-recall-state.js";
import {
  editComposer,
  emptyComposerState,
} from "../src/renderer/src/composer-state.js";
import { i18n } from "../src/renderer/src/i18n.js";

const flush = async () => {
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
};
function staged(): Thread {
  const thread = queueScenario(0);
  return {
    ...thread,
    canonicalItems: thread.canonicalItems!.map((item): CanonicalItem =>
      item.type === "user_message_queued"
        ? { ...item, deliveryMode: "steer", expectedTurnId: "runtime-turn" }
        : item,
    ),
  };
}
function receipt(request: NativeSteerRecallParams): SteerRecalledItem {
  return {
    type: "user_message_steer_recalled",
    id: "receipt-" + request.recallId,
    threadId: request.threadId,
    recallId: request.recallId,
    targets: request.targets,
    createdAt: "2026-11-02T00:00:00.000Z",
  };
}
function reply(
  request: NativeSteerRecallParams,
  items: readonly CanonicalItem[],
): NativeSteerRecallResult {
  const result = recoverSteerRecall(
    [...items, receipt(request)],
    request.threadId,
    request.recallId,
  );
  assert.ok(result);
  return { ...result, status: "recalled" };
}
function protocol(
  request: (method: string, params: unknown) => Promise<unknown>,
) {
  Object.defineProperty(window, "zenx", {
    configurable: true,
    value: { protocol: { request } },
  });
}
const recallButton = ".pending-steer-heading button";

test("actual ThreadView recalls exact whole snapshot while newer input and later arrivals remain independent", async () => {
  await withRuntimeDom(async (h) => {
    let thread = staged();
    const original = thread.canonicalItems!;
    const store = createSteerRecallStore();
    let composer = editComposer(emptyComposerState(), "draft at click");
    let request!: NativeSteerRecallParams;
    let resolve!: (value: NativeSteerRecallResult) => void;
    let restores = 0;
    protocol(async (method, value) => {
      assert.equal(method, "zen/thread/steer/recall");
      request = value as NativeSteerRecallParams;
      return new Promise<NativeSteerRecallResult>((done) => {
        resolve = done;
      });
    });
    const props = () => ({
      composer,
      steerRecallStore: store,
      onRestoreRecalled: (
        value:
          NativeSteerRecallResult | Omit<NativeSteerRecallResult, "status">,
      ) => {
        restores++;
        composer = restoreRecalledComposer(composer, value, () =>
          crypto.randomUUID(),
        );
        return true;
      },
    });
    await h.render(thread, props());
    assert.equal(document.querySelector(".queue-row-steer"), null);
    await h.click(recallButton);
    assert.deepEqual(
      request.targets.map((target) => target.queuedItemId),
      ["queue-0", "queue-1"],
    );
    assert.equal(
      document.querySelector<HTMLTextAreaElement>("#thread-composer")!.disabled,
      false,
    );
    composer = editComposer(composer, "newer typing while recall runs");
    const late = {
      ...queueItem(2, [{ type: "text" as const, text: "later arrival" }]),
      deliveryMode: "steer" as const,
      expectedTurnId: "runtime-turn",
    };
    thread = applyQueueItem(thread, late);
    await h.render(thread, props());
    assert.equal(request.targets.length, 2);
    await act(async () => resolve(reply(request, original)));
    await flush();
    assert.equal(restores, 1);
    assert.ok(
      composer.draft.text.endsWith("\n\nnewer typing while recall runs"),
    );
    assert.equal(composer.draft.text.includes("later arrival"), false);
    await h.render(thread, props());
    assert.ok(
      document
        .querySelector(".pending-steer-panel")!
        .textContent!.includes("later arrival"),
    );
    thread = applyQueueItem(thread, receipt(request));
    await h.render(thread, props());
    assert.equal(restores, 1);
    assert.equal(document.querySelector("[data-queue-id]"), null);
    assert.deepEqual(
      pendingSteerMessages(thread.canonicalItems!).map((item) => item.id),
      ["queue-2"],
    );
  });
});

test("lost recall reply reads immutable receipt once and never resends the write", async () => {
  await withRuntimeDom(async (h) => {
    const thread = staged();
    let request!: NativeSteerRecallParams;
    const calls: string[] = [];
    let restores = 0;
    protocol(async (method, value) => {
      calls.push(method);
      if (method === "zen/thread/steer/recall") {
        request = value as NativeSteerRecallParams;
        throw new Error("Lost ACK");
      }
      assert.equal(method, "zen/thread/read");
      return {
        thread: {
          id: thread.id,
          items: [...thread.canonicalItems!, receipt(request)],
        },
      };
    });
    await h.render(thread, {
      steerRecallStore: createSteerRecallStore(),
      onRestoreRecalled: () => {
        restores++;
        return true;
      },
    });
    await h.click(recallButton);
    await flush();
    assert.deepEqual(calls, ["zen/thread/steer/recall", "zen/thread/read"]);
    assert.equal(restores, 1);
  });
});

test("unknown recall remains a read-only recovery action and does not consume or restore any input", async () => {
  await withRuntimeDom(async (h) => {
    const thread = staged();
    const calls: string[] = [];
    let restores = 0;
    protocol(async (method) => {
      calls.push(method);
      if (method === "zen/thread/steer/recall") throw new Error("Disconnected");
      return { thread: { id: thread.id, items: thread.canonicalItems! } };
    });
    await h.render(thread, {
      steerRecallStore: createSteerRecallStore(),
      onRestoreRecalled: () => {
        restores++;
        return true;
      },
    });
    await h.click(recallButton);
    await flush();
    assert.equal(
      document.querySelector<HTMLButtonElement>(recallButton)!.disabled,
      true,
    );
    const check = [
      ...document.querySelectorAll<HTMLButtonElement>(
        ".pending-steer-panel button",
      ),
    ].find(
      (button) => button.textContent === i18n.t("shell:steerRecallCheck"),
    )!;
    assert.ok(check);
    await act(async () => check.click());
    await flush();
    assert.deepEqual(calls, [
      "zen/thread/steer/recall",
      "zen/thread/read",
      "zen/thread/read",
    ]);
    assert.equal(restores, 0);
  });
});

test("late recall ACK after switching Thread cannot insert into either draft; receipt remains manually recoverable", async () => {
  await withRuntimeDom(
    async (h) => {
      const thread = staged();
      const store = createSteerRecallStore();
      let request!: NativeSteerRecallParams;
      let resolve!: (value: NativeSteerRecallResult) => void;
      let restores = 0;
      protocol(async (_method, value) => {
        request = value as NativeSteerRecallParams;
        return new Promise<NativeSteerRecallResult>((done) => {
          resolve = done;
        });
      });
      const props = {
        steerRecallStore: store,
        onRestoreRecalled: () => {
          restores++;
          return true;
        },
      };
      await h.render(thread, props);
      await h.click(recallButton);
      const other = {
        ...thread,
        id: "other-thread",
        canonicalItems: [],
        queuedMessages: [],
      };
      await h.render(other, props);
      await act(async () => resolve(reply(request, thread.canonicalItems!)));
      await flush();
      assert.equal(restores, 0);
      const recalled = applyQueueItem(thread, receipt(request));
      await h.render(recalled, props);
      assert.equal(restores, 0);
      await h.click(".steer-recovery button");
      assert.equal(restores, 0); // Explicit duplicate-risk confirmation first.
      await h.click(".steer-recovery button");
      assert.equal(restores, 1);
    },
    { keyByThread: true },
  );
});

test("claim winning the race leaves the draft untouched and reports an atomic conflict", async () => {
  await withRuntimeDom(async (h) => {
    let restores = 0;
    const calls: string[] = [];
    protocol(async (method) => {
      calls.push(method);
      return {
        type: "zenx.queue-edit-rejection.v1",
        data: { zenCode: "steer_recall_conflict" },
        message: "Claim won",
      };
    });
    await h.render(staged(), {
      steerRecallStore: createSteerRecallStore(),
      onRestoreRecalled: () => {
        restores++;
        return true;
      },
    });
    await h.click(recallButton);
    await flush();
    assert.equal(restores, 0);
    assert.deepEqual(calls, ["zen/thread/steer/recall"]);
    assert.ok(
      document
        .querySelector(".pending-steer-panel")!
        .textContent!.includes(i18n.t("shell:steerRecallConflict")),
    );
  });
});

test("restart only offers explicit receipt recovery; submitting Composer keeps the recovery card", async () => {
  await withRuntimeDom(async (h) => {
    const thread = staged();
    const request = {
      threadId: thread.id,
      recallId: "old-recall",
      targets: pendingSteerMessages(thread.canonicalItems!).map((item) => ({
        queuedItemId: item.id,
        clientId: item.clientId,
        expectedRevision: item.revision,
      })),
    };
    const recalled = applyQueueItem(thread, receipt(request));
    let restores = 0;
    protocol(async () => {
      throw new Error("Recovery must not write to Host");
    });
    await h.render(recalled, {
      steerRecallStore: createSteerRecallStore(),
      onRestoreRecalled: () => {
        restores++;
        return false;
      },
    });
    assert.equal(restores, 0);
    await h.click(".steer-recovery button");
    await h.click(".steer-recovery button");
    assert.equal(restores, 1);
    assert.ok(document.querySelector(".steer-recovery"));
    assert.ok(
      document
        .querySelector(".pending-steer-panel")!
        .textContent!.includes(i18n.t("shell:steerRecoveryBusy")),
    );
  });
});

test("canonical recall event removes recalled entries from legacy queue projection without a Thread resume", () => {
  const thread = staged();
  const request = {
    threadId: thread.id,
    recallId: "project-once",
    targets: pendingSteerMessages(thread.canonicalItems!).map((item) => ({
      queuedItemId: item.id,
      clientId: item.clientId,
      expectedRevision: item.revision,
    })),
  };
  const updated = applyQueueItem(thread, receipt(request));
  assert.deepEqual(updated.queuedMessages, []);
  assert.deepEqual(pendingSteerMessages(updated.canonicalItems!), []);
  assert.equal(
    updated.canonicalItems!.filter(
      (item) => item.type === "user_message_queued",
    ).length,
    2,
  );
});

test("receipt event keeps unrelated later next-turn and staged inputs in their own projections", () => {
  let thread = staged();
  const request = {
    threadId: thread.id,
    recallId: "old-batch",
    targets: pendingSteerMessages(thread.canonicalItems!).map((item) => ({
      queuedItemId: item.id,
      clientId: item.clientId,
      expectedRevision: item.revision,
    })),
  };
  thread = applyQueueItem(
    thread,
    queueItem(2, [{ type: "text", text: "next turn" }]),
  );
  thread = applyQueueItem(thread, {
    ...queueItem(3, [{ type: "text", text: "later steer" }]),
    deliveryMode: "steer",
    expectedTurnId: "runtime-turn",
  });
  const updated = applyQueueItem(thread, receipt(request));
  assert.deepEqual(
    updated.queuedMessages!.map((item) => item.id),
    ["queue-2", "queue-3"],
  );
  assert.deepEqual(
    pendingSteerMessages(updated.canonicalItems!).map((item) => item.id),
    ["queue-3"],
  );
});

test("unsupported whole batch makes no recall RPC", async () => {
  await withRuntimeDom(async (h) => {
    const original = staged();
    const thread = {
      ...original,
      canonicalItems: original.canonicalItems!.map((item): CanonicalItem => {
        if (item.type !== "user_message_queued" || item.id !== "queue-1")
          return item;
        return {
          ...item,
          input: [
            {
              type: "text",
              text: "Synthetic expanded skill instructions",
              skillSource: {
                kind: "catalog",
                id: "11111111-1111-1111-1111-111111111111",
              },
            },
          ],
        };
      }),
    };
    const before = structuredClone(thread.canonicalItems);
    let writes = 0;
    let restores = 0;
    protocol(async () => {
      writes++;
      throw new Error("Unsupported batch must not reach Host");
    });
    await h.render(thread, {
      steerRecallStore: createSteerRecallStore(),
      onRestoreRecalled: () => {
        restores++;
        return true;
      },
    });
    const button = document.querySelector<HTMLButtonElement>(recallButton)!;
    assert.equal(button.disabled, true);
    await act(async () => button.click());
    assert.equal(writes, 0);
    assert.equal(restores, 0);
    assert.deepEqual(thread.canonicalItems, before);
    assert.equal(pendingSteerMessages(thread.canonicalItems!).length, 2);
    assert.ok(
      document
        .querySelector(".pending-steer-panel")!
        .textContent!.includes(i18n.t("shell:steerRecallUnsupported")),
    );
  });
});
