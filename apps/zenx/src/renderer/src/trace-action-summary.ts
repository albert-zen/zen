import { i18n } from "./i18n.js";
import type { IconName } from "./icons.js";
import {
  toolPresentation,
  type CommandItem,
  type CommandPhase,
} from "./tool-presentation.js";

/** Known capability identities only; arbitrary shell/code text is never classified. */
export function traceAction(item: CommandItem): {
  key: string;
  label: string;
  completed?: string;
  category: string;
  icon: IconName;
  known: boolean;
} {
  const name = item.toolName ?? item.command;
  const presentation = toolPresentation(name);
  const key = name
    .replace(/^zenx_/u, "")
    .replace(/^browser_(?:workspace|connected)_/u, "browser_");
  return {
    key: presentation.action === undefined ? name : key,
    label: presentation.action ?? name,
    completed: presentation.completedAction,
    category:
      presentation.action === undefined
        ? presentation.category
        : toolPresentation(key).category,
    icon: presentation.icon,
    known: presentation.action !== undefined,
  };
}

/** A bounded, deterministic reading aid; full counts and chronological rows remain available. */
export function settledTraceSummary(
  commands: readonly CommandItem[],
  phase: (item: CommandItem) => CommandPhase,
): string {
  const groups = new Map<
    string,
    {
      action: ReturnType<typeof traceAction>;
      count: number;
      last: number;
      completed: boolean;
    }
  >();
  commands.forEach((item, last) => {
    const action = traceAction(item);
    const previous = groups.get(action.key);
    groups.set(action.key, {
      action,
      count: (previous?.count ?? 0) + 1,
      last,
      completed: (previous?.completed ?? true) && phase(item) === "completed",
    });
  });
  // Compaction is a context boundary. Wrappers/polling are less useful than the
  // actual work. Within those tiers, latest activity wins rather than old frequency.
  const priority = (key: string) =>
    key === "compact_context"
      ? 2
      : key === "run_code" || key === "wait"
        ? 0
        : 1;
  const selected = [...groups.values()]
    .sort(
      (a, b) =>
        priority(b.action.key) - priority(a.action.key) || b.last - a.last,
    )
    .slice(0, 2);
  const zh = i18n.resolvedLanguage?.startsWith("zh") === true;
  const phrases = selected.map(({ action, count, completed }) => {
    const name =
      Array.from(action.label).slice(0, 48).join("") +
      (Array.from(action.label).length > 48 ? "…" : "");
    let phrase: string;
    if (!action.known) {
      phrase = i18n.t("shell:traceCalledTool", { name });
    } else if (!completed) {
      phrase = i18n.t("shell:traceAttemptedAction", {
        action: name.toLocaleLowerCase(i18n.resolvedLanguage),
      });
    } else if (action.key === "shell") {
      phrase = i18n.t("shell:traceRanCommands", { count });
    } else if (action.key === "threads_send") {
      phrase = i18n.t("shell:traceSentMessages", { count });
    } else {
      phrase = action.completed ?? action.label;
    }
    // Similar labels on different surfaces remain distinguishable even if a
    // sibling was omitted from the short summary.
    if (
      action.known &&
      [...groups.values()].some(
        ({ action: other }) =>
          other.known &&
          other.key !== action.key &&
          other.label === action.label &&
          other.category !== action.category,
      )
    ) {
      phrase = i18n.t("shell:traceQualifiedAction", {
        category: action.category,
        action: zh
          ? phrase
          : phrase[0]!.toLocaleLowerCase(i18n.resolvedLanguage) +
            phrase.slice(1),
      });
    }
    return phrase;
  });
  let summary = phrases[0] ?? "";
  if (phrases[1])
    summary = i18n.t("shell:traceSummaryPair", {
      first: summary,
      second: zh
        ? phrases[1]
        : phrases[1][0]!.toLocaleLowerCase(i18n.resolvedLanguage) +
          phrases[1].slice(1),
    });
  const remaining =
    commands.length - selected.reduce((sum, group) => sum + group.count, 0);
  if (remaining > 0)
    summary = i18n.t("shell:traceSummaryRemaining", {
      summary,
      count: remaining,
    });
  return summary;
}
