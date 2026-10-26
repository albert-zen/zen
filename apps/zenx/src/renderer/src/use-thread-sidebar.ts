import {
  useEffect,
  useState,
  useSyncExternalStore,
  type SetStateAction,
} from "react";
import type { CompanionViewState } from "./companion-workspace.js";
import {
  sidebarTabId,
  sidebarTabFromId,
  type ThreadSidebarState,
  type ThreadSidebarPatch,
} from "../../thread-sidebar-state.js";
import { ThreadSidebarController } from "./thread-sidebar-controller.js";
export function roomSidebarPatch(
  previous: CompanionViewState | undefined,
  next: CompanionViewState,
  current: ThreadSidebarState,
): ThreadSidebarPatch {
  const patch: ThreadSidebarPatch = {};
  const descriptor = (id: string) =>
    current.tabs.find((tab) => sidebarTabId(tab) === id) ??
    (() => {
      const tab = sidebarTabFromId(id);
      return next.member && !["thread", "custom"].includes(tab.kind)
        ? { ...tab, resourceThreadId: next.member }
        : tab;
    })();
  if (JSON.stringify(previous?.tabs) !== JSON.stringify(next.tabs))
    patch.tabs = next.tabs.map(descriptor);
  if (
    JSON.stringify(previous?.conversationThreadIds) !==
    JSON.stringify(next.conversationThreadIds)
  )
    patch.tabs = [
      ...(patch.tabs ?? current.tabs).filter((tab) => tab.kind !== "thread"),
      ...(next.conversationThreadIds ?? []).map((threadId) => ({
        kind: "thread" as const,
        threadId,
      })),
    ];
  if (previous?.selected !== next.selected) {
    const selected = next.selected ? descriptor(next.selected) : undefined;
    patch.selectedTab = selected ? sidebarTabId(selected) : null;
    if (
      selected &&
      !(patch.tabs ?? current.tabs).some(
        (tab) => sidebarTabId(tab) === patch.selectedTab,
      )
    )
      patch.tabs = [...(patch.tabs ?? current.tabs), selected];
  }
  if (previous?.member !== next.member)
    patch.resourceThreadId = next.member || null;
  return patch;
}
export function useThreadSidebar() {
  const [controller] = useState(
    () => new ThreadSidebarController(window.zenx.threadSidebar),
  );
  const allStates = useSyncExternalStore(
    controller.subscribe,
    controller.snapshot,
  );
  const error = useSyncExternalStore(controller.subscribe, controller.error);
  useEffect(
    () => window.zenx.threadSidebar?.onChanged(controller.accept),
    [controller],
  );
  const states = Object.fromEntries(
    Object.values(allStates)
      .filter((state) => state.owner.kind === "thread")
      .map((state) => [state.owner.id, state]),
  );
  const roomWorkspaceStates: Record<string, CompanionViewState> =
    Object.fromEntries(
      Object.values(allStates)
        .filter((state) => state.owner.kind === "room")
        .map((state) => [
          state.owner.id,
          {
            selected: state.selectedTab ?? "custom:overview",
            tabs: state.tabs.map(sidebarTabId),
            member: state.resourceThreadId ?? "",
            conversationThreadIds: state.tabs
              .filter((tab) => tab.kind === "thread")
              .map((tab) => tab.threadId),
          },
        ]),
    );
  const browserPanels = Object.fromEntries(
    Object.entries(states).map(([id, state]) => [id, state.open]),
  );
  const panelTabs = Object.fromEntries(
    Object.entries(states).map(([id, state]) => [id, state.selectedTab ?? ""]),
  );
  const workspaceTabOrder = Object.fromEntries(
    Object.entries(states).map(([id, state]) => [
      id,
      state.tabs.map(sidebarTabId),
    ]),
  );
  const conversationPanels = Object.fromEntries(
    Object.entries(states).map(([id, state]) => [
      id,
      state.tabs
        .filter((tab) => tab.kind === "thread")
        .map((tab) => tab.threadId),
    ]),
  );
  function updateMap<T>(
    before: Record<string, T>,
    update: SetStateAction<Record<string, T>>,
    edit: (id: string, value: T) => void,
  ) {
    const next = typeof update === "function" ? update(before) : update;
    for (const [id, value] of Object.entries(next))
      if (JSON.stringify(value) !== JSON.stringify(before[id])) edit(id, value);
  }
  return {
    states,
    allStates,
    controller,
    error,
    roomWorkspaceStates,
    browserPanels,
    panelTabs,
    workspaceTabOrder,
    conversationPanels,
    setRoomWorkspaceStates: (
      update: SetStateAction<Record<string, CompanionViewState>>,
    ) =>
      updateMap(roomWorkspaceStates, update, (id, view) => {
        void controller.edit(
          { kind: "room", id },
          (state) => roomSidebarPatch(roomWorkspaceStates[id], view, state),
          allStates[`room:${id}`]?.revision,
        );
      }),
    setBrowserPanels: (update: SetStateAction<Record<string, boolean>>) =>
      updateMap(browserPanels, update, (id, open) => {
        void controller.edit(id, () => ({ open }));
      }),
    setPanelTabs: (update: SetStateAction<Record<string, string>>) =>
      updateMap(panelTabs, update, (id, selected) => {
        void controller.select(id, selected);
      }),
    setWorkspaceTabOrder: (update: SetStateAction<Record<string, string[]>>) =>
      updateMap(workspaceTabOrder, update, (id, order) => {
        void controller.edit(
          id,
          (state) => ({
            tabs: order.map(
              (key) =>
                state.tabs.find((tab) => sidebarTabId(tab) === key) ??
                sidebarTabFromId(key),
            ),
          }),
          states[id]?.revision,
        );
      }),
    setConversationPanels: (update: SetStateAction<Record<string, string[]>>) =>
      updateMap(conversationPanels, update, (id, threads) => {
        void controller.edit(id, (state) => ({
          tabs: [
            ...state.tabs.filter((tab) => tab.kind !== "thread"),
            ...threads.map((threadId) => ({
              kind: "thread" as const,
              threadId,
            })),
          ],
        }));
      }),
  };
}
