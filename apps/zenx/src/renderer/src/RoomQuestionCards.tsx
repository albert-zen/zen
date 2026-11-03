import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import type { NativeThreadSummary } from "../../../../../src/thread-summary.js";
import {
  createRoomQuestionStore,
  roomQuestionAnswers,
  type RoomQuestionStore,
  type RoomQuestionView,
} from "./room-question-state.js";
import { Icon } from "./icons.js";
import { useCommittedCallback } from "./use-committed-callback.js";

const windows = new WeakMap<object, Map<string, RoomQuestionStore>>();
function roomStore(roomId: string) {
  let stores = windows.get(window);
  if (!stores) {
    stores = new Map();
    windows.set(window, stores);
  }
  let store = stores.get(roomId);
  if (!store) {
    const api = () => {
      if (!window.zenx.roomQuestions)
        throw Error("Room question service unavailable");
      return window.zenx.roomQuestions;
    };
    store = createRoomQuestionStore(roomId, {
      list: (id, options) =>
        api().request({
          method: "list",
          roomId: id,
          ...(options ? { options } : {}),
        }),
      respond: (params) => api().request({ method: "respond", params }),
      readResponse: (id, questionId, clientId) =>
        api().request({
          method: "read-response",
          roomId: id,
          questionId,
          clientId,
        }),
    });
    stores.set(roomId, store);
  }
  return store;
}
/** Questions belong to this Room workspace, including when its author has left. */
export function RoomQuestionCards({
  roomId,
  members,
  threads,
}: {
  roomId: string;
  members: readonly { threadId: string; name?: string }[];
  threads: readonly NativeThreadSummary[];
}) {
  const { t } = useTranslation("panels");
  const store = useMemo(() => roomStore(roomId), [roomId]);
  const state = useSyncExternalStore(store.subscribe, store.get, store.get);
  useEffect(() => {
    let active = true;
    void store.refresh();
    const end = window.zenx.roomQuestions?.onChanged((id) => {
      if (active && id === roomId) void store.refresh();
    });
    return () => {
      active = false;
      end?.();
      store.disconnect();
    };
  }, [roomId, store]);
  if (state.loaded && !state.ids.length && !state.error) return null;
  return (
    <section
      className="conversation-information-section room-question-attention"
      data-question-room={roomId}
      data-question-revision={state.revision}
      data-question-open-count={state.openCount}
      aria-label={t("roomQuestionTitle")}
    >
      <header>
        <h3>{t("roomQuestionTitle")}</h3>
        <button
          type="button"
          className="icon-button"
          aria-label={t("refresh")}
          title={t("refresh")}
          disabled={state.loading}
          onClick={() => void store.refresh()}
        >
          <Icon name="reload" size={14} />
        </button>
      </header>
      {!state.loaded && !state.error ? (
        <p role="status">{t("boardLoading")}</p>
      ) : null}
      {state.error ? (
        <details className="user-question-error">
          <summary>{t("questionReadFailed")}</summary>
          <pre>{state.error}</pre>
        </details>
      ) : null}
      {state.ids.map((id) => {
        const view = state.cards[id];
        if (!view) return null;
        const member = members.find(
          (m) => m.threadId === view.question.origin.threadId,
        );
        const summary = threads.find(
          (value) => value.threadId === view.question.origin.threadId,
        );
        const name =
          member?.name ??
          (summary?.status !== "systemError" ? summary?.name : undefined);
        return (
          <RoomQuestionCard
            key={id}
            view={view}
            store={store}
            unavailable={Boolean(state.error) || !state.loaded}
            origin={
              member
                ? t("roomQuestionOrigin", {
                    name: name ?? t("roomQuestionMember"),
                  })
                : name
                  ? t("roomQuestionFormerOrigin", { name })
                  : t("roomQuestionSourceUnavailable")
            }
          />
        );
      })}
      {state.nextAfter ? (
        <button
          type="button"
          className="quiet-button"
          disabled={state.loading}
          onClick={() => void store.refresh(true)}
        >
          {t("questionMore", {
            loaded: state.ids.length,
            total: state.openCount,
          })}
        </button>
      ) : null}
    </section>
  );
}
function RoomQuestionCard({
  view,
  store,
  origin,
  unavailable,
}: {
  view: RoomQuestionView;
  store: RoomQuestionStore;
  origin: string;
  unavailable: boolean;
}) {
  const { t } = useTranslation("panels");
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const { question, draft, attempt } = view;
  const waiting = attempt && attempt.phase !== "rejected";
  const changed = draft.questionRevision !== question.revision;
  const disabled = unavailable || question.state !== "open" || Boolean(waiting);
  let valid = false;
  try {
    roomQuestionAnswers(view);
    valid = true;
  } catch {
    /* An incomplete answer is an ordinary draft. */
  }
  const committedEdit = useCommittedCallback(
    (questionId: string, patch: Parameters<RoomQuestionStore["edit"]>[2]) => {
      if (!disabled) store.edit(question.id, questionId, patch);
    },
  );
  const edit = (
    questionId: string,
    patch: Parameters<RoomQuestionStore["edit"]>[2],
  ) => {
    if (mounted.current) committedEdit(questionId, patch);
  };
  const committedRespond = useCommittedCallback(
    (outcome: "answer" | "cancel") => {
      if (!disabled && !changed) void store.respond(question.id, outcome);
    },
  );
  const respond = (outcome: "answer" | "cancel") => {
    if (mounted.current) committedRespond(outcome);
  };
  const committedReapply = useCommittedCallback(() => {
    if (!unavailable) void store.reapply(question.id);
  });
  return (
    <article
      className="user-question-card room-question-card"
      data-room-question-id={question.id}
      data-room-question-revision={question.revision}
    >
      <p className="user-question-status" role="status">
        {t(
          attempt?.phase === "sending"
            ? "roomQuestionSending"
            : attempt?.phase === "unknown"
              ? "questionUnknown"
              : attempt?.phase === "reviewed"
                ? "roomQuestionReviewed"
                : attempt?.phase === "rejected"
                  ? "questionFailed"
                  : "questionTitle",
        )}
      </p>
      <small className="room-question-origin">{origin}</small>
      {question.specification.questions.map((q) => {
        const answer = draft.answers.find((a) => a.questionId === q.id);
        return (
          <fieldset key={q.id} disabled={disabled || changed}>
            <legend>{q.prompt}</legend>
            {q.options?.map((option) => {
              const selected = answer?.optionIds.includes(option.id) ?? false;
              return (
                <label className="user-question-option" key={option.id}>
                  <input
                    type={q.multiSelect ? "checkbox" : "radio"}
                    name={JSON.stringify([question.roomId, question.id, q.id])}
                    checked={selected}
                    onChange={() =>
                      edit(q.id, {
                        optionIds: q.multiSelect
                          ? selected
                            ? answer!.optionIds.filter((id) => id !== option.id)
                            : [...(answer?.optionIds ?? []), option.id]
                          : [option.id],
                      })
                    }
                  />
                  <span>
                    <strong>{option.label}</strong>
                    {option.description ? (
                      <small>{option.description}</small>
                    ) : null}
                  </span>
                </label>
              );
            })}
            <label className="user-question-text">
              <span>{t("questionFreeText")}</span>
              <textarea
                rows={2}
                maxLength={8192}
                value={answer?.text ?? ""}
                onChange={(event) =>
                  edit(q.id, { text: event.target.value || undefined })
                }
              />
            </label>
          </fieldset>
        );
      })}
      {changed ? (
        <p role="status">
          {t("roomQuestionChanged")}{" "}
          <button
            type="button"
            className="quiet-button room-question-review"
            disabled={Boolean(waiting)}
            onClick={() => {
              if (mounted.current) store.review(question.id);
            }}
          >
            {t("roomQuestionReview")}
          </button>
        </p>
      ) : null}
      {attempt?.error ? (
        <details className="user-question-error">
          <summary>
            {t(
              attempt.phase === "unknown"
                ? "questionUnknown"
                : "questionFailed",
            )}
          </summary>
          <pre>{attempt.error}</pre>
        </details>
      ) : null}
      <div className="user-question-actions">
        {question.state === "open" ? (
          <>
            <button
              type="button"
              className="quiet-button"
              disabled={disabled || changed}
              onClick={() => respond("cancel")}
            >
              {t("questionCancel")}
            </button>
            <button
              type="button"
              className="primary-button"
              disabled={disabled || changed || !valid}
              onClick={() => respond("answer")}
            >
              {t("roomQuestionSend")}
            </button>
          </>
        ) : null}
        {attempt?.phase === "unknown" ? (
          <button
            type="button"
            className="quiet-button"
            disabled={unavailable}
            onClick={() => {
              if (mounted.current) void store.check(question.id);
            }}
          >
            {t("questionCheck")}
          </button>
        ) : null}
        {attempt?.phase === "reviewed" ? (
          <button
            type="button"
            className="quiet-button"
            disabled={unavailable}
            onClick={() => {
              if (mounted.current) committedReapply();
            }}
          >
            {t("roomQuestionReapply")}
          </button>
        ) : null}
      </div>
      <small className="user-question-draft-note">
        {t("roomQuestionReceiptNote")} {t("questionDraftNote")}
      </small>
    </article>
  );
}
