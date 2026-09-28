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
    if (data.status === "completed") return "Done";
    if (data.status === "timed_out") return "Timed out";
    if (data.status === "cancelled") return "Cancelled";
  }
  return {
    inProgress: "Started",
    completed: "Done",
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
    return { category: "Wait", icon: "terminal", action: "Wait for task" };
  const action = actions[key];
  if (action)
    return {
      category: key.startsWith("browser_") ? "Browser" : "Computer",
      icon: key.startsWith("browser_") ? "browser" : "computer",
      action,
    };
  return { category: name === "run_code" ? "Code" : "Tool", icon: "terminal" };
}
