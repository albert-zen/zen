import {
  sidebarOwner,
  sidebarTabId,
  type SidebarOwner,
  type ThreadSidebarState,
  type ThreadSidebarTab,
} from "../thread-sidebar-state.js";
export interface SidebarRoom {
  id: string;
  name: string;
  assistant?: { threadId: string };
  members: readonly { threadId: string }[];
}
export class SidebarScopeChoiceRequired extends Error {
  constructor(readonly choices: readonly (SidebarOwner & { name?: string })[]) {
    super(
      "Multiple dedicated Room bindings; choose an explicit authorized scope",
    );
    this.name = "SidebarScopeChoiceRequired";
  }
}
export function resolveSidebarScope(
  threadId: string,
  requested: unknown,
  rooms: readonly SidebarRoom[],
) {
  const memberRooms = rooms.filter((room) =>
    room.members.some((member) => member.threadId === threadId),
  );
  const dedicated = memberRooms.filter(
    (room) => room.assistant?.threadId === threadId,
  );
  const choices: (SidebarOwner & { name?: string })[] = [
    { kind: "thread", id: threadId, name: "Private Thread" },
    ...memberRooms.map((room) => ({
      kind: "room" as const,
      id: room.id,
      name: room.name,
    })),
  ];
  let effectiveScope: SidebarOwner;
  let defaultReason: string;
  if (requested !== undefined) {
    effectiveScope = sidebarOwner(requested as SidebarOwner);
    if (
      !choices.some(
        (choice) =>
          choice.kind === effectiveScope.kind &&
          choice.id === effectiveScope.id,
      )
    )
      throw new Error(
        "Sidebar scope is not your private Thread or a Room you currently belong to",
      );
    defaultReason = "explicit-authorized-scope";
  } else if (dedicated.length === 1) {
    effectiveScope = { kind: "room", id: dedicated[0]!.id };
    defaultReason = "unique-dedicated-assistant-binding";
  } else if (dedicated.length > 1) {
    throw new SidebarScopeChoiceRequired(choices);
  } else {
    effectiveScope = { kind: "thread", id: threadId };
    defaultReason = "private-thread-no-unique-dedicated-room-binding";
  }
  return {
    effectiveScope,
    defaultReason,
    authorizedScopes: choices.slice(0, 101),
  };
}
export function bindSidebarResources(
  tabs: ThreadSidebarTab[],
  current: ThreadSidebarState,
  caller: string,
): ThreadSidebarTab[] {
  return tabs.map((tab) => {
    if (
      ![
        "file",
        "webpage",
        "browser",
        "external-browser",
        "terminal",
        "computer",
        "plugin",
      ].includes(tab.kind)
    )
      return tab;
    const resource = tab as ThreadSidebarTab & { resourceThreadId?: string };
    if (resource.resourceThreadId && resource.resourceThreadId !== caller) {
      // Preserving another member's already authorized resource descriptor is
      // allowed; inventing or changing its target is not.
      if (
        !current.tabs.some(
          (saved) =>
            sidebarTabId(saved) === sidebarTabId(tab) &&
            JSON.stringify(saved) === JSON.stringify(tab),
        )
      )
        throw new Error(
          "Cannot bind a sidebar resource to another member Thread",
        );
      return tab;
    }
    return current.owner.kind === "room"
      ? { ...tab, resourceThreadId: caller }
      : tab;
  });
}
