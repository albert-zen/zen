import type {
  NativeQuestionListParams,
  NativeQuestionListResult,
  NativeQuestionReadParams,
  NativeQuestionReadResult,
  NativeQuestionRespondParams,
  NativeQuestionRespondResult,
} from "../../../../../src/protocol/native/wire.js";
import type {
  UserQuestionState,
  UserQuestionPage,
} from "../../../../../src/user-question-state.js";
import {
  normalizeUserQuestionReply,
  type UserQuestionAnswer,
  type UserQuestionReply,
} from "../../../../../src/user-question.js";
import {
  unwrapQuestionIpcReply,
  type QuestionIpcError,
} from "../../preload/user-question-ipc.js";
import { localErrorDetail } from "../../local-error-detail.js";

export interface QuestionTransport {
  list(
    params: NativeQuestionListParams,
  ): Promise<NativeQuestionListResult | QuestionIpcError>;
  read(
    params: NativeQuestionReadParams,
  ): Promise<NativeQuestionReadResult | QuestionIpcError>;
  respond(
    params: NativeQuestionRespondParams,
  ): Promise<NativeQuestionRespondResult | QuestionIpcError>;
}
export interface QuestionDraft {
  revision: number;
  answers: UserQuestionAnswer[];
}
export interface QuestionAttempt {
  request: NativeQuestionRespondParams;
  draftRevision: number;
  observation: number;
  phase:
    "sending" | "unknown" | "pending" | "claimed" | "withdrawn" | "rejected";
  error?: string;
  detail?: string;
}
export interface QuestionView {
  question: UserQuestionState;
  draft: QuestionDraft;
  attempt?: QuestionAttempt;
}
export interface QuestionAttention {
  cards: Readonly<Record<string, QuestionView>>;
  ids: readonly string[];
  totalPending: number;
  nextAfter?: string;
  loaded: boolean;
  loading: boolean;
  error?: string;
}
const empty: QuestionAttention = {
  cards: {},
  ids: [],
  totalPending: 0,
  loaded: false,
  loading: false,
};
const blankDraft = (question: UserQuestionState): QuestionDraft => ({
  revision: 0,
  answers: question.specification.questions.map((q) => ({
    questionId: q.id,
    optionIds: [],
  })),
});
export function draftReply(view: QuestionView): UserQuestionReply {
  return normalizeUserQuestionReply(view.question.specification, {
    version: 1,
    request: view.question.request,
    outcome: "answer",
    answers: view.draft.answers,
  });
}
export const questionBusy = (view: QuestionView) =>
  view.attempt?.phase === "sending" || view.attempt?.phase === "unknown";

/** Disposable, App-owned drafts and bounded native attention reads, never a delivery authority. */
export function createUserQuestionStore(
  transport: QuestionTransport,
  createId: () => string = () => crypto.randomUUID(),
) {
  const states = new Map<string, QuestionAttention>();
  const versions = new Map<string, number>();
  const readers = new Map<string, number>();
  const reads = new Map<string, Promise<void>>();
  const listeners = new Set<() => void>();
  const get = (threadId: string) => states.get(threadId) ?? empty;
  const publish = (threadId: string, state: QuestionAttention) => {
    states.set(threadId, state);
    for (const listener of listeners) listener();
  };
  const updateCard = (
    threadId: string,
    id: string,
    update: (view: QuestionView) => QuestionView,
  ) => {
    const state = get(threadId),
      view = state.cards[id];
    if (view)
      publish(threadId, {
        ...state,
        cards: { ...state.cards, [id]: update(view) },
      });
  };
  const applyPage = (
    threadId: string,
    page: UserQuestionPage,
    append: boolean,
  ) => {
    if (
      page.questions.length > 32 ||
      page.questions.some((q) => q.request.threadId !== threadId)
    )
      throw new Error("Mismatched question attention page");
    const state = get(threadId),
      cards = { ...state.cards };
    const ids = append ? [...state.ids] : [];
    for (const question of page.questions) {
      const id = question.request.callItemId;
      const previous = cards[id];
      cards[id] = previous
        ? { ...previous, question }
        : { question, draft: blankDraft(question) };
      if (!ids.includes(id)) ids.push(id);
    }
    // A vanished list entry cannot establish the outcome of an exact in-flight intent.
    for (const [id, view] of Object.entries(cards))
      if (questionBusy(view) && !ids.includes(id)) ids.push(id);
    publish(threadId, {
      ...state,
      cards,
      ids,
      totalPending: page.totalPending,
      nextAfter: page.nextAfter,
      loaded: true,
      error: undefined,
    });
  };
  const refresh = (threadId: string): Promise<void> => {
    const existing = reads.get(threadId);
    if (existing) return existing;
    const run = async () => {
      let version: number;
      do {
        version = versions.get(threadId) ?? 0;
        publish(threadId, {
          ...get(threadId),
          loading: true,
          nextAfter: undefined,
          error: undefined,
        });
        try {
          const page = unwrapQuestionIpcReply(
            await transport.list({ threadId }),
          );
          if (version === (versions.get(threadId) ?? 0))
            applyPage(threadId, page, false);
        } catch (error) {
          if (version === (versions.get(threadId) ?? 0))
            publish(threadId, {
              ...get(threadId),
              error: localErrorDetail(error),
            });
        }
      } while (
        version !== (versions.get(threadId) ?? 0) &&
        (readers.get(threadId) ?? 0) > 0
      );
    };
    // Defer start so even a synchronously throwing transport has an in-flight fence.
    const promise = Promise.resolve()
      .then(run)
      .finally(() => {
        reads.delete(threadId);
        publish(threadId, { ...get(threadId), loading: false });
      });
    reads.set(threadId, promise);
    return promise;
  };
  const invalidate = (threadId: string) => {
    versions.set(threadId, (versions.get(threadId) ?? 0) + 1);
    publish(threadId, { ...get(threadId), nextAfter: undefined });
    if ((readers.get(threadId) ?? 0) > 0) void refresh(threadId);
  };
  const matchingAttempt = (
    threadId: string,
    id: string,
    attempt: QuestionAttempt,
  ) =>
    get(threadId).cards[id]?.attempt?.request.clientUserMessageId ===
      attempt.request.clientUserMessageId &&
    get(threadId).cards[id]?.attempt?.observation === attempt.observation;
  const settle = (
    threadId: string,
    id: string,
    attempt: QuestionAttempt,
    patch: Partial<QuestionAttempt>,
    question?: UserQuestionState,
  ) => {
    if (!matchingAttempt(threadId, id, attempt)) return;
    if (
      question &&
      (question.request.threadId !== threadId ||
        question.request.callItemId !== id)
    )
      throw new Error("Mismatched question readback");
    updateCard(threadId, id, (view) => ({
      ...view,
      ...(question ? { question } : {}),
      attempt: { ...attempt, ...patch },
    }));
  };
  return {
    get,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    mount(threadId: string) {
      readers.set(threadId, (readers.get(threadId) ?? 0) + 1);
      void refresh(threadId);
      return () => {
        readers.set(threadId, Math.max(0, (readers.get(threadId) ?? 1) - 1));
      };
    },
    refresh,
    invalidate,
    disconnect() {
      for (const [threadId, state] of states) {
        versions.set(threadId, (versions.get(threadId) ?? 0) + 1);
        const cards = Object.fromEntries(
          Object.entries(state.cards).map(([id, view]) => [
            id,
            view.attempt?.phase === "sending"
              ? {
                  ...view,
                  attempt: { ...view.attempt, phase: "unknown" as const },
                }
              : view,
          ]),
        );
        publish(threadId, { ...state, cards, nextAfter: undefined });
      }
    },
    async loadMore(threadId: string) {
      const state = get(threadId),
        after = state.nextAfter;
      if (!after || state.loading || reads.has(threadId)) return;
      const version = versions.get(threadId) ?? 0;
      publish(threadId, { ...state, loading: true, error: undefined });
      try {
        const page = unwrapQuestionIpcReply(
          await transport.list({ threadId, afterQuestionCallItemId: after }),
        );
        if (
          version === (versions.get(threadId) ?? 0) &&
          get(threadId).nextAfter === after
        )
          applyPage(threadId, page, true);
      } catch (error) {
        if (version === (versions.get(threadId) ?? 0))
          publish(threadId, {
            ...get(threadId),
            error: localErrorDetail(error),
          });
      } finally {
        if (!reads.has(threadId))
          publish(threadId, { ...get(threadId), loading: false });
      }
    },
    edit(threadId: string, id: string, answers: UserQuestionAnswer[]) {
      updateCard(threadId, id, (view) => ({
        ...view,
        draft: { revision: view.draft.revision + 1, answers },
      }));
    },
    async respond(threadId: string, id: string, outcome: "answer" | "cancel") {
      const view = get(threadId).cards[id];
      if (!view || view.question.state !== "open" || questionBusy(view)) return;
      const reply =
        outcome === "answer"
          ? draftReply(view)
          : { outcome: "cancel" as const };
      const request: NativeQuestionRespondParams = {
        threadId,
        questionCallItemId: id,
        clientUserMessageId: createId(),
        clientTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        ...(reply.outcome === "answer"
          ? { outcome: "answer", answers: reply.answers }
          : { outcome: "cancel" }),
      };
      const attempt: QuestionAttempt = {
        request,
        draftRevision: view.draft.revision,
        observation: 0,
        phase: "sending",
      };
      updateCard(threadId, id, (current) => ({ ...current, attempt }));
      try {
        const result = unwrapQuestionIpcReply(await transport.respond(request));
        const question = result.question;
        if (question.response?.clientId !== request.clientUserMessageId)
          throw new Error(
            "Question receipt does not confirm this response identity",
          );
        if (question.state === "open" || question.state === "unavailable")
          throw new Error("Question response outcome is unconfirmed");
        settle(
          threadId,
          id,
          attempt,
          {
            phase:
              question.state === "answer-pending" ||
              question.state === "cancel-pending"
                ? "pending"
                : "claimed",
          },
          question,
        );
        invalidate(threadId);
      } catch (error) {
        settle(threadId, id, attempt, {
          phase:
            (error as { questionRejected?: boolean })?.questionRejected === true
              ? "rejected"
              : "unknown",
          error: error instanceof Error ? error.message : String(error),
          detail: localErrorDetail(error),
        });
      }
    },
    async check(threadId: string, id: string) {
      const previous = get(threadId).cards[id]?.attempt;
      if (!previous) return;
      const attempt = { ...previous, observation: previous.observation + 1 };
      updateCard(threadId, id, (view) => ({ ...view, attempt }));
      try {
        const result = unwrapQuestionIpcReply(
          await transport.read({
            threadId,
            questionCallItemId: id,
            clientUserMessageId: attempt.request.clientUserMessageId,
          }),
        );
        if (result.response.clientId !== attempt.request.clientUserMessageId)
          throw new Error("Mismatched response client identity");
        const status = result.response.status;
        if (["pending", "claimed", "withdrawn"].includes(status)) {
          const expected = {
            version: 1,
            request: { threadId, callItemId: id },
            ...(attempt.request.outcome === "answer"
              ? { outcome: "answer", answers: attempt.request.answers }
              : { outcome: "cancel" }),
          };
          if (
            JSON.stringify(result.response.reply) !== JSON.stringify(expected)
          )
            throw new Error(
              "Question readback does not match the original response payload",
            );
        }

        // not-found does not prove a write still in flight cannot commit.
        const phase =
          status === "pending" || status === "claimed" || status === "withdrawn"
            ? status
            : "unknown";
        settle(
          threadId,
          id,
          attempt,
          { phase, error: undefined, detail: undefined },
          result.question,
        );
        if (phase !== "unknown") invalidate(threadId);
      } catch (error) {
        settle(threadId, id, attempt, {
          phase: "unknown",
          error: error instanceof Error ? error.message : String(error),
          detail: localErrorDetail(error),
        });
      }
    },
  };
}
export type UserQuestionStore = ReturnType<typeof createUserQuestionStore>;
