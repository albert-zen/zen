import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { withRuntimeDom } from "./agent-runtime-dom.js";
import { queueScenario } from "./fixtures/agent-queue-data.js";
import { emptyComposerState } from "../src/renderer/src/composer-state.js";

test("a new-thread Composer has no queue reorder alert without a failed operation", async () => {
  await withRuntimeDom(async (h) => {
    await h.render(queueScenario(0), {
      thread: null,
      composer: emptyComposerState(),
    });
    const alert = document.querySelector(".pending-tray [role=alert]");
    assert.equal(alert?.outerHTML ?? null, null);
  });
});

test("a real queue reorder failure remains visible only on its owning Thread", async () => {
  await withRuntimeDom(async (h) => {
    const owner = queueScenario(0);
    let calls = 0;
    await h.render(owner, {
      onReorderQueued: async () => {
        calls++;
        throw new Error("Synthetic reorder rejected");
      },
    });
    await h.click('[data-queue-id="queue-1"] [data-queue-control="move-up"]');
    const error = () => document.querySelector(".pending-tray > [role=alert]");
    assert.equal(error()?.textContent, "Synthetic reorder rejected");
    await h.render(owner, { thread: null });
    assert.equal(error(), null);
    await h.render({ ...owner, id: "other-thread" });
    assert.equal(error(), null);
    await h.render(owner);
    assert.equal(error()?.textContent, "Synthetic reorder rejected");
    assert.equal(calls, 1, "navigation never repeats the rejected mutation");
  });
});

test("one composer tray contains Steer above Queue and local sending, with no pending echo in transcript", async () => {
  await withRuntimeDom(async (h) => {
    const scene = queueScenario(3);
    const thread = {
      ...scene,
      canonicalItems: scene.canonicalItems!.map((item) =>
        item.type === "user_message_queued" && item.id === "queue-0"
          ? {
              ...item,
              deliveryMode: "steer" as const,
              expectedTurnId: "runtime-turn",
            }
          : item,
      ),
    };
    await h.render(thread, {
      composer: {
        ...emptyComposerState(),
        pendingSends: [
          {
            clientId: "in-flight",
            intent: "start",
            draft: { text: "Not yet admitted", images: [] },
            status: "sending",
            error: null,
          },
        ],
      },
    });
    const trays = document.querySelectorAll(".pending-tray");
    assert.equal(trays.length, 1);
    const tray = trays[0]!;
    assert.ok(tray.closest(".bottom-zone"));
    assert.equal(
      tray.querySelectorAll('[role="tab"], [role="tablist"]').length,
      0,
    );
    assert.ok(tray.querySelector(".pending-send-row"));
    assert.equal(document.querySelector(".messages .pending-send-row"), null);
    const groups = [...tray.querySelectorAll(".queue-shelf")];
    assert.equal(groups.length, 2);
    assert.ok(groups[0]!.classList.contains("steer-shelf"));
    assert.equal(tray.querySelectorAll(".queue-row[hidden]").length, 0);
    assert.equal(tray.querySelector(".queue-view-all"), null);
  });
});

test("the combined pending tray owns the only pending-list scroll and one total height cap", async () => {
  const css = await readFile(
    new URL("../src/renderer/src/queued-messages.css", import.meta.url),
    "utf8",
  );
  assert.match(
    css,
    /\.pending-tray\s*\{[^}]*max-height:\s*min\(240px,\s*30dvh\)[^}]*overflow-y:\s*auto/s,
  );
  assert.match(
    css,
    /\.pending-tray\s*\{[^}]*flex:\s*0 0 auto/s,
    "The bounded tray must not collapse when Composer images and references fill the scrollable bottom zone",
  );
  assert.match(
    css,
    /\.pending-tray \.queue-shelf-details\s*\{[^}]*max-height:\s*none[^}]*overflow:\s*visible/s,
  );
});

test("the pending tray exposes native overflow even while other scrollbars auto-hide", async () => {
  const css = await readFile(
    new URL("../src/renderer/src/queued-messages.css", import.meta.url),
    "utf8",
  );
  assert.match(
    css,
    /:root\[data-scrollbar-autohide\] \.pending-tray\s*\{[^}]*scrollbar-color:\s*var\(--color-text-muted\) transparent/s,
    "The local override must outrank the global auto-hide paint without changing its controller",
  );
  assert.match(
    css,
    /\.pending-tray\s*\{[^}]*overflow-y:\s*auto[^}]*scrollbar-gutter:\s*stable/s,
    "Native auto overflow shows the thumb only when rows exceed the existing tray cap",
  );
  assert.doesNotMatch(
    css,
    /\.pending-tray\s*\{[^}]*overflow-y:\s*scroll/s,
    "A short pending group must not imply hidden content",
  );
});

test("direct-child delivery-check feedback keeps readable neutral type without a recovery wrapper", async () => {
  const css = await readFile(
    new URL("../src/renderer/src/queued-messages.css", import.meta.url),
    "utf8",
  );
  assert.match(
    css,
    /\.pending-tray \.pending-send-check-feedback\s*\{[^}]*color:\s*var\(--color-text-secondary\)[^}]*font-size:\s*var\(--font-size-label\)/s,
  );
  assert.doesNotMatch(
    css,
    /\.pending-send-recovery \.pending-send-check-feedback/s,
    "Admitted and uncertain checks share the same direct-child feedback placement",
  );
});

test("pending and approval share outer scrolling without collapsing approval content", async () => {
  const css = await readFile(
    new URL("../src/renderer/src/styles.css", import.meta.url),
    "utf8",
  );
  assert.match(
    css,
    /\.bottom-zone\.has-queue\.has-approval > \.approval-request-card\s*\{[^}]*flex:\s*0 0 auto/s,
    "Pending content must not compress the approval body or decisions",
  );
  assert.match(
    css,
    /\.bottom-zone\.has-approval > \.approval-request-card\s*\{[^}]*flex:\s*0 1 auto/s,
    "Approval-only sizing remains unchanged",
  );
});

test("Queue and local sends preserve the same Markdown and typed reference capsules as ordinary messages", async () => {
  const { referenceMessage, withReferenceDraft } =
    await import("../src/renderer/src/reference-draft.js");
  const { applyQueueItem, queueItem } =
    await import("./fixtures/agent-queue-data.js");
  const text = "Review **this** \uFFFC before sending.";
  const references = [
    {
      kind: "thread" as const,
      id: "source",
      name: "Source thread",
      cwd: "/synthetic",
      position: text.indexOf("\uFFFC"),
    },
  ];
  await withRuntimeDom(async (h) => {
    const source = {
      ...queueScenario(0),
      queuedMessages: [],
      canonicalItems: queueScenario(0).canonicalItems!.filter(
        (item) => item.type !== "user_message_queued",
      ),
    };
    const thread = applyQueueItem(
      source,
      queueItem(11, [
        {
          type: "text",
          text: referenceMessage(text, references, "queue-client-11"),
        },
      ]),
    );
    await h.render(thread, {
      composer: {
        ...emptyComposerState(),
        pendingSends: [
          {
            clientId: "local",
            intent: "steer",
            draft: { text: withReferenceDraft(text, references), images: [] },
            status: "unconfirmed",
            error: null,
          },
        ],
      },
    });
    for (const selector of [".queue-row", ".pending-send-row"]) {
      const row = document.querySelector(selector)!;
      assert.equal(row.querySelector("strong")?.textContent, "this");
      assert.equal(
        row
          .querySelector('[data-reference-kind="thread"]')
          ?.textContent?.includes("Source thread"),
        true,
      );
      assert.doesNotMatch(
        row.textContent!,
        /zenx-references:|zenx-selected-reference/,
      );
    }
  });
});

test("typed queued question replies keep authored question bubbles in both pending groups", async () => {
  const { parseUserQuestionSpecification, renderUserQuestionReply } =
    await import("../../../src/user-question.js");
  const { applyQueueItem, queueItem } =
    await import("./fixtures/agent-queue-data.js");
  const specification = parseUserQuestionSpecification({
    questions: [
      {
        id: "scope",
        prompt: "Which scope?",
        options: [{ id: "all", label: "All changes" }],
      },
    ],
  });
  const reply = {
    version: 1 as const,
    outcome: "answer" as const,
    request: { threadId: "runtime-thread", callItemId: "call-question" },
    answers: [
      {
        questionId: "scope",
        optionIds: ["all"],
        text: "Keep **literal** text",
      },
    ],
  };
  for (const steer of [false, true]) {
    await withRuntimeDom(async (h) => {
      let thread = queueScenario(0);
      thread = applyQueueItem(thread, {
        type: "tool_call",
        id: "call-question",
        threadId: thread.id,
        turnId: "runtime-turn",
        createdAt: "2026-11-08T00:00:00Z",
        callId: "question-rpc",
        name: "ask_user_question",
        arguments: specification as unknown as Record<string, unknown>,
      });
      thread = applyQueueItem(thread, {
        ...queueItem(12, [
          { type: "text", text: renderUserQuestionReply(specification, reply) },
        ]),
        questionReply: reply,
        ...(steer
          ? { deliveryMode: "steer", expectedTurnId: "runtime-turn" }
          : {}),
      });
      await h.render(thread);
      const row = document.querySelector(
        steer ? ".steer-shelf-row" : '[data-queue-id="queue-12"]',
      )!;
      assert.equal(
        row.querySelector(".answered-question-trigger")?.textContent,
        "Which scope?",
      );
      assert.match(
        row.querySelector(".answered-question-answer")?.textContent ?? "",
        /All changesKeep \*\*literal\*\* text/,
      );
      assert.doesNotMatch(row.textContent!, /Reply to question/);
    });
  }
});

test("move controls submit an exact native order snapshot and wait for the canonical reorder", async () => {
  const { act } = await import("./agent-runtime-dom.js");
  const { applyQueueItem } = await import("./fixtures/agent-queue-data.js");
  await withRuntimeDom(async (h) => {
    let thread = queueScenario(0);
    let request: any;
    let finish!: (value: any) => void;
    await h.render(thread, {
      onReorderQueued: (params) => {
        request = params;
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
    });
    const before = [
      ...document.querySelectorAll<HTMLElement>(".queue-row"),
    ].map((row) => row.dataset.queueId);
    await h.click('[data-queue-id="queue-1"] [data-queue-control="move-up"]');
    assert.deepEqual(request.expectedTargets, [
      {
        queuedItemId: "queue-0",
        clientId: "queue-client-0",
        expectedRevision: 0,
      },
      {
        queuedItemId: "queue-1",
        clientId: "queue-client-1",
        expectedRevision: 0,
      },
    ]);
    assert.deepEqual(request.orderedQueuedItemIds, ["queue-1", "queue-0"]);
    assert.deepEqual(
      [...document.querySelectorAll<HTMLElement>(".queue-row")].map(
        (row) => row.dataset.queueId,
      ),
      before,
    );
    assert.ok(
      [
        ...document.querySelectorAll<HTMLButtonElement>(
          ".queue-row-actions button",
        ),
      ].every((button) => button.disabled),
    );
    await act(async () =>
      finish({ status: "reordered", reorderItemId: "reorder-receipt" }),
    );
    assert.equal(
      document.querySelector<HTMLButtonElement>(
        '[data-queue-control="move-up"]',
      )!.disabled,
      true,
    );
    thread = applyQueueItem(thread, {
      type: "user_message_queue_reordered",
      id: "reorder-receipt",
      threadId: thread.id,
      createdAt: "2026-11-08T00:00:00Z",
      reorderId: request.reorderId,
      expectedTargets: request.expectedTargets,
      orderedQueuedItemIds: request.orderedQueuedItemIds,
    });
    await h.render(thread, {
      onReorderQueued: async () => ({
        status: "reordered",
        reorderItemId: "unused",
      }),
    });
    assert.deepEqual(
      [...document.querySelectorAll<HTMLElement>(".queue-row")].map(
        (row) => row.dataset.queueId,
      ),
      ["queue-1", "queue-0"],
    );
    assert.equal(
      document.querySelector<HTMLButtonElement>(
        '[data-queue-id="queue-0"] [data-queue-control="move-up"]',
      )!.disabled,
      false,
    );
  });
});

test("Queue promotion enters the upper Steer group at the same identity and remains atomically recallable", async () => {
  const { act } = await import("./agent-runtime-dom.js");
  const { applyQueueItem } = await import("./fixtures/agent-queue-data.js");
  const { recoverSteerRecall } = await import("../../../src/steer-recall.js");
  await withRuntimeDom(async (h) => {
    let thread = queueScenario(0);
    let target: any;
    const props = {
      onSteerQueued: async (params: any) => {
        target = params;
        return {
          ...params,
          status: "staged" as const,
          turnId: "runtime-turn",
          revision: 1,
          promotionItemId: "promoted",
        };
      },
      onRestoreRecalled: () => true,
    };
    await h.render(thread, props);
    await h.click('[data-queue-id="queue-1"] .queue-row-steer');
    assert.equal(
      document.querySelector(".steer-shelf"),
      null,
      "an RPC receipt is not a consumed/canonical UI row",
    );
    thread = applyQueueItem(thread, {
      type: "user_message_queue_promoted",
      id: "promoted",
      threadId: thread.id,
      createdAt: "2026-11-08T00:00:00Z",
      ...target,
      expectedTurnId: "runtime-turn",
    });
    await h.render(thread, props);
    assert.equal(document.querySelector('[data-queue-id="queue-1"]'), null);
    assert.match(
      document.querySelector(".steer-shelf-row")!.textContent!,
      /窄屏布局/u,
    );
    assert.equal(
      document.querySelector<HTMLButtonElement>(
        ".pending-steer-heading .queue-header-action",
      )!.disabled,
      false,
    );
    Object.defineProperty(window, "zenx", {
      configurable: true,
      value: {
        protocol: {
          request: async (method: string, request: any) => {
            assert.equal(method, "zen/thread/steer/recall");
            assert.deepEqual(request.targets, [
              {
                queuedItemId: "queue-1",
                clientId: "queue-client-1",
                expectedRevision: 1,
              },
            ]);
            const receipt = {
              type: "user_message_steer_recalled" as const,
              id: "recalled-promoted",
              threadId: thread.id,
              createdAt: "2026-11-08T00:00:01Z",
              recallId: request.recallId,
              targets: request.targets,
            };
            return {
              ...recoverSteerRecall(
                [...thread.canonicalItems!, receipt],
                thread.id,
                request.recallId,
              )!,
              status: "recalled",
            };
          },
        },
      },
    });
    await h.click(".pending-steer-heading .queue-header-action");
    assert.equal(document.querySelectorAll(".steer-shelf-row").length, 0);
  });
});

test("unknown mutation stays locked across Thread switches and late replies and manual checking never resends", async () => {
  const { act } = await import("./agent-runtime-dom.js");
  const { createQueueMutationStore, QueueMutationUnknownError } =
    await import("../src/renderer/src/queue-mutation-state.js");
  const store = createQueueMutationStore();
  let reject!: (error: Error) => void;
  let calls = 0;
  const a = queueScenario(0);
  const b = { ...queueScenario(0), id: "other-thread" };
  const props = {
    queueMutationStore: store,
    onReorderQueued: async () => {
      calls++;
      return new Promise<any>((_resolve, fail) => {
        reject = fail;
      });
    },
  };
  await withRuntimeDom(async (h) => {
    await h.render(a, props);
    await h.click('[data-queue-id="queue-1"] [data-queue-control="move-up"]');
    await h.render(b, props);
    await act(async () =>
      reject(new QueueMutationUnknownError("A outcome unknown")),
    );
    assert.doesNotMatch(document.body.textContent!, /A outcome unknown/);
    await h.render(a, props);
    assert.match(
      document.querySelector(".queue-mutation-status")!.textContent!,
      /A outcome unknown/,
    );
    assert.ok(
      [
        ...document.querySelectorAll<HTMLButtonElement>(
          ".queue-row-actions button",
        ),
      ].every((button) => button.disabled),
    );
    const requests: string[] = [];
    Object.defineProperty(window, "zenx", {
      configurable: true,
      value: {
        protocol: {
          request: async (method: string) => {
            requests.push(method);
            return { thread: { id: a.id, items: a.canonicalItems } };
          },
        },
      },
    });
    await h.click(".queue-mutation-status button");
    assert.deepEqual(requests, ["zen/thread/read"]);
    assert.equal(calls, 1);
    assert.equal(store.getSnapshot()[a.id]?.phase, "unknown");
  });
  await withRuntimeDom(async (h) => {
    await h.render(a, props);
    assert.ok(
      document.querySelector(".queue-mutation-status"),
      "App-owned unknown state survives viewport unmount",
    );
    assert.equal(calls, 1);
  });
});

test("pending file references use the ordinary message link handler without submitting input", async () => {
  const { referenceMessage } =
    await import("../src/renderer/src/reference-draft.js");
  const { applyQueueItem, queueItem } =
    await import("./fixtures/agent-queue-data.js");
  await withRuntimeDom(async (h) => {
    const opened: unknown[] = [];
    const thread = applyQueueItem(
      queueScenario(0),
      queueItem(30, [
        {
          type: "text",
          text: referenceMessage(
            "Inspect this file",
            [
              {
                kind: "file",
                name: "source.ts",
                cwd: "/synthetic",
                path: "source.ts",
              },
            ],
            "queue-client-30",
          ),
        },
      ]),
    );
    await h.render(thread, {
      onOpenMessageLink: (target) => opened.push(target),
    });
    await h.click('[data-queue-id="queue-30"] .reference-token-details');
    await h.click(".reference-open-source");
    assert.deepEqual(opened, [{ kind: "file", value: "/synthetic/source.ts" }]);
  });
});
