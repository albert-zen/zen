import { useId, useRef, useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import type { AnsweredQuestionPresentation } from "./answered-question-presentation.js";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/controls.js";
import { Icon } from "./icons.js";

export function AnsweredQuestionBubble({
  answer,
}: {
  answer: AnsweredQuestionPresentation;
}) {
  const { t } = useTranslation("shell");
  const [open, setOpen] = useState(false);
  const pinned = useRef(false);
  const restoreFocus = useRef(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const heading = useId();
  const clear = () => {
    clearTimeout(closeTimer.current);
  };
  useEffect(() => () => clearTimeout(closeTimer.current), []);
  const identity = JSON.stringify(answer);
  useEffect(() => {
    clearTimeout(closeTimer.current);
    pinned.current = false;
    restoreFocus.current = false;
    setOpen(false);
  }, [identity]);
  const closeSoon = () => {
    clear();
    closeTimer.current = setTimeout(() => {
      if (!pinned.current) setOpen(false);
    }, 180);
  };
  const label =
    answer.questions?.map(({ question }) => question.prompt).join(" · ") ??
    t("answeredQuestion");
  return (
    <div className="answered-question">
      <Popover
        open={open}
        onOpenChange={(next) => {
          pinned.current = next;
          setOpen(next);
        }}
      >
        <PopoverTrigger asChild>
          <button
            type="button"
            className="answered-question-trigger"
            aria-label={t("showAnsweredQuestion")}
            onPointerEnter={(event) => {
              if (event.pointerType !== "touch") {
                clear();
                setOpen(true);
              }
            }}
            onPointerLeave={closeSoon}
            onClick={(event) => {
              event.preventDefault();
              clear();
              restoreFocus.current = true;
              pinned.current = !pinned.current;
              setOpen(pinned.current);
            }}
          >
            <Icon name="quote" size={13} />
            <span>{label}</span>
          </button>
        </PopoverTrigger>
        <PopoverContent
          className="answered-question-popover"
          aria-labelledby={heading}
          onPointerEnter={clear}
          onPointerLeave={closeSoon}
          onOpenAutoFocus={(event) => {
            if (!pinned.current) event.preventDefault();
          }}
          onCloseAutoFocus={(event) => {
            if (!restoreFocus.current) event.preventDefault();
            restoreFocus.current = false;
          }}
        >
          <header>
            <strong id={heading}>{t("answeredQuestion")}</strong>
            <button
              type="button"
              aria-label={t("closeAnsweredQuestion")}
              onClick={() => {
                pinned.current = false;
                setOpen(false);
              }}
            >
              <Icon name="x" size={14} />
            </button>
          </header>
          {answer.questions ? (
            answer.questions.map(({ question }, index) => (
              <section key={index}>
                <p>{question.prompt}</p>
                {question.options && question.options.length > 0 && (
                  <ul>
                    {question.options.map((option) => (
                      <li key={option.id}>
                        <span>{option.label}</span>
                        {option.description && (
                          <small>{option.description}</small>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            ))
          ) : (
            <p>{t("answeredQuestionUnavailable")}</p>
          )}
        </PopoverContent>
      </Popover>
      <div className="answered-question-answer">
        {answer.questions
          ? answer.questions.map(({ selectedLabels, text }, index) => (
              <div className="answered-question-answer-part" key={index}>
                {selectedLabels.map((label, index) => (
                  <p key={index}>{label}</p>
                ))}
                {text !== undefined && <p>{text}</p>}
              </div>
            ))
          : answer.fallbackText}
      </div>
    </div>
  );
}
