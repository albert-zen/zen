import { createContext, useContext } from "react";
import type { SentMessageQuote } from "./reference-draft.js";
import { AnsweredQuestionBubble } from "./AnsweredQuestionBubble.js";
import type { AnsweredQuestionPresentation } from "./answered-question-presentation.js";
import type { Reference } from "./composer-selector.js";
import { InlineReferenceContent } from "./InlineReferenceContent.js";
import { Markdown } from "./Markdown.js";

export const MessageQuoteSourceContext = createContext<
  ((quote: SentMessageQuote) => boolean) | null
>(null);

/** Shared body semantics for canonical messages and input still awaiting consumption. */
export function UserMessageContent({
  parts,
  answer,
  onSource,
}: {
  parts: readonly { text: string; references: readonly Reference[] }[];
  answer?: AnsweredQuestionPresentation;
  onSource?(reference: Reference): boolean;
}) {
  const navigateSource = useContext(MessageQuoteSourceContext);
  const openSource =
    onSource ??
    ((reference: Reference) =>
      reference.kind === "message" && navigateSource?.(reference) === true);
  if (answer) return <AnsweredQuestionBubble answer={answer} />;
  if (parts.some((part) => part.references.length > 0))
    return parts.map((part, index) => (
      <InlineReferenceContent
        key={index}
        text={part.text}
        references={part.references}
        onSource={openSource}
      />
    ));
  return <Markdown text={parts.map((part) => part.text).join("\n")} />;
}
