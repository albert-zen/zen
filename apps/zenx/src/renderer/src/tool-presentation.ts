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
    if (data.status === "queued") return "Queued";
    if (data.status === "running")
      return item.toolName === "wait" ? "Waiting" : "Running";
    if (data.status === "cancel_requested") return "Cancelling";
    if (data.status === "cancellation_unconfirmed")
      return "Cancellation unconfirmed";
    if (data.status === "failed") return "Failed";
    if (data.status === "completed")
      return item.toolName === "wait"
        ? "Waited"
        : item.toolName === "shell"
          ? "Ran command"
          : "Completed";
    if (data.status === "timed_out") return "Timed out";
    if (data.status === "cancelled") return "Cancelled";
  }
  if (item.status === "completed")
    return item.toolName === "wait"
      ? "Waited"
      : item.toolName === "shell"
        ? "Ran command"
        : "Completed";
  return {
    inProgress: "Started",
    failed: "Failed",
    declined: "Declined",
  }[item.status];
}

// These are presentation labels for known capabilities, never execution routing.
const actions: Record<string, string> = {
  browser_list_tabs: "List tabs",
  browser_open: "Open page",
  browser_navigate: "Navigate",
  browser_inspect: "Inspect page",
  browser_click: "Click element",
  browser_type: "Fill field",
  browser_select: "Select option",
  browser_scroll: "Scroll page",
  browser_close: "Close tab",
  browser_close_session: "Close session",
  computer_list_windows: "List windows",
  computer_inspect: "Inspect window",
  computer_press: "Press element",
  computer_set_value: "Fill field",
  computer_screenshot: "Capture window",
  computer_foreground_click: "Click screen",
  computer_foreground_key_press: "Press keys",
  computer_foreground_scroll: "Scroll screen",
};

const completedActions: Record<string, string> = {
  browser_list_tabs: "Listed tabs",
  browser_open: "Opened page",
  browser_navigate: "Navigated",
  browser_inspect: "Inspected page",
  browser_click: "Clicked element",
  browser_type: "Filled field",
  browser_select: "Selected option",
  browser_scroll: "Scrolled page",
  browser_close: "Closed tab",
  browser_close_session: "Closed session",
  computer_list_windows: "Listed windows",
  computer_inspect: "Inspected window",
  computer_press: "Pressed element",
  computer_set_value: "Filled field",
  computer_screenshot: "Captured window",
  computer_foreground_click: "Clicked screen",
  computer_foreground_key_press: "Pressed keys",
  computer_foreground_scroll: "Scrolled screen",
  view_image: "Viewed images",
};

const threadActions: Record<
  string,
  { action: string; completed: string; icon: IconName }
> = {
  threads_send: {
    action: "Send message",
    completed: "Sent message",
    icon: "send",
  },
  threads_create: {
    action: "Create thread",
    completed: "Created thread",
    icon: "plus",
  },
  threads_rename: {
    action: "Rename thread",
    completed: "Renamed thread",
    icon: "compose",
  },
  threads_read: {
    action: "Read thread",
    completed: "Read thread",
    icon: "thread",
  },
  threads_list: {
    action: "List threads",
    completed: "Listed threads",
    icon: "thread",
  },
  threads_status: {
    action: "Check thread status",
    completed: "Checked thread status",
    icon: "thread",
  },
  threads_configure: {
    action: "Configure thread",
    completed: "Configured thread",
    icon: "settings",
  },
  threads_archive: {
    action: "Archive thread",
    completed: "Archived thread",
    icon: "archive",
  },
  threads_unarchive: {
    action: "Restore thread",
    completed: "Restored thread",
    icon: "restore",
  },
};

export function toolPresentation(name: string): {
  category: string;
  icon: IconName;
  action?: string;
} {
  const key = name.replace(/^zenx_/u, "");
  if (/^view_image(?:\s|$)/u.test(key)) {
    return { category: "Image", icon: "image", action: "View images" };
  }
  if (key === "shell")
    return { category: "Shell", icon: "terminal", action: "Run command" };
  if (key === "wait")
    return { category: "Wait", icon: "clock", action: "Wait for task" };
  const threadAction = Object.hasOwn(threadActions, key)
    ? threadActions[key]
    : undefined;
  if (threadAction)
    return {
      category: "Thread",
      icon: threadAction.icon,
      action: threadAction.action,
    };
  const action = actions[key];
  if (action)
    return {
      category: key.startsWith("browser_") ? "Browser" : "Computer",
      icon: key.startsWith("browser_") ? "browser" : "computer",
      action,
    };
  return { category: name === "run_code" ? "Code" : "Tool", icon: "terminal" };
}

/** Concise labels for existing tool facts; never infer a task or agent from a process. */
export function commandTitle(
  item: Extract<ThreadItem, { type: "commandExecution" }>,
): string {
  const name = item.toolName ?? item.command.trim().split(/\s+/u)[0] ?? "tool";
  const args = item.toolArguments;
  const completed = commandStatus(item) === "Completed";
  const key = name.replace(/^zenx_/u, "");
  const completedAction =
    completed && item.toolName !== undefined
      ? Object.hasOwn(threadActions, key)
        ? threadActions[key]?.completed
        : Object.hasOwn(completedActions, key)
          ? completedActions[key]
          : undefined
      : undefined;
  const text =
    name === "run_code" && typeof args?.description === "string"
      ? args.description
      : name === "shell" && typeof args?.command === "string"
        ? args.command
        : name === "zenx_plugin" && args?.operation === "discover"
          ? completed
            ? "Discovered plugins"
            : "Discover plugins"
          : name === "zenx_plugin" && args?.operation === "read"
            ? "Read plugin"
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
    if (status === "Waiting" || status === "Started") return "Waiting for task";
    if (status === "Waited" || status === "Completed") return "Waited for task";
    return `Wait · ${status.toLowerCase()}`;
  }
  if (item.toolName === "shell") {
    if (status === "Started") return `Started · ${title}`;
    if (status === "Running") return `Running · ${title}`;
    if (status === "Ran command" || status === "Completed")
      return `Ran · ${title}`;
  }
  if (status === "Completed") return title;
  return `${title} · ${status.toLowerCase()}`;
}
