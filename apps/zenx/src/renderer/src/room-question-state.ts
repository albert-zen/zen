import type {
  RoomQuestion,
  RoomQuestionResponseInput,
  RoomQuestionResponseReadback,
  RoomQuestionWorkspace,
  RoomQuestionWorkspaceReadOptions,
} from "../../room-questions.js";
import {
  normalizeUserQuestionReply,
  type UserQuestionAnswer,
} from "../../../../../src/user-question.js";

export interface RoomQuestionTransport {
  list(
    roomId: string,
    options?: RoomQuestionWorkspaceReadOptions,
  ): Promise<RoomQuestionWorkspace>;
  respond(
    input: RoomQuestionResponseInput,
  ): Promise<RoomQuestionResponseReadback>;
  readResponse(
    roomId: string,
    questionId: string,
    clientId: string,
  ): Promise<RoomQuestionResponseReadback>;
}
export interface RoomQuestionView {
  question: RoomQuestion;
  draft: { questionRevision: number; answers: UserQuestionAnswer[] };
  attempt?: {
    request: RoomQuestionResponseInput;
    phase: "sending" | "unknown" | "reviewed" | "rejected";
    error?: string;
  };
}
export interface RoomQuestionAttention {
  loaded: boolean;
  loading: boolean;
  revision: number;
  openCount: number;
  ids: readonly string[];
  cards: Readonly<Record<string, RoomQuestionView>>;
  nextAfter?: string;
  error?: string;
}
const initial = (): RoomQuestionAttention => ({
  loaded: false,
  loading: false,
  revision: 0,
  openCount: 0,
  ids: [],
  cards: {},
});
const blank = (q: RoomQuestion) => ({
  questionRevision: q.revision,
  answers: q.specification.questions.map((value) => ({
    questionId: value.id,
    optionIds: [],
  })),
});
export function roomQuestionAnswers(
  view: RoomQuestionView,
): UserQuestionAnswer[] {
  if (view.draft.questionRevision !== view.question.revision)
    throw Error("Question changed; review the current version first");
  const reply = normalizeUserQuestionReply(view.question.specification, {
    version: 1,
    request: view.question.origin,
    outcome: "answer",
    answers: view.draft.answers,
  });
  if (reply.outcome !== "answer") throw Error("Expected Room question answers");
  return reply.answers;
}
/** Window-local drafts only. The Room journal is the sole question/response authority. */
export function createRoomQuestionStore(
  roomId: string,
  transport: RoomQuestionTransport,
  createId: () => string = () => crypto.randomUUID(),
) {
  let state = initial(),
    sequence = 0,
    connectionEpoch = 0;
  const listeners = new Set<() => void>();
  const publish = (next: RoomQuestionAttention) => {
    state = next;
    for (const listener of listeners) listener();
  };
  const update = (
    id: string,
    change: (view: RoomQuestionView) => RoomQuestionView,
  ) => {
    const view = state.cards[id];
    if (view)
      publish({ ...state, cards: { ...state.cards, [id]: change(view) } });
  };
  const exact = (q: RoomQuestion | null | undefined, id?: string) => {
    if (!q || q.roomId !== roomId || (id !== undefined && q.id !== id))
      throw Error("Mismatched Room question receipt");
    return q;
  };
  async function refresh(more = false) {
    const observed = ++sequence;
    const after = more ? state.nextAfter : undefined;
    if (more && !after) return;
    publish({ ...state, loading: true });
    try {
      const page = await transport.list(
        roomId,
        after
          ? {
              afterQuestionId: after,
              expectedWorkspaceRevision: state.revision,
            }
          : undefined,
      );
      if (observed !== sequence) return;
      if (
        page.roomId !== roomId ||
        !Number.isSafeInteger(page.revision) ||
        page.revision < state.revision
      )
        throw Error("Mismatched or stale Room workspace receipt");
      const cards = { ...state.cards };
      const ids = more ? [...state.ids] : [];
      for (const value of page.questions) {
        const q = exact(value);
        const previous = cards[q.id];
        cards[q.id] = previous
          ? { ...previous, question: q }
          : { question: q, draft: blank(q) };
        if (
          previous?.attempt?.phase === "reviewed" &&
          (q.state !== "open" ||
            q.revision !== previous.attempt.request.expectedRevision)
        )
          cards[q.id] = {
            ...cards[q.id]!,
            attempt: {
              ...previous.attempt,
              phase: "rejected",
              error: "The Room question changed; review its current state",
            },
          };
        if (!ids.includes(q.id)) ids.push(q.id);
      }
      // A list omission does not resolve an in-flight or unknown response.
      for (const [id, view] of Object.entries(cards))
        if (
          view.attempt &&
          view.attempt.phase !== "rejected" &&
          !ids.includes(id)
        )
          ids.push(id);
      publish({
        ...state,
        loaded: true,
        loading: false,
        revision: page.revision,
        openCount: page.openCount,
        ids,
        cards,
        nextAfter: page.nextAfter,
        error: undefined,
      });
    } catch (error) {
      if (observed === sequence)
        publish({
          ...state,
          loading: false,
          error: error instanceof Error ? error.message : String(error),
        });
    }
  }
  function acceptResponse(
    id: string,
    request: RoomQuestionResponseInput,
    value: RoomQuestionResponseReadback,
  ) {
    if (value.response.clientId !== request.clientId)
      throw Error("Mismatched Room response identity");
    if (value.response.status !== "saved")
      throw Error("Room response is not confirmed saved");
    const question = exact(value.question, id);
    if (
      question.response?.clientId !== request.clientId ||
      question.response.questionRevision !== request.expectedRevision ||
      question.response.outcome !== request.outcome ||
      (request.outcome === "answer" &&
        JSON.stringify(question.response.answers) !==
          JSON.stringify(request.answers)) ||
      question.state === "open"
    )
      throw Error("Mismatched Room response resource");
    update(id, (view) => ({ ...view, question, attempt: undefined }));
    publish({ ...state, ids: state.ids.filter((value) => value !== id) });
    void refresh();
  }
  async function submit(id: string, request: RoomQuestionResponseInput) {
    const epoch = connectionEpoch;
    update(id, (view) => ({ ...view, attempt: { request, phase: "sending" } }));
    // A read started before this write cannot authorize unknown-outcome recovery.
    ++sequence;
    publish({ ...state, loading: false });
    try {
      const result = await transport.respond(request);
      if (epoch !== connectionEpoch) return;
      acceptResponse(id, request, result);
    } catch (error) {
      if (epoch !== connectionEpoch) return;
      update(id, (view) =>
        view.attempt?.request.clientId === request.clientId
          ? {
              ...view,
              attempt: {
                request,
                phase:
                  (error as { roomQuestionRejected?: boolean })
                    ?.roomQuestionRejected === true
                    ? "rejected"
                    : "unknown",
                error: error instanceof Error ? error.message : String(error),
              },
            }
          : view,
      );
      if ((error as { roomQuestionRejected?: boolean })?.roomQuestionRejected)
        void refresh();
    }
  }
  return {
    get: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    refresh,
    disconnect() {
      ++sequence;
      ++connectionEpoch;
      const cards = Object.fromEntries(
        Object.entries(state.cards).map(([id, view]) => [
          id,
          view.attempt
            ? {
                ...view,
                attempt: {
                  ...view.attempt,
                  phase:
                    view.attempt.phase === "sending"
                      ? ("unknown" as const)
                      : view.attempt.phase,
                },
              }
            : view,
        ]),
      );
      publish({ ...state, cards, loading: false });
    },
    edit(id: string, questionId: string, patch: Partial<UserQuestionAnswer>) {
      update(id, (view) => ({
        ...view,
        draft: {
          ...view.draft,
          answers: view.draft.answers.map((answer) =>
            answer.questionId === questionId ? { ...answer, ...patch } : answer,
          ),
        },
      }));
    },
    review(id: string) {
      update(id, (view) => {
        if (view.attempt && view.attempt.phase !== "rejected") return view;
        return {
          ...view,
          attempt: undefined,
          draft: {
            questionRevision: view.question.revision,
            answers: view.question.specification.questions.map((q) => {
              const previous = view.draft.answers.find(
                (a) => a.questionId === q.id,
              );
              return {
                questionId: q.id,
                optionIds:
                  previous?.optionIds.filter((id) =>
                    q.options?.some((option) => option.id === id),
                  ) ?? [],
                ...(previous?.text ? { text: previous.text } : {}),
              };
            }),
          },
        };
      });
    },
    async respond(id: string, outcome: "answer" | "cancel") {
      const view = state.cards[id];
      if (
        !view ||
        view.question.state !== "open" ||
        (view.attempt && view.attempt.phase !== "rejected") ||
        view.draft.questionRevision !== view.question.revision
      )
        return;
      const request: RoomQuestionResponseInput = {
        roomId,
        questionId: id,
        expectedRevision: view.question.revision,
        clientId: createId(),
        outcome,
        ...(outcome === "answer" ? { answers: roomQuestionAnswers(view) } : {}),
      };
      await submit(id, request);
    },
    async check(id: string) {
      const previous = state.cards[id]?.attempt;
      if (!previous || previous.phase !== "unknown") return;
      // A newer check, page traversal or disconnect retires this observation.
      const attempt = { ...previous };
      const observed = sequence;
      update(id, (view) => ({ ...view, attempt }));
      try {
        const read = await transport.readResponse(
          roomId,
          id,
          attempt.request.clientId,
        );
        if (observed !== sequence || state.cards[id]?.attempt !== attempt)
          return;
        if (read.response.clientId !== attempt.request.clientId)
          throw Error("Mismatched Room response identity");
        if (
          read.question &&
          read.question.revision < state.cards[id]!.question.revision
        )
          throw Error("Stale Room question readback; check its current state");
        if (read.response.status === "saved")
          acceptResponse(id, attempt.request, read);
        else if (read.response.status === "not-found") {
          const question = exact(read.question, id);
          const unchanged =
            question.state === "open" &&
            question.revision === attempt.request.expectedRevision;
          update(id, (view) => ({
            ...view,
            question,
            attempt: {
              ...attempt,
              phase: unchanged ? "reviewed" : "rejected",
              error: unchanged
                ? undefined
                : "The Room question changed; review its current state",
            },
          }));
          if (!unchanged) void refresh();
        } else {
          if (read.question) exact(read.question, id);
          update(id, (view) => ({
            ...view,
            ...(read.question ? { question: read.question } : {}),
            attempt: {
              ...attempt,
              phase: "rejected",
              error: "Another response already resolved this Room question",
            },
          }));
          void refresh();
        }
      } catch (error) {
        if (observed !== sequence) return;
        update(id, (view) =>
          view.attempt === attempt
            ? {
                ...view,
                attempt: {
                  ...attempt,
                  error: error instanceof Error ? error.message : String(error),
                },
              }
            : view,
        );
      }
    },
    async reapply(id: string) {
      const view = state.cards[id];
      const attempt = view?.attempt;
      if (
        view &&
        attempt?.phase === "reviewed" &&
        view.question.state === "open" &&
        view.question.revision === attempt.request.expectedRevision
      )
        await submit(id, attempt.request);
    },
  };
}
export type RoomQuestionStore = ReturnType<typeof createRoomQuestionStore>;
