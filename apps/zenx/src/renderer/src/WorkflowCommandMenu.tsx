import type { RefObject } from "react";
import type { useComposerSelector } from "./use-composer-selector.js";
import { ComposerSuggestions } from "./ComposerSuggestions.js";

export function WorkflowCommandMenu({
  id,
  selector,
  textarea,
}: {
  id: string;
  selector: ReturnType<typeof useComposerSelector>;
  textarea: RefObject<HTMLTextAreaElement | null>;
}) {
  return (
    <ComposerSuggestions
      id={id}
      selector={selector}
      textarea={textarea}
      label={selector.referenceMode ? "References" : "Slash commands"}
      hint={
        selector.referenceMode
          ? "Adds a locator; the agent reads it when needed."
          : "Choose to edit before sending."
      }
    />
  );
}
