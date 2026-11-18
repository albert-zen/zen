import assert from "node:assert/strict";
import type { Thread } from "../src/protocol-client/index.js";
import test from "node:test";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { PendingSteerPanel } from "../src/renderer/src/PendingSteerPanel.js";
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
function staged(scene = 0): Thread {
  const thread = queueScenario(scene);
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
const recallButton = ".pending-steer-heading .queue-header-action";

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
    const shelf = document.querySelector(".pending-steer-panel")!;
    assert.ok(shelf.classList.contains("queue-shelf"));
    assert.ok(shelf.closest(".bottom-zone"));
    assert.equal(
      shelf.querySelector(".steer-shelf-details")!.hasAttribute("hidden"),
      false,
    );
    assert.equal(
      shelf.textContent!.includes(i18n.t("shell:steerPendingDetails")),
      false,
    );
    assert.ok(shelf.querySelector(".queue-header-action svg"));
    assert.equal(
      shelf.querySelector(".queue-shelf-toggle")!.getAttribute("aria-expanded"),
      "true",
    );
    assert.equal(shelf.closest(".messages"), null);
    assert.equal(
      document.querySelector(recallButton)!.textContent,
      i18n.t("shell:steerRecallAllShort"),
    );
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

test("receipt shelf does not rescan 5000 unchanged items on parent rerenders", async () => {
  await withRuntimeDom(async () => {
    const items: CanonicalItem[] = Array.from({ length: 5000 }, (_, index) =>
      queueItem(index, [{ type: "text", text: "Synthetic history" }]),
    );
    const countFilters = (current: CanonicalItem[]) => {
      let calls = 0;
      Object.defineProperty(current, "filter", {
        configurable: true,
        value(...args: unknown[]) {
          calls++;
          return Reflect.apply(Array.prototype.filter, current, args);
        },
      });
      return () => calls;
    };
    const filterCount = countFilters(items);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const store = createSteerRecallStore();
    const render = async (threadId: string, current = items) => {
      await act(async () => {
        root.render(
          createElement(PendingSteerPanel, {
            threadId,
            items: current,
            pending: [],
            runningTurnId: null,
            store,
            onRestore: () => true,
          }),
        );
      });
    };
    try {
      await render("thread-1");
      assert.equal(filterCount(), 1);
      for (let input = 0; input < 12; input++) await render("thread-1");
      assert.equal(filterCount(), 1);
      assert.equal(container.textContent, "");
      await render("thread-2");
      assert.equal(filterCount(), 2);
      const replacement = [...items];
      const replacementFilterCount = countFilters(replacement);
      await render("thread-2", replacement);
      assert.equal(replacementFilterCount(), 1);
      await render("thread-2", replacement);
      assert.equal(replacementFilterCount(), 1);
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});

test("successful read-only Check clears the previous unknown warning before canonical notifications", async () => {
  await withRuntimeDom(async (h) => {
    const thread = staged();
    let request!: NativeSteerRecallParams;
    const calls: string[] = [];
    let restores = 0;
    let reads = 0;
    protocol(async (method, value) => {
      calls.push(method);
      if (method === "zen/thread/steer/recall") {
        request = value as NativeSteerRecallParams;
        throw new Error("Actual recall reply lost");
      }
      assert.equal(method, "zen/thread/read");
      if (++reads === 1) throw new Error("Automatic read reply lost");
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
    assert.equal(restores, 0);
    assert.ok(
      document.body.textContent!.includes(i18n.t("shell:steerRecallUnknown")),
    );
    const diagnostic = document.querySelector(
      ".pending-steer-panel .context-compaction-error-detail pre",
    );
    assert.ok(diagnostic?.textContent?.includes("Actual recall reply lost"));
    assert.ok(diagnostic?.textContent?.includes("Automatic read reply lost"));
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
    assert.equal(restores, 1);
    assert.equal(
      document.body.textContent!.includes(i18n.t("shell:steerRecallUnknown")),
      false,
    );
    assert.equal(document.querySelector(recallButton), null);
    assert.equal(document.querySelector("[data-queue-id]"), null);
    assert.equal(
      document.querySelector(
        ".pending-steer-panel .context-compaction-error-detail",
      ),
      null,
    );
    assert.deepEqual(calls, [
      "zen/thread/steer/recall",
      "zen/thread/read",
      "zen/thread/read",
    ]);
  });
});

test("pending preview expands the complete original text and preserves reference capsules", async () => {
  const { referenceMessage } =
    await import("../src/renderer/src/reference-draft.js");
  await withRuntimeDom(async (h) => {
    const source = staged();
    const text =
      "Long original message\n".repeat(24) +
      "Complete tail after the old cutoff ";
    const thread = {
      ...source,
      canonicalItems: source.canonicalItems!.map((item): CanonicalItem =>
        item.type === "user_message_queued"
          ? {
              ...item,
              input: [
                {
                  type: "text",
                  text: referenceMessage(
                    text + "\uFFFC",
                    [
                      {
                        kind: "message",
                        id: "synthetic-source-item",
                        threadId: source.id,
                        name: "Selected source text",
                        cwd: "/synthetic",
                        excerpt: "Exact quoted excerpt\nwith its next line",
                        position: text.length,
                      },
                    ],
                    item.clientId,
                  ),
                },
              ],
            }
          : item,
      ),
    };
    let writes = 0;
    protocol(async () => {
      writes++;
      throw new Error("Preview must not call the Host");
    });
    await h.render(thread, { onRestoreRecalled: () => true });
    const preview = document.querySelector<HTMLDetailsElement>(
      ".pending-steer-message",
    )!;
    assert.ok(preview);
    assert.equal(preview.open, false);
    assert.equal(preview.querySelector("summary")!.textContent!.length, 241);
    await act(async () => {
      preview.open = true;
    });
    assert.ok(
      preview
        .querySelector(".pending-steer-text")!
        .textContent!.includes("Complete tail after the old cutoff"),
    );
    assert.ok(preview.querySelector('[data-reference-kind="message"]'));
    assert.ok(
      preview.textContent!.includes("Exact quoted excerpt\nwith its next line"),
    );
    assert.equal(
      preview
        .querySelector('[data-reference-kind="message"]')!
        .textContent!.includes("synthetic-source-item"),
      false,
    );
    assert.equal(writes, 0);
  });
});

test("known recall refusal keeps expandable original local diagnostics as text", async () => {
  await withRuntimeDom(async (h) => {
    const detail =
      'Original native refusal\n<img src=x onerror="throw Error()">\nrevision 2 != 3';
    protocol(async () => ({
      type: "zenx.queue-edit-rejection.v1",
      data: { zenCode: "steer_recall_conflict" },
      message: "Changed revision",
      detail,
    }));
    await h.render(staged(), { onRestoreRecalled: () => true });
    await h.click(recallButton);
    await flush();
    const details = document.querySelector<HTMLDetailsElement>(
      ".pending-steer-panel .context-compaction-error-detail",
    )!;
    assert.ok(details);
    assert.equal(details.open, false);
    assert.equal(details.querySelector("pre")!.textContent, detail);
    assert.equal(details.querySelector("img"), null);
    assert.equal(details.querySelector("pre")!.tabIndex, 0);
  });
});

for (const [scopeIndex, interruption] of [
  "close",
  "receipt",
  "navigation",
].entries()) {
  for (const [settleIndex, settlement] of ["resolve", "reject"].entries()) {
    test(`late pending image ${settlement} after ${interruption} cannot revive a preview or change newer draft`, async () => {
      const { readFile } = await import("node:fs/promises");
      const { queueImageAttachments } =
        await import("./fixtures/agent-queue-images.js");
      const attachment = queueImageAttachments[scopeIndex * 2 + settleIndex]!;
      await withRuntimeDom(
        async (h) => {
          const source = staged(1);
          const thread = {
            ...source,
            canonicalItems: source.canonicalItems!.map((item): CanonicalItem =>
              item.type === "user_message_queued"
                ? { ...item, input: [{ type: "image", attachment }] }
                : item,
            ),
          };
          let resolve!: (bytes: Uint8Array) => void;
          let reject!: (reason: unknown) => void;
          let reads = 0;
          const props = {
            composer: editComposer(
              emptyComposerState(),
              "Newer independent draft",
            ),
            onRestoreRecalled: () => true,
            onReadAttachment: (
              ref: import("../../../src/attachment.js").AttachmentRef,
            ) => {
              assert.deepEqual(ref, attachment);
              reads++;
              return new Promise<Uint8Array>((done, fail) => {
                resolve = done;
                reject = fail;
              });
            },
          };
          await h.render(thread, props);
          const toggle = document.querySelector<HTMLButtonElement>(
            ".pending-steer-heading .queue-shelf-toggle",
          )!;
          assert.equal(toggle.getAttribute("aria-expanded"), "true");
          await flush();
          assert.equal(reads, 1);
          const oldButton = document.querySelector<HTMLButtonElement>(
            ".pending-steer-images .image-thumbnail",
          )!;
          assert.ok(oldButton);
          if (interruption === "close") {
            await act(async () => {
              toggle.click();
            });
          } else if (interruption === "receipt") {
            await h.render(
              applyQueueItem(
                thread,
                receipt({
                  threadId: thread.id,
                  recallId: "late-image-recall",
                  targets: pendingSteerMessages(thread.canonicalItems!).map(
                    (item) => ({
                      queuedItemId: item.id,
                      clientId: item.clientId,
                      expectedRevision: item.revision,
                    }),
                  ),
                }),
              ),
              props,
            );
          } else {
            await h.render(
              {
                ...thread,
                id: "new-thread",
                canonicalItems: [],
                queuedMessages: [],
              },
              props,
            );
          }
          const editor =
            document.querySelector<HTMLTextAreaElement>("#thread-composer")!;
          editor.focus();
          await act(async () => {
            if (settlement === "resolve")
              resolve(
                new Uint8Array(
                  await readFile(
                    new URL(
                      `./fixtures/assets/queue-images/queue-image-${scopeIndex * 2 + settleIndex + 1}.png`,
                      import.meta.url,
                    ),
                  ),
                ),
              );
            else reject(new Error("Late synthetic image read failed"));
          });
          await flush();
          await act(async () => oldButton.click());
          assert.equal(
            reads,
            1,
            "late completion and detached actions do not dispatch another read",
          );
          assert.equal(document.querySelector(".pending-steer-images"), null);
          assert.equal(document.querySelector(".image-preview-layer"), null);
          assert.equal(document.activeElement, editor);
          assert.equal(editor.value, "Newer independent draft");
        },
        { keyByThread: true },
      );
    });
  }
}

test("pending steer uses normal image rows above distinct question bubbles", async () => {
  await withRuntimeDom(async (h) => {
    const source = staged(2);
    const thread = {
      ...source,
      canonicalItems: source.canonicalItems!.map((item): CanonicalItem =>
        item.type === "user_message_queued"
          ? {
              ...item,
              input: [
                { type: "text", text: "What is **the trigger**?" },
                ...item.input.filter((part) => part.type === "image"),
              ],
            }
          : item,
      ),
    };
    await h.render(thread, {
      onRestoreRecalled: () => true,
      onReadAttachment: () => new Promise<Uint8Array>(() => {}),
    });
    const row = document.querySelector(".steer-shelf-row")!;
    assert.ok(row.classList.contains("user-row"));
    const images = row.querySelector(".message-images.pending-steer-images");
    const bubble = row.querySelector(".user-bubble");
    assert.ok(images);
    assert.ok(bubble);
    assert.equal(images.parentElement, row);
    assert.equal(bubble.parentElement, row);
    assert.ok(
      images.compareDocumentPosition(bubble) &
        window.Node.DOCUMENT_POSITION_FOLLOWING,
    );
    assert.equal(bubble.querySelector("strong")?.textContent, "the trigger");
    assert.equal(bubble.querySelector("img"), null);
    assert.equal(
      row.querySelectorAll(".message-images .image-thumbnail").length,
      2,
    );
    const imageOnly = {
      ...thread,
      canonicalItems: thread.canonicalItems.map((item): CanonicalItem =>
        item.type === "user_message_queued"
          ? {
              ...item,
              input: item.input.filter((part) => part.type === "image"),
            }
          : item,
      ),
    };
    await h.render(imageOnly, {
      onRestoreRecalled: () => true,
      onReadAttachment: () => new Promise<Uint8Array>(() => {}),
    });
    assert.equal(document.querySelector(".steer-shelf-row .user-bubble"), null);
    assert.equal(
      document.querySelectorAll(".steer-shelf-row .image-thumbnail").length,
      3,
    );
  });
});

test("pending images use canonical attachment refs and their preview closes after recall", async () => {
  const { readFile } = await import("node:fs/promises");
  const { queueImageAttachments } =
    await import("./fixtures/agent-queue-images.js");
  // Read the fixture before rendering: a fixed number of React flushes must
  // not race filesystem scheduling when waiting for three async thumbnails.
  const imageBytes = await Promise.all(
    queueImageAttachments.map(
      async (_attachment, index) =>
        new Uint8Array(
          await readFile(
            new URL(
              `./fixtures/assets/queue-images/queue-image-${index + 1}.png`,
              import.meta.url,
            ),
          ),
        ),
    ),
  );
  await withRuntimeDom(async (h) => {
    const thread = staged(2);
    let reads = 0;
    const props = {
      onRestoreRecalled: () => true,
      onReadAttachment: async (
        attachment: import("../../../src/attachment.js").AttachmentRef,
      ) => {
        const index = queueImageAttachments.findIndex(
          (ref) => ref.sha256 === attachment.sha256,
        );
        assert.ok(
          index >= 0,
          "only exact synthetic canonical attachments may be read",
        );
        reads++;
        return imageBytes[index]!;
      },
    };
    await h.render(thread, props);
    assert.ok(
      reads > 0,
      "visible pending content loads uncached exact image payloads",
    );
    const visibleReads = reads;
    await h.click(".pending-steer-heading .queue-shelf-toggle");
    assert.equal(
      document.querySelector(".steer-shelf-details")!.hasAttribute("hidden"),
      true,
    );
    assert.equal(document.querySelector(".pending-steer-images"), null);
    await flush();
    assert.equal(
      reads,
      visibleReads,
      "collapsed content starts no image reads",
    );
    await h.click(".pending-steer-heading .queue-shelf-toggle");
    await flush();
    assert.equal(
      document.querySelectorAll(".pending-steer-images .image-thumbnail")
        .length,
      3,
    );
    assert.equal(
      document.querySelectorAll('.pending-steer-images img[src^="blob:"]')
        .length,
      3,
    );
    const image = await h.click(".pending-steer-images .image-thumbnail");
    assert.ok(document.querySelector(".image-preview-layer"));
    await act(async () =>
      document.dispatchEvent(
        new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      ),
    );
    assert.equal(document.querySelector(".image-preview-layer"), null);
    assert.equal(document.activeElement, image);
    await h.click(".pending-steer-images .image-thumbnail");
    const before = reads;
    const request = {
      threadId: thread.id,
      recallId: "canonical-image-recall",
      targets: pendingSteerMessages(thread.canonicalItems!).map((item) => ({
        queuedItemId: item.id,
        clientId: item.clientId,
        expectedRevision: item.revision,
      })),
    };
    await h.render(applyQueueItem(thread, receipt(request)), props);
    assert.equal(document.querySelector(".image-preview-layer"), null);
    assert.equal(document.querySelector(".pending-steer-images"), null);
    assert.equal(reads, before);
  });
});

test("steer rows preserve shared responsive gutters and thumbnail styling", async () => {
  const { readFile } = await import("node:fs/promises");
  const css = await readFile(
    new URL("../src/renderer/src/queued-messages.css", import.meta.url),
    "utf8",
  );
  const sibling = css.match(
    /\.steer-shelf-row \+ \.steer-shelf-row\s*\{([^}]+)\}/,
  )?.[1];
  assert.ok(sibling);
  assert.doesNotMatch(sibling, /padding|width|display/);
  assert.match(sibling, /border:\s*0/);
  assert.doesNotMatch(css, /\.pending-steer-images\s*\{[^}]*width:/);
  assert.match(css, /\.steer-shelf button:where\(:not\(\.image-thumbnail\)\)/);
});

test("shelf read-only recovery and restore actions retain 44px hit targets", async () => {
  const { readFile } = await import("node:fs/promises");
  const styles = await readFile(
    new URL("../src/renderer/src/queued-messages.css", import.meta.url),
    "utf8",
  );
  await withRuntimeDom(async (h) => {
    const style = document.createElement("style");
    style.textContent = styles;
    document.head.append(style);
    const thread = staged();
    protocol(async () => {
      throw Error("Synthetic disconnected recall");
    });
    await h.render(thread, {
      steerRecallStore: createSteerRecallStore(),
      onRestoreRecalled: () => true,
    });
    await h.click(recallButton);
    await flush();
    const check = document.querySelector<HTMLButtonElement>(
      ".steer-shelf > button",
    )!;
    assert.ok(check);
    const largeEnough = (button: HTMLButtonElement) =>
      assert.equal(
        window.getComputedStyle(button).minHeight,
        "44px",
        button.textContent ?? "recovery button",
      );
    largeEnough(check);
    const recalled = applyQueueItem(
      thread,
      receipt({
        threadId: thread.id,
        recallId: "hit-target",
        targets: pendingSteerMessages(thread.canonicalItems!).map((item) => ({
          queuedItemId: item.id,
          clientId: item.clientId,
          expectedRevision: item.revision,
        })),
      }),
    );
    await h.render(recalled, {
      steerRecallStore: createSteerRecallStore(),
      onRestoreRecalled: () => false,
    });
    largeEnough(
      document.querySelector<HTMLButtonElement>(".steer-recovery button")!,
    );
    await h.click(".steer-recovery button");
    const actions = [
      ...document.querySelectorAll<HTMLButtonElement>(".steer-recovery button"),
    ];
    assert.equal(actions.length, 2);
    actions.forEach(largeEnough);
  });
});

test("native question origin driver observes the shelf status and invokes only whole-batch Recall", async () => {
  const { readFile } = await import("node:fs/promises");
  const capture = await readFile(
    new URL("../scripts/capture-user-question.cjs", import.meta.url),
    "utf8",
  );
  const countSelector = capture.match(
    /document\.querySelector\('([^']+)'\)\?\.textContent\.includes\('2'\)/,
  )?.[1];
  const actionSelector = capture.match(
    /await click\(\s*"([^"]+)",\s*"Native one whole-batch Recall"/,
  )?.[1];
  assert.ok(countSelector, "native driver pending-count selector");
  assert.ok(actionSelector, "native driver whole-batch Recall selector");
  await withRuntimeDom(async (h) => {
    const thread = staged();
    const original = thread.canonicalItems!;
    const requests: NativeSteerRecallParams[] = [];
    let restores = 0;
    protocol(async (method, value) => {
      assert.equal(method, "zen/thread/steer/recall");
      const request = value as NativeSteerRecallParams;
      requests.push(request);
      return reply(request, original);
    });
    await h.render(thread, {
      steerRecallStore: createSteerRecallStore(),
      onRestoreRecalled: () => {
        restores++;
        return true;
      },
    });
    const status = document.querySelector(countSelector);
    assert.ok(
      status,
      "native driver must find actual production pending count",
    );
    assert.ok(status.textContent!.includes("2"));
    assert.equal(status.getAttribute("role"), "status");
    const toggle = document.querySelector(
      ".pending-steer-heading .queue-shelf-toggle",
    )!;
    const expanded = toggle.getAttribute("aria-expanded");
    const action = document.querySelector(actionSelector);
    assert.ok(action?.classList.contains("queue-header-action"));
    await h.click(actionSelector);
    await flush();
    assert.equal(requests.length, 1);
    assert.deepEqual(
      requests[0]!.targets.map((target) => target.queuedItemId),
      ["queue-0", "queue-1"],
    );
    assert.equal(restores, 1);
    assert.equal(toggle.getAttribute("aria-expanded"), expanded);
  });
});

test("held headings stay neutral across owners, recovery and languages without requests", async () => {
  await withRuntimeDom(async () => {
    const thread = staged();
    const items = thread.canonicalItems!;
    const pending = pendingSteerMessages(items);
    let requests = 0;
    let restores = 0;
    protocol(async () => {
      requests++;
      throw new Error("Unexpected request");
    });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const store = createSteerRecallStore();
    const originalLanguage = i18n.language;
    try {
      for (const language of ["en", "zh"]) {
        await act(async () => {
          await i18n.changeLanguage(language);
        });
        for (const count of [1, 2]) {
          for (const owner of [
            "runtime-turn",
            null,
            "runtime-turn",
            "other-turn",
            "runtime-turn",
          ]) {
            for (const mixed of [false, true]) {
              const visible = pending
                .slice(0, count)
                .map((item, index) =>
                  mixed && index === 1
                    ? { ...item, expectedTurnId: "older-turn" }
                    : item,
                );
              const held = owner !== "runtime-turn" || (mixed && count === 2);
              await act(async () => {
                root.render(
                  createElement(PendingSteerPanel, {
                    threadId: thread.id,
                    items,
                    pending: visible,
                    runningTurnId: owner,
                    store,
                    onRestore: () => {
                      restores++;
                      return true;
                    },
                  }),
                );
              });
              const panel = container.querySelector(".pending-steer-panel")!;
              const expectedLabel =
                language === "en"
                  ? held
                    ? "Pending model input"
                    : "Messages waiting for the model"
                  : held
                    ? "待提交的模型输入"
                    : "等待进入模型的消息";
              const expectedCount =
                language === "en"
                  ? `${held ? "Pending input" : "Waiting for the model"} · ${count} ${count === 1 ? "message" : "messages"}`
                  : `${held ? "待提交输入" : "等待进入模型"} · ${count} 条`;
              assert.equal(panel.getAttribute("aria-label"), expectedLabel);
              assert.equal(
                panel.querySelector('[role="status"]')!.textContent,
                expectedCount,
              );
              assert.equal(
                panel.querySelector(".mini-spinner") !== null,
                !held,
              );
              assert.equal(
                panel.querySelector(".steer-shelf-notice")?.textContent ?? null,
                held ? i18n.t("shell:steerHeldNotice") : null,
              );
              assert.equal(
                panel
                  .querySelector(".queue-shelf-toggle")!
                  .getAttribute("aria-expanded"),
                "true",
              );
              assert.equal(requests, 0);
              assert.equal(restores, 0);
            }
          }
        }
      }
    } finally {
      await act(async () => root.unmount());
      container.remove();
      await i18n.changeLanguage(originalLanguage);
    }
  });
});

test("pending controls retain bilingual names, disclosure focus and inert disabled recall", async () => {
  await withRuntimeDom(async () => {
    const thread = staged();
    const items = thread.canonicalItems!;
    let requests = 0;
    protocol(async () => {
      requests++;
      throw new Error("Unexpected request from disabled recall or disclosure");
    });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const originalLanguage = i18n.language;
    try {
      for (const language of ["en", "zh"]) {
        await act(async () => {
          await i18n.changeLanguage(language);
        });
        for (const count of [1, 2]) {
          for (const restorable of [true, false]) {
            await act(async () => {
              root.render(
                createElement(PendingSteerPanel, {
                  threadId: thread.id,
                  items,
                  pending: pendingSteerMessages(items).slice(0, count),
                  runningTurnId: null,
                  onRestore: restorable ? () => true : undefined,
                }),
              );
            });
            const toggle = container.querySelector<HTMLButtonElement>(
              ".queue-shelf-toggle",
            )!;
            const recall = container.querySelector<HTMLButtonElement>(
              ".queue-header-action",
            )!;
            assert.equal(
              recall.title,
              i18n.t(
                count === 1 ? "shell:steerRecallOne" : "shell:steerRecallAll",
              ),
            );
            assert.equal(
              recall.textContent?.trim(),
              i18n.t(
                count === 1
                  ? "shell:steerRecallOneShort"
                  : "shell:steerRecallAllShort",
              ),
            );
            assert.equal(recall.disabled, !restorable);
            if (!restorable) {
              await act(async () => recall.click());
              assert.equal(requests, 0);
            }
            toggle.focus();
            for (const expanded of [false, true]) {
              await act(async () => toggle.click());
              assert.equal(document.activeElement, toggle);
              assert.equal(
                toggle.getAttribute("aria-expanded"),
                String(expanded),
              );
              assert.equal(
                toggle.getAttribute("aria-label"),
                i18n.t(
                  expanded
                    ? "shell:queueHideMessages"
                    : "shell:queueShowMessages",
                ),
              );
              const details = document.getElementById(
                toggle.getAttribute("aria-controls")!,
              );
              assert.ok(details);
              assert.equal(details.hidden, !expanded);
              assert.equal(requests, 0);
            }
          }
        }
      }
    } finally {
      await act(async () => root.unmount());
      container.remove();
      await i18n.changeLanguage(originalLanguage);
    }
  });
});
