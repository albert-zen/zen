/** Model-facing Browser vocabulary. This module has no Host, Core or native provider dependency. */
export const browserOperations = [
  "list_tabs", "open", "navigate", "inspect", "click", "type", "select",
  "scroll", "pointer_click", "key_press", "close", "close_session",
] as const;

export function browserOperation(name: string): string {
  return name.replace(/^browser_(?:workspace_|connected_)?/u, "");
}

export function browserNamespace(name: string): "workspace" | "connected" | "legacy" {
  return name.startsWith("browser_workspace_") ? "workspace" :
    name.startsWith("browser_connected_") ? "connected" : "legacy";
}

export const browserModelDescriptions: Readonly<Record<string, string>> = {
  list_tabs: "List tabs in one semantic session. Use the exact returned tab refs.",
  open: "Open an HTTP(S) page in a background Browser tab. Observes by default.",
  navigate: "Navigate the exact tab. Shared Workspace tabs may require a post-takeover observation.",
  inspect: "Capture one bounded tab view. Optional query filters actual captured role/name/value targets; cursor continues the same capture.",
  click: "Click an exact observed target; optional newer observation ref revalidates a retained target.",
  type: "Replace text in an exact observed target; optional submit can submit its form.",
  select: "Select an option on an exact observed target.",
  scroll: "Scroll the exact observed tab viewport.",
  pointer_click: "Click CSS viewport coordinates in the exact observed tab. Requires a real screenshot and inputViewport.",
  key_press: "Press a named key in the exact tab's already-focused element.",
  close: "Close the exact tab. Shared Workspace tabs may require a post-takeover observation.",
  close_session: "Close the exact session and its tabs.",
};
