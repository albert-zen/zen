import { useQuestionReadRecovery } from "./use-question-read-recovery.js";
import {
  memo,
  useEffect,
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
} from "react";
import { useTranslation } from "react-i18next";
import { useCommittedCallback } from "./use-committed-callback.js";
import { Icon } from "./icons.js";
import {
  draftReply,
  questionBusy,
  type UserQuestionStore,
  type QuestionView,
} from "./user-question-state.js";

export const UserQuestionCards = memo(function UserQuestionCards({
  threadId,
  store,
  disabled = false,
}: {
  threadId: string;
  store: UserQuestionStore;
  disabled?: boolean;
}) {
  const { t } = useTranslation("panels");
  const state = useSyncExternalStore(
    store.subscribe,
    () => store.get(threadId),
    () => store.get(threadId),
  );
  useEffect(() => store.mount(threadId), [threadId, store]);
  useQuestionReadRecovery({
    owner: threadId,
    loading: state.loading,
    error: state.error,
    disabled: disabled,
    refresh: () => store.refresh(threadId),
  });
  if (state.loaded && state.ids.length === 0 && !state.error) return null;
  return (
    <section
      className="conversation-information-section user-question-attention"
      aria-label={t("questionTitle")}
    >
      <header>
        <h3 className="user-question-heading">
          <Icon name="question" size={15} />
          {t("questionTitle")}
        </h3>
      </header>
      {!state.loaded && !state.error ? (
        <p role="status">{t("boardLoading")}</p>
      ) : null}
      {state.error ? (
        <div className="user-question-read-error" role="status">
          <span>{t("questionLoadFailed")}</span>
          <button
            type="button"
            className="quiet-button question-read-retry"
            aria-label={t("questionRetryRead")}
            disabled={state.loading || disabled}
            onClick={() => void store.refresh(threadId)}
          >
            <Icon name="reload" size={14} />
            {t("questionRetry")}
          </button>
        </div>
      ) : null}
      {state.ids.map((id) =>
        state.cards[id] ? (
          <QuestionCard
            key={JSON.stringify([threadId, id])}
            view={state.cards[id]!}
            store={store}
            disabled={disabled}
          />
        ) : null,
      )}
      {state.nextAfter ? (
        <button
          type="button"
          className="quiet-button"
          disabled={state.loading}
          onClick={() => void store.loadMore(threadId)}
        >
          {t("questionMore", {
            loaded: state.ids.length,
            total: state.totalPending,
          })}
        </button>
      ) : null}
    </section>
  );
});

function QuestionCard({
  view,
  store,
  disabled,
}: {
  view: QuestionView;
  store: UserQuestionStore;
  disabled: boolean;
}) {
  const { t } = useTranslation("panels");
  const { question, draft, attempt } = view;
  const { threadId, callItemId } = question.request;
  let valid = false;
  try {
    draftReply(view);
    valid = true;
  } catch {
    /* Empty or incomplete is a normal draft. */
  }
  const busy = questionBusy(view);
  const unavailable = disabled || question.state !== "open";
  const status =
    attempt?.phase === "sending" ||
    attempt?.phase === "unknown" ||
    attempt?.phase === "rejected"
      ? attempt.phase
      : question.state;
  // Liveness is committed and cleared on unmount; writable ownership remains the
  // latest committed disabled/question props, never a render-time ref.
  const mounted = useRef(false);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const committedEdit = useCommittedCallback(
    (
      questionId: string,
      patch: Partial<QuestionView["draft"]["answers"][number]>,
    ) => {
      if (unavailable) return;
      store.edit(
        threadId,
        callItemId,
        draft.answers.map((answer) =>
          answer.questionId === questionId ? { ...answer, ...patch } : answer,
        ),
      );
    },
  );
  const edit = (
    questionId: string,
    patch: Partial<QuestionView["draft"]["answers"][number]>,
  ) => {
    if (mounted.current) committedEdit(questionId, patch);
  };
  const committedRespond = useCommittedCallback(
    (outcome: "answer" | "cancel") => {
      if (unavailable || busy || (outcome === "answer" && !valid)) return;
      void store.respond(threadId, callItemId, outcome);
    },
  );
  const respond = (outcome: "answer" | "cancel") => {
    if (mounted.current) committedRespond(outcome);
  };
  const committedCheck = useCommittedCallback(() => {
    if (!disabled) void store.check(threadId, callItemId);
  });
  return (
    <article className="user-question-card" data-question-call-id={callItemId}>
      {status !== "open" && (
        <p className="user-question-status" role="status">
          {t(`questionState.${status}`)}
        </p>
      )}
      {question.specification.questions.map((q) => {
        const answer = draft.answers.find((a) => a.questionId === q.id);
        return (
          <fieldset key={q.id} disabled={unavailable}>
            <legend>{q.prompt}</legend>
            {q.options?.length ? (
              <ul className="user-question-options">
                {q.options?.map((option) => {
                  const selected =
                    answer?.optionIds.includes(option.id) ?? false;
                  return (
                    <li key={option.id}>
                      <label
                        className="user-question-option"
                        data-selected={selected ? "true" : undefined}
                      >
                        <input
                          type={q.multiSelect ? "checkbox" : "radio"}
                          name={JSON.stringify([threadId, callItemId, q.id])}
                          checked={selected}
                          onChange={() =>
                            edit(q.id, {
                              optionIds: q.multiSelect
                                ? selected
                                  ? answer!.optionIds.filter(
                                      (id) => id !== option.id,
                                    )
                                  : [...(answer?.optionIds ?? []), option.id]
                                : [option.id],
                            })
                          }
                        />
                        <span
                          className="user-question-option-mark"
                          aria-hidden="true"
                        >
                          {selected ? <Icon name="check" size={12} /> : null}
                        </span>
                        <span className="user-question-option-copy">
                          <strong>{option.label}</strong>
                          {option.description ? (
                            <small>{option.description}</small>
                          ) : null}
                        </span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            ) : null}
            <label className="user-question-text">
              {q.options?.length ? (
                <span>{t("questionOptionalDetails")}</span>
              ) : null}
              <textarea
                aria-label={
                  q.options?.length
                    ? `${q.prompt} · ${t("questionOptionalDetails")}`
                    : q.prompt
                }
                rows={1}
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
      {attempt?.error ? (
        <details className="user-question-error">
          <summary>
            {t(
              attempt.phase === "unknown"
                ? "questionUnknown"
                : "questionFailed",
            )}
          </summary>
          <pre>{attempt.detail ?? attempt.error}</pre>
        </details>
      ) : null}
      <div className="user-question-actions">
        {question.state === "open" ? (
          <>
            <button
              type="button"
              className="quiet-button"
              disabled={unavailable || busy}
              onClick={() => respond("cancel")}
            >
              {t("questionCancel")}
            </button>
            <button
              type="button"
              className="primary-button"
              disabled={unavailable || busy || !valid}
              onClick={() => respond("answer")}
            >
              {t("questionSend")}
            </button>
          </>
        ) : null}
        {attempt &&
        ["unknown", "pending", "sending"].includes(attempt.phase) ? (
          <button
            type="button"
            className="quiet-button"
            disabled={disabled}
            onClick={() => {
              if (mounted.current) committedCheck();
            }}
          >
            {t("questionCheck")}
          </button>
        ) : null}
      </div>
      {!unavailable &&
      (!attempt || ["rejected", "withdrawn"].includes(attempt.phase)) &&
      draft.answers.some(
        (answer) => answer.optionIds.length > 0 || Boolean(answer.text?.trim()),
      ) ? (
        <details className="user-question-draft-note">
          <summary>{t("questionDraftStorage")}</summary>
          <small>{t("questionDraftNote")}</small>
        </details>
      ) : null}
    </article>
  );
}
