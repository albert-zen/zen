import { memo, useEffect, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
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
  if (state.loaded && state.ids.length === 0 && !state.error) return null;
  return (
    <section
      className="conversation-information-section user-question-attention"
      aria-label={t("questionTitle")}
    >
      <header>
        <h3>{t("questionTitle")}</h3>
        <button
          type="button"
          className="text-button"
          disabled={state.loading}
          onClick={() => void store.refresh(threadId)}
        >
          {t("refresh")}
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
      {state.ids.map((id) =>
        state.cards[id] ? (
          <QuestionCard
            key={id}
            view={state.cards[id]!}
            store={store}
            disabled={disabled}
          />
        ) : null,
      )}
      {state.nextAfter ? (
        <button
          type="button"
          className="text-button"
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
  const edit = (
    questionId: string,
    patch: Partial<QuestionView["draft"]["answers"][number]>,
  ) =>
    store.edit(
      threadId,
      callItemId,
      draft.answers.map((answer) =>
        answer.questionId === questionId ? { ...answer, ...patch } : answer,
      ),
    );
  return (
    <article className="user-question-card" data-question-call-id={callItemId}>
      <p className="user-question-status" role="status">
        {t(`questionState.${status}`)}
      </p>
      {question.specification.questions.map((q) => {
        const answer = draft.answers.find((a) => a.questionId === q.id);
        return (
          <fieldset key={q.id} disabled={unavailable}>
            <legend>{q.prompt}</legend>
            {q.options?.map((option) => {
              const selected = answer?.optionIds.includes(option.id) ?? false;
              return (
                <label className="user-question-option" key={option.id}>
                  <input
                    type={q.multiSelect ? "checkbox" : "radio"}
                    name={JSON.stringify([threadId, callItemId, q.id])}
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
              className="text-button"
              disabled={unavailable || busy}
              onClick={() => void store.respond(threadId, callItemId, "cancel")}
            >
              {t("questionCancel")}
            </button>
            <button
              type="button"
              className="primary-button"
              disabled={unavailable || busy || !valid}
              onClick={() => void store.respond(threadId, callItemId, "answer")}
            >
              {t("questionSend")}
            </button>
          </>
        ) : null}
        {attempt &&
        ["unknown", "pending", "sending"].includes(attempt.phase) ? (
          <button
            type="button"
            className="text-button"
            onClick={() => void store.check(threadId, callItemId)}
          >
            {t("questionCheck")}
          </button>
        ) : null}
      </div>
      <small className="user-question-draft-note">
        {t("questionDraftNote")}
      </small>
    </article>
  );
}
