import { useTranslation } from "react-i18next";
import { i18n } from "./i18n.js";
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
  useTranslation("shell");
  const localizedSelector = {
    ...selector,
    rows: selector.rows.map((row) =>
      row.kind === "built-in" && row.name === "compact"
        ? { ...row, description: i18n.t("shell:compactThisThreadsContext") }
        : row,
    ),
  };
  return (
    <ComposerSuggestions
      id={id}
      selector={localizedSelector}
      textarea={textarea}
      label={
        selector.referenceMode
          ? i18n.t("shell:references")
          : i18n.t("shell:slashCommands")
      }
      hint={
        selector.referenceMode
          ? i18n.t("shell:addsALocatorTheAgentReadsItWhenNeeded")
          : i18n.t("shell:chooseToEditBeforeSending")
      }
    />
  );
}
