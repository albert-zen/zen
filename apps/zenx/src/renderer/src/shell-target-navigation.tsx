import { createContext } from "react";
import type { ShellPanelBridge } from "../../shell-panel.js";
import type { ShellSessionRead } from "../../../../../src/shell-session.js";
import { sidebarTabId, type SidebarOwner } from "../../thread-sidebar-state.js";
import type { ThreadSidebarController } from "./thread-sidebar-controller.js";

export async function openShellTarget(input: {
  target: ShellTarget;
  owner: SidebarOwner;
  api: ShellPanelBridge;
  sidebar: ThreadSidebarController;
  isCurrent(): boolean;
}): Promise<boolean> {
  const read = (await input.api.request({
    operation: "read",
    ...input.target,
  })) as ShellSessionRead;
  if (!input.isCurrent()) return false;
  if (
    read?.session?.threadId !== input.target.threadId ||
    read.session.taskId !== input.target.taskId
  )
    throw new Error("Shell session not found for this thread");
  const tab = {
    kind: "terminal" as const,
    ...(input.owner.kind === "room" || input.owner.id !== input.target.threadId
      ? { resourceThreadId: input.target.threadId }
      : {}),
  };
  const id = sidebarTabId(tab);
  await input.sidebar.edit(input.owner, (state) => {
    if (!input.isCurrent())
      throw new Error("Terminal navigation changed before opening");
    return {
      open: true,
      selectedTab: id,
      tabs: state.tabs.some((entry) => sidebarTabId(entry) === id)
        ? state.tabs
        : [...state.tabs, tab],
    };
  });
  if (!input.isCurrent()) return false;
  const state = input.sidebar.get(input.owner);
  if (!state?.open || state.selectedTab !== id)
    throw new Error(
      input.sidebar.error() ?? "Terminal tab could not be opened",
    );
  return true;
}

export interface ShellTarget {
  threadId: string;
  taskId: string;
}
export interface ShellTargetRequest extends ShellTarget {
  ownerKey: string;
  requestId: number;
}
/** Ephemeral exact-session focus intent; sidebar/task owners retain all authority. */
export const ShellTargetNavigationContext = createContext<{
  open(target: ShellTarget, owner: { isCurrent(): boolean }): Promise<void>;
  request: ShellTargetRequest | null;
  consumed(requestId: number): void;
} | null>(null);
