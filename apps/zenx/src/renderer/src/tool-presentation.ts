import type { IconName } from "./icons.js";

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
