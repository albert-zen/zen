import assert from "node:assert/strict";
import test from "node:test";
import type { QueuedUserMessageItem } from "../../../src/item.js";
import type { UserQuestionState } from "../../../src/user-question-state.js";
import type { UserQuestionReply } from "../../../src/user-question.js";
import { recoverSteerRecall } from "../../../src/steer-recall.js";
import {
  recallTargets,
  restoreRecalledComposer,
} from "../src/renderer/src/steer-recall-state.js";
import { createUserQuestionStore } from "../src/renderer/src/user-question-state.js";
import {
  editComposer,
  emptyComposerState,
} from "../src/renderer/src/composer-state.js";

const question: UserQuestionState = {
  request: { threadId: "t", callItemId: "ask" },
  resultItemId: "published",
  createdAt: "2026-11-02T00:00:00Z",
  state: "open",
  specification: {
    questions: [
      { id: "q", prompt: "Which scope?", options: [{ id: "a", label: "A" }] },
    ],
    answerTemplate: "{{q}}",
  },
};
function receipt(outcome: "answer" | "cancel" = "answer") {
  const reply: UserQuestionReply = {
    version: 1,
    request: question.request,
    ...(outcome === "answer"
      ? {
          outcome,
          answers: [
            { questionId: "q", optionIds: ["a"], text: "original answer" },
          ],
        }
      : { outcome }),
  };
  const common = {
    threadId: "t",
    createdAt: question.createdAt,
    type: "user_message_queued" as const,
    deliveryMode: "steer" as const,
    expectedTurnId: "turn",
  };
  const messages: QueuedUserMessageItem[] = [
    {
      ...common,
      id: "ordinary",
      clientId: "ordinary-client",
      input: [{ type: "text", text: "Ordinary original" }],
    },
    {
      ...common,
      id: "answer",
      clientId: "answer-client",
      input: [
        {
          type: "text",
          text: "Backend-rendered question reply must never enter Composer",
        },
      ],
      questionReply: reply,
    },
  ];
  return recoverSteerRecall(
    [
      ...messages,
      {
        type: "user_message_steer_recalled",
        id: "receipt",
        threadId: "t",
        createdAt: question.createdAt,
        recallId: "recall",
        targets: recallTargets(messages),
      },
    ],
    "t",
    "recall",
  )!;
}
function setup(result = receipt(), currentQuestion = question) {
  const store = createUserQuestionStore({
    list: async () => ({ questions: [currentQuestion], totalPending: 1 }),
    respond: async () => {
      throw new Error("Restoring must never send");
    },
    read: async (params) => ({
      question: currentQuestion,
      response: {
        clientId: params.clientUserMessageId,
        status: "withdrawn",
        reply: result.messages[1]!.questionReply!,
      },
    }),
  });
  return { store, result };
}

test("one confirmed mixed receipt restores every destination; question text never enters the ordinary Composer", async () => {
  const { store, result } = setup();
  await store.refresh("t");
  let composer = editComposer(emptyComposerState(), "Newer ordinary draft");
  const plan = await store.prepareRecall(result);
  assert.ok(plan);
  assert.equal(
    composer.draft.text,
    "Newer ordinary draft",
    "preflight cannot insert anything",
  );
  assert.equal(
    store.commitRecall(plan, () => {
      composer = restoreRecalledComposer(composer, result, () => "new-image");
      return true;
    }),
    true,
  );
  assert.equal(
    composer.draft.text,
    "Ordinary original\n\nNewer ordinary draft",
  );
  assert.deepEqual(store.get("t").cards.ask!.draft.answers, [
    { questionId: "q", optionIds: ["a"], text: "original answer" },
  ]);
  assert.equal(
    store.commitRecall(plan, () => {
      throw new Error(
        "Already changed destination must reject before another Composer merge",
      );
    }),
    false,
  );
});

for (const interruption of [
  "new-question-draft",
  "new-attention-generation",
  "composer-unavailable",
] as const) {
  test(`mixed restoration is all-or-none when ${interruption}`, async () => {
    const { store, result } = setup();
    await store.refresh("t");
    const before = store.get("t").cards.ask!.draft;
    const plan = await store.prepareRecall(result);
    assert.ok(plan);
    if (interruption === "new-question-draft")
      store.edit("t", "ask", [
        { questionId: "q", optionIds: [], text: "New independent draft" },
      ]);
    if (interruption === "new-attention-generation") store.invalidate("t");
    let merges = 0;
    const restored = store.commitRecall(plan, () => {
      merges++;
      return false;
    });
    assert.equal(restored, false);
    assert.equal(merges, interruption === "composer-unavailable" ? 1 : 0);
    if (interruption !== "new-question-draft")
      assert.equal(store.get("t").cards.ask!.draft, before);
    else
      assert.equal(
        store.get("t").cards.ask!.draft.answers[0]!.text,
        "New independent draft",
      );
  });
}

test("a newer question draft or other-client response blocks the whole batch rather than overwriting", async () => {
  const { store, result } = setup();
  await store.refresh("t");
  store.edit("t", "ask", [
    { questionId: "q", optionIds: ["a"], text: "New draft" },
  ]);
  assert.equal(await store.prepareRecall(result), null);
  const closed = setup(result, { ...question, state: "answered" });
  await closed.store.refresh("t");
  assert.equal(await closed.store.prepareRecall(result), null);
});

test("cancel restoration keeps the local pre-cancel draft; cold recovery never invents one", async () => {
  const { store, result } = setup(receipt("cancel"));
  await store.refresh("t");
  store.edit("t", "ask", [
    { questionId: "q", optionIds: ["a"], text: "Preserved local draft" },
  ]);
  const draft = store.get("t").cards.ask!.draft;
  const plan = await store.prepareRecall(result);
  assert.ok(plan);
  assert.equal(
    store.commitRecall(plan, () => true),
    true,
  );
  assert.equal(store.get("t").cards.ask!.draft, draft);
  const cold = setup(result);
  const recovered = await cold.store.prepareRecall(result);
  assert.ok(recovered);
  assert.equal(
    cold.store.commitRecall(recovered, () => true),
    true,
  );
  assert.deepEqual(cold.store.get("t").cards.ask!.draft.answers, [
    { questionId: "q", optionIds: [] },
  ]);
});

test("one unavailable question origin blocks every destination in a multiple-question batch", async () => {
  const original = receipt();
  const second: QueuedUserMessageItem = {
    ...original.messages[1]!,
    id: "second-answer",
    clientId: "second-client",
    questionReply: {
      ...original.messages[1]!.questionReply!,
      request: { threadId: "t", callItemId: "second-ask" },
    },
  };
  const messages = [...original.messages, second];
  const result = recoverSteerRecall(
    [...messages, { ...original.receipt, targets: recallTargets(messages) }],
    "t",
    "recall",
  )!;
  let reads = 0;
  const store = createUserQuestionStore({
    list: async () => ({ questions: [question], totalPending: 1 }),
    respond: async () => {
      throw new Error("Must not send");
    },
    read: async (params) => {
      reads++;
      const second = params.questionCallItemId === "second-ask";
      return {
        question: {
          ...question,
          request: { threadId: "t", callItemId: params.questionCallItemId },
          state: second ? "answered" : "open",
        },
        response: {
          clientId: params.clientUserMessageId,
          status: "withdrawn",
          reply: messages[second ? 2 : 1]!.questionReply!,
        },
      };
    },
  });
  await store.refresh("t");
  const before = store.get("t");
  assert.equal(await store.prepareRecall(result), null);
  assert.equal(reads, 2);
  assert.equal(
    store.get("t"),
    before,
    "not even the available card is partially restored",
  );
});

test("an unavailable exact withdrawal read keeps the whole confirmed receipt unapplied", async () => {
  const result = receipt();
  const store = createUserQuestionStore({
    list: async () => ({ questions: [question], totalPending: 1 }),
    respond: async () => {
      throw new Error("Must not send");
    },
    read: async () => {
      throw new Error("Synthetic lost read");
    },
  });
  await store.refresh("t");
  const before = store.get("t");
  assert.equal(await store.prepareRecall(result), null);
  assert.equal(store.get("t"), before);
});

test("a page already in flight cannot be overwritten between two exact origin reads", async () => {
  const original = receipt();
  const second: QueuedUserMessageItem = {
    ...original.messages[1]!,
    id: "second-answer",
    clientId: "second-client",
    questionReply: {
      ...original.messages[1]!.questionReply!,
      request: { threadId: "t", callItemId: "second-ask" },
    },
  };
  const messages = [...original.messages, second];
  const result = recoverSteerRecall(
    [...messages, { ...original.receipt, targets: recallTargets(messages) }],
    "t",
    "recall",
  )!;
  const otherQuestion = { ...question, request: second.questionReply!.request };
  let finishPage!: (value: {
    questions: UserQuestionState[];
    totalPending: number;
  }) => void;
  const page = new Promise<{
    questions: UserQuestionState[];
    totalPending: number;
  }>((resolve) => {
    finishPage = resolve;
  });
  let finishRead!: () => void;
  const read = new Promise<void>((resolve) => {
    finishRead = resolve;
  });
  let lists = 0;
  const store = createUserQuestionStore({
    list: async () =>
      ++lists === 1
        ? { questions: [question, otherQuestion], totalPending: 2 }
        : page,
    respond: async () => {
      throw new Error("Must not send");
    },
    read: async (params) => {
      const second = params.questionCallItemId === "second-ask";
      if (second) await read;
      return {
        question: second ? otherQuestion : question,
        response: {
          clientId: params.clientUserMessageId,
          status: "withdrawn",
          reply: messages[second ? 2 : 1]!.questionReply!,
        },
      };
    },
  });
  await store.refresh("t");
  const inFlight = store.refresh("t"); // generation advances before prepare captures it
  const preparing = store.prepareRecall(result);
  await Promise.resolve();
  finishPage({
    questions: [{ ...question, state: "answered" }, otherQuestion],
    totalPending: 1,
  });
  await inFlight;
  finishRead();
  const plan = await preparing;
  assert.ok(plan);
  const before = store.get("t");
  let composer = editComposer(emptyComposerState(), "keep current Composer");
  const originalComposer = composer;
  const applied = new Set<string>();
  const restored = store.commitRecall(plan, () => {
    composer = restoreRecalledComposer(composer, result, () => "new-image");
    return true;
  });
  if (restored) applied.add(result.receipt.id);
  assert.equal(restored, false);
  assert.equal(composer, originalComposer);
  assert.equal(store.get("t"), before);
  assert.equal(store.get("t").cards.ask!.question.state, "answered");
  assert.equal(applied.size, 0);
});

for (const initial of ["empty", "new-draft"] as const) {
  test(`one ordinary + answer + cancel batch preserves images and quoted source with ${initial} Composer`, async () => {
    const { referenceMessage } =
      await import("../src/renderer/src/reference-draft.js");
    const { parseSkillDraft } =
      await import("../src/renderer/src/skill-draft.js");
    const { createSteerRecallStore } =
      await import("../src/renderer/src/steer-recall-state.js");
    const original = receipt();
    const text = "Ordinary quoted input \uFFFC";
    const quote = {
      kind: "message" as const,
      name: "Selected quote",
      cwd: "/synthetic",
      threadId: "source-thread",
      id: "source-item",
      excerpt: "Exact quoted text\nwith next line",
      position: text.length - 1,
    };
    const attachment = {
      type: "attachment" as const,
      sha256: "a".repeat(64),
      mediaType: "image/png" as const,
      byteLength: 68,
      width: 1,
      height: 1,
    };
    const ordinary: QueuedUserMessageItem = {
      ...original.messages[0]!,
      input: [
        {
          type: "text",
          text: referenceMessage(text, [quote], original.messages[0]!.clientId),
        },
        { type: "image", attachment },
        { type: "image", attachment },
      ],
    };
    const cancel: QueuedUserMessageItem = {
      ...original.messages[1]!,
      id: "cancel",
      clientId: "cancel-client",
      questionReply: {
        version: 1,
        request: { threadId: "t", callItemId: "cancel-ask" },
        outcome: "cancel",
      },
    };
    const messages = [ordinary, original.messages[1]!, cancel];
    const result = recoverSteerRecall(
      [...messages, { ...original.receipt, targets: recallTargets(messages) }],
      "t",
      "recall",
    )!;
    const cancelQuestion = {
      ...question,
      request: cancel.questionReply!.request,
    };
    const store = createUserQuestionStore({
      list: async () => ({
        questions: [question, cancelQuestion],
        totalPending: 2,
      }),
      respond: async () => {
        throw new Error("Restoration never sends");
      },
      read: async (params) => ({
        question:
          params.questionCallItemId === "ask" ? question : cancelQuestion,
        response: {
          clientId: params.clientUserMessageId,
          status: "withdrawn",
          reply: messages.find(
            (message) => message.clientId === params.clientUserMessageId,
          )!.questionReply!,
        },
      }),
    });
    await store.refresh("t");
    store.edit("t", "cancel-ask", [
      { questionId: "q", optionIds: ["a"], text: "Pre-cancel draft" },
    ]);
    const cancelDraft = store.get("t").cards["cancel-ask"]!.draft;
    let composer =
      initial === "empty"
        ? emptyComposerState()
        : editComposer(emptyComposerState(), "New independent typing");
    const applied = createSteerRecallStore();
    const plan = await store.prepareRecall(result);
    assert.ok(plan);
    const apply = () => {
      if (applied.getSnapshot().applied.has(result.receipt.id)) return false;
      const restored = store.commitRecall(plan, () => {
        composer = restoreRecalledComposer(composer, result, () =>
          crypto.randomUUID(),
        );
        return true;
      });
      if (restored) applied.applied(result.receipt.id);
      return restored;
    };
    assert.equal(apply(), true);
    const once = composer;
    assert.equal(apply(), false);
    assert.equal(composer, once);
    const parsed = parseSkillDraft(composer.draft.text);
    assert.equal(
      parsed.text,
      text + (initial === "empty" ? "" : "\n\nNew independent typing"),
    );
    assert.deepEqual(parsed.references, [quote]);
    assert.deepEqual(
      composer.draft.images.map((image) => image.attachment),
      [attachment, attachment],
    );
    assert.deepEqual(
      store.get("t").cards.ask!.draft.answers,
      original.messages[1]!.questionReply!.outcome === "answer"
        ? original.messages[1]!.questionReply!.answers
        : [],
    );
    assert.equal(store.get("t").cards["cancel-ask"]!.draft, cancelDraft);
    assert.equal(applied.getSnapshot().applied.size, 1);
  });
}

test("question-only recall does not touch or wait on an independently sending Composer", async () => {
  const { beginComposerSubmission } =
    await import("../src/renderer/src/composer-state.js");
  const original = receipt();
  const messages = [original.messages[1]!];
  const result = recoverSteerRecall(
    [...messages, { ...original.receipt, targets: recallTargets(messages) }],
    "t",
    "recall",
  )!;
  const store = createUserQuestionStore({
    list: async () => ({ questions: [question], totalPending: 1 }),
    respond: async () => {
      throw new Error("Restoration never sends");
    },
    read: async (params) => ({
      question,
      response: {
        clientId: params.clientUserMessageId,
        status: "withdrawn",
        reply: messages[0]!.questionReply!,
      },
    }),
  });
  const composer = beginComposerSubmission(
    editComposer(emptyComposerState(), "Independent sending input"),
    "start",
    null,
    () => "sending-client",
  );
  assert.equal(composer.submission?.status, "pending");
  assert.equal(
    restoreRecalledComposer(composer, result, () => "unused"),
    composer,
  );
  const plan = await store.prepareRecall(result);
  assert.ok(plan);
  assert.equal(
    store.commitRecall(plan, () => true),
    true,
  );
  assert.equal(composer.submission?.status, "pending");
  assert.equal(composer.draft.text, "Independent sending input");
  assert.deepEqual(store.get("t").cards.ask!.draft.answers, [
    { questionId: "q", optionIds: ["a"], text: "original answer" },
  ]);
});

test("a new explicit response attempt fences a prepared recall without touching any draft", async () => {
  const { store, result } = setup();
  await store.refresh("t");
  const plan = await store.prepareRecall(result);
  assert.ok(plan);
  await store.respond("t", "ask", "cancel");
  const before = store.get("t");
  assert.equal(
    store.commitRecall(plan, () => {
      throw new Error("No Composer merge is allowed");
    }),
    false,
  );
  assert.equal(store.get("t"), before);
});
