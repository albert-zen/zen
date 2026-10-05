import { i18n } from "./i18n.js";
import type { IconName } from "./icons.js";
import type { ThreadItem } from "../../protocol-client/index.js";

/** One display phase for both a tool row and its enclosing trace summary. */
export function commandStatus(
  item: Extract<ThreadItem, { type: "commandExecution" }>,
): string {
  const data = item.structuredContent;
  if (
    item.contentType === "application/vnd.zen.tool-task+json" &&
    typeof data === "object" &&
    data !== null &&
    !Array.isArray(data) &&
    "status" in data
  ) {
    if (data.status === "queued") return i18n.t("shell:queued");
    if (data.status === "running")
      return item.toolName === "wait"
        ? i18n.t("shell:waiting")
        : i18n.t("shell:running");
    if (data.status === "cancel_requested") return i18n.t("shell:cancelling");
    if (data.status === "cancellation_unconfirmed")
      return i18n.t("shell:cancellationUnconfirmed");
    if (data.status === "failed") return i18n.t("shell:failed");
    if (data.status === "completed")
      return item.toolName === "wait"
        ? i18n.t("shell:waited")
        : item.toolName === "shell"
          ? i18n.t("shell:ranCommand")
          : i18n.t("shell:completed");
    if (data.status === "timed_out") return i18n.t("shell:timedOut");
    if (data.status === "cancelled") return i18n.t("shell:cancelled");
  }
  if (item.status === "completed")
    return item.toolName === "wait"
      ? i18n.t("shell:waited")
      : item.toolName === "shell"
        ? i18n.t("shell:ranCommand")
        : i18n.t("shell:completed");
  return {
    inProgress: i18n.t("shell:started"),
    failed: i18n.t("shell:failed"),
    declined: i18n.t("shell:declined"),
  }[item.status];
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
} {
  const key = name.replace(/^zenx_/u, "");
  if (/^view_image(?:\s|$)/u.test(key)) {
    return {
      category: i18n.t("shell:image"),
      icon: "image",
      action: i18n.t("shell:viewImages"),
    };
  }
  if (key === "shell")
    return {
      category: i18n.t("shell:shell"),
      icon: "terminal",
      action: i18n.t("shell:runCommand"),
    };
  if (key === "wait")
    return {
      category: i18n.t("shell:wait"),
      icon: "clock",
      action: i18n.t("shell:waitForTask"),
    };
  const threadAction = Object.hasOwn(threadActions(), key)
    ? threadActions()[key]
    : undefined;
  if (threadAction)
    return {
      category: i18n.t("shell:thread"),
      icon: threadAction.icon,
      action: threadAction.action,
    };
  const action = actions()[key];
  if (action)
    return {
      category: key.startsWith("browser_")
        ? i18n.t("shell:browser")
        : i18n.t("shell:computer"),
      icon: key.startsWith("browser_") ? "browser" : "computer",
      action,
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
  const completed = commandStatus(item) === i18n.t("shell:completed");
  const key = name.replace(/^zenx_/u, "");
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
      : name === "shell" && typeof args?.command === "string"
        ? args.command
        : name === "zenx_plugin" && args?.operation === "discover"
          ? completed
            ? i18n.t("shell:discoveredPlugins")
            : i18n.t("shell:discoverPlugins")
          : name === "zenx_plugin" && args?.operation === "read"
            ? i18n.t("shell:readPlugin")
            : (completedAction ??
              (item.toolName === undefined
                ? item.command
                : (toolPresentation(name).action ??
                  name.replace(/^zenx_/u, "").replaceAll("_", " "))));
  const line = text.replace(/\s+/gu, " ").trim();
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}

export function commandSummary(
  item: Extract<ThreadItem, { type: "commandExecution" }>,
): string {
  const status = commandStatus(item);
  const title = commandTitle(item);
  if (item.toolName === "wait" || item.command.trim() === "wait") {
    if (
      status === i18n.t("shell:waiting") ||
      status === i18n.t("shell:started")
    )
      return i18n.t("shell:waitingForTask");
    if (
      status === i18n.t("shell:waited") ||
      status === i18n.t("shell:completed")
    )
      return i18n.t("shell:waitedForTask");
    return i18n.t("shell:waitStatus", { status: status.toLowerCase() });
  }
  if (item.toolName === "shell") {
    if (status === i18n.t("shell:started"))
      return i18n.t("shell:startedTitle", { title });
    if (status === i18n.t("shell:running"))
      return i18n.t("shell:runningTitle", { title });
    if (
      status === i18n.t("shell:ranCommand") ||
      status === i18n.t("shell:completed")
    )
      return i18n.t("shell:ranTitle", { title });
  }
  if (status === i18n.t("shell:completed")) return title;
  return i18n.t("shell:titleStatus", { title, status: status.toLowerCase() });
}
