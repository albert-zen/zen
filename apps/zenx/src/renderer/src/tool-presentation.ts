import { IMPORTED_TOOL_RESULT_CONTENT_TYPE } from "../../../../../src/thread-import.js";
import { i18n } from "./i18n.js";
import type { IconName } from "./icons.js";
import type { ThreadItem, Turn } from "../../protocol-client/index.js";

export type CommandPhase =
  | "unknown"
  | "imported"
  | "requested"
  | "admitting"
  | "queued"
  | "running"
  | "waiting"
  | "cancel_requested"
  | "cancellation_unconfirmed"
  | "completed"
  | "failed"
  | "timed_out"
  | "cancelled"
  | "declined";
export type CommandItem = Extract<ThreadItem, { type: "commandExecution" }>;
export function commandTask(
  item: CommandItem,
): { id: string; phase: CommandPhase } | null {
  const data = item.structuredContent;
  if (
    item.contentType !== "application/vnd.zen.tool-task+json" ||
    data === null ||
    typeof data !== "object" ||
    Array.isArray(data) ||
    !("task_id" in data) ||
    typeof data.task_id !== "string" ||
    !("status" in data)
  )
    return null;
  const status = data.status;
  if (
    typeof status !== "string" ||
    ![
      "admitting",
      "queued",
      "running",
      "completed",
      "failed",
      "timed_out",
      "cancel_requested",
      "cancellation_unconfirmed",
      "cancelled",
    ].includes(status)
  )
    return null;
  return {
    id: data.task_id,
    phase: status as CommandPhase,
  };
}
export function isTerminalCommandPhase(phase: CommandPhase): boolean {
  return [
    // Closed presentation, not proof that an unknown operation terminated.
    "unknown",
    "imported",
    "completed",
    "failed",
    "timed_out",
    "cancelled",
    "declined",
  ].includes(phase);
}
/** Invocation lifetime follows its return, never the process described by that return. */
export function commandPhase(
  item: CommandItem,
  turnStatus: Turn["status"] = "inProgress",
): CommandPhase {
  if (item.contentType === IMPORTED_TOOL_RESULT_CONTENT_TYPE) return "imported";
  if (item.status === "unknown") return "unknown";
  if (item.status === "inProgress")
    return turnStatus === "inProgress" ? "requested" : "unknown";
  // Failed/declined are returned results too. Preserve their details without
  // confusing invocation completion with a successful underlying operation.
  return "completed";
}
export function commandPhaseLabel(phase: CommandPhase): string {
  const keys = {
    unknown: "toolOutcomeUnknown",
    imported: "importedHistory",
    requested: "requested",
    admitting: "admitting",
    queued: "queued",
    running: "running",
    waiting: "waiting",
    cancel_requested: "cancelling",
    cancellation_unconfirmed: "cancellationUnconfirmed",
    completed: "completed",
    failed: "toolEnded",
    timed_out: "timedOut",
    cancelled: "cancelled",
    declined: "declined",
  } as const;
  return i18n.t(`shell:${keys[phase]}`);
}
export function commandStatus(
  item: CommandItem,
  turnStatus: Turn["status"] = "inProgress",
): string {
  return commandPhaseLabel(commandPhase(item, turnStatus));
}

// These are presentation labels for known capabilities, never execution routing.
function actions(): Record<string, string> {
  return {
    browser_list_tabs: i18n.t("shell:listTabs"),
    browser_open: i18n.t("shell:openPage"),
    browser_navigate: i18n.t("shell:navigate"),
    browser_inspect: i18n.t("shell:inspectPage"),
    browser_click: i18n.t("shell:clickElement"),
    browser_type: i18n.t("shell:fillField"),
    browser_select: i18n.t("shell:selectOption"),
    browser_scroll: i18n.t("shell:scrollPage"),
    browser_close: i18n.t("shell:closeTab"),
    browser_close_session: i18n.t("shell:closeSession"),
    computer_list_windows: i18n.t("shell:listWindows"),
    computer_inspect: i18n.t("shell:inspectWindow"),
    computer_press: i18n.t("shell:pressElement"),
    computer_set_value: i18n.t("shell:fillField"),
    computer_screenshot: i18n.t("shell:captureWindow"),
    computer_foreground_click: i18n.t("shell:clickScreen"),
    computer_foreground_key_press: i18n.t("shell:pressKeys"),
    computer_foreground_scroll: i18n.t("shell:scrollScreen"),
  };
}

function completedActions(): Record<string, string> {
  return {
    browser_list_tabs: i18n.t("shell:listedTabs"),
    browser_open: i18n.t("shell:openedPage"),
    browser_navigate: i18n.t("shell:navigated"),
    browser_inspect: i18n.t("shell:inspectedPage"),
    browser_click: i18n.t("shell:clickedElement"),
    browser_type: i18n.t("shell:filledField"),
    browser_select: i18n.t("shell:selectedOption"),
    browser_scroll: i18n.t("shell:scrolledPage"),
    browser_close: i18n.t("shell:closedTab"),
    browser_close_session: i18n.t("shell:closedSession"),
    computer_list_windows: i18n.t("shell:listedWindows"),
    computer_inspect: i18n.t("shell:inspectedWindow"),
    computer_press: i18n.t("shell:pressedElement"),
    computer_set_value: i18n.t("shell:filledField"),
    computer_screenshot: i18n.t("shell:capturedWindow"),
    computer_foreground_click: i18n.t("shell:clickedScreen"),
    computer_foreground_key_press: i18n.t("shell:pressedKeys"),
    computer_foreground_scroll: i18n.t("shell:scrolledScreen"),
    view_image: i18n.t("shell:viewedImages"),
  };
}

function threadActions(): Record<
  string,
  { action: string; completed: string; icon: IconName }
> {
  return {
    threads_send: {
      action: i18n.t("shell:sendMessage"),
      completed: i18n.t("shell:sentMessage"),
      icon: "send",
    },
    threads_create: {
      action: i18n.t("shell:createThread"),
      completed: i18n.t("shell:createdThread"),
      icon: "plus",
    },
    threads_rename: {
      action: i18n.t("shell:renameThread"),
      completed: i18n.t("shell:renamedThread"),
      icon: "compose",
    },
    threads_read: {
      action: i18n.t("shell:readThread"),
      completed: i18n.t("shell:readThread"),
      icon: "thread",
    },
    threads_list: {
      action: i18n.t("shell:listThreads"),
      completed: i18n.t("shell:listedThreads"),
      icon: "thread",
    },
    threads_status: {
      action: i18n.t("shell:checkThreadStatus"),
      completed: i18n.t("shell:checkedThreadStatus"),
      icon: "thread",
    },
    threads_configure: {
      action: i18n.t("shell:configureThread"),
      completed: i18n.t("shell:configuredThread"),
      icon: "settings",
    },
    threads_archive: {
      action: i18n.t("shell:archiveThread"),
      completed: i18n.t("shell:archivedThread"),
      icon: "archive",
    },
    threads_unarchive: {
      action: i18n.t("shell:restoreThread"),
      completed: i18n.t("shell:restoredThread"),
      icon: "restore",
    },
  };
}

export function toolPresentation(name: string): {
  category: string;
  icon: IconName;
  action?: string;
  completedAction?: string;
} {
  const key = name
    .replace(/^zenx_/u, "")
    .replace(/^browser_(?:workspace|connected)_/u, "browser_");
  if (/^view_image(?:\s|$)/u.test(key)) {
    return {
      category: i18n.t("shell:image"),
      icon: "image",
      action: i18n.t("shell:viewImages"),
      completedAction: i18n.t("shell:traceViewedImages"),
    };
  }
  if (key === "shell")
    return {
      category: i18n.t("shell:shell"),
      icon: "terminal",
      action: i18n.t("shell:runCommand"),
      completedAction: i18n.t("shell:ranCommand"),
    };
  if (key === "wait")
    return {
      category: i18n.t("shell:wait"),
      icon: "clock",
      action: i18n.t("shell:waitForTask"),
      completedAction: i18n.t("shell:waitedForTask"),
    };
  if (key === "run_code" || key === "compact_context")
    return {
      category: i18n.t(key === "run_code" ? "shell:code" : "shell:context"),
      icon: key === "run_code" ? "terminal" : "compress",
      action: i18n.t(
        key === "run_code" ? "shell:traceRunCode" : "shell:compactContext",
      ),
      completedAction: i18n.t(
        key === "run_code"
          ? "shell:traceRanCode"
          : "shell:traceCompactedContext",
      ),
    };
  const threadAction = Object.hasOwn(threadActions(), key)
    ? threadActions()[key]
    : undefined;
  if (threadAction)
    return {
      category: i18n.t("shell:thread"),
      icon: threadAction.icon,
      action: threadAction.action,
      completedAction: threadAction.completed,
    };
  const action = Object.hasOwn(actions(), key) ? actions()[key] : undefined;
  if (action)
    return {
      category: key.startsWith("browser_")
        ? /^((zenx_)?browser_workspace_)/u.test(name)
          ? i18n.t("shell:workspaceBrowser")
          : /^((zenx_)?browser_connected_)/u.test(name)
            ? i18n.t("shell:externalBrowser")
            : i18n.t("shell:browser")
        : i18n.t("shell:computer"),
      icon: key.startsWith("browser_") ? "browser" : "computer",
      action,
      completedAction: Object.hasOwn(completedActions(), key)
        ? completedActions()[key]
        : undefined,
    };
  return {
    category: name === "run_code" ? i18n.t("shell:code") : i18n.t("shell:tool"),
    icon: "terminal",
  };
}

/** Concise labels for existing tool facts; never infer a task or agent from a process. */
export function commandTitle(
  item: Extract<ThreadItem, { type: "commandExecution" }>,
): string {
  const name = item.toolName ?? item.command.trim().split(/\s+/u)[0] ?? "tool";
  const args = item.toolArguments;
  const completed =
    item.status === "completed" && commandPhase(item) === "completed";
  const key = name
    .replace(/^zenx_/u, "")
    .replace(/^browser_(?:workspace|connected)_/u, "browser_");
  const completedAction =
    completed && item.toolName !== undefined
      ? Object.hasOwn(threadActions(), key)
        ? threadActions()[key]?.completed
        : Object.hasOwn(completedActions(), key)
          ? completedActions()[key]
          : undefined
      : undefined;
  const text =
    name === "run_code" && typeof args?.description === "string"
      ? args.description
      : name === "shell"
        ? typeof args?.command === "string"
          ? args.command
          : i18n.t("shell:runCommand")
        : name === "zenx_plugin" && args?.operation === "discover"
          ? completed
            ? i18n.t("shell:discoveredPlugins")
            : i18n.t("shell:discoverPlugins")
          : name === "zenx_plugin" && args?.operation === "read"
            ? i18n.t("shell:readPlugin")
            : (completedAction ??
              (item.toolName === undefined
                ? item.command
                : ((completed
                    ? toolPresentation(name).completedAction
                    : undefined) ??
                  toolPresentation(name).action ??
                  name.replace(/^zenx_/u, "").replaceAll("_", " "))));
  const line = text.replace(/\s+/gu, " ").trim();
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}

export function commandSummary(
  item: CommandItem,
  turnStatus: Turn["status"] = "inProgress",
): string {
  const phase = commandPhase(item, turnStatus);
  const title = commandTitle(item);
  if (phase === "completed" && item.status === "completed") return title;
  return i18n.t("shell:titleStatus", {
    title,
    status: commandPhaseLabel(phase).toLowerCase(),
  });
}
