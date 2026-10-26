import {
  emptySidebarState,
  sidebarOwner,
  sidebarOwnerKey,
  sidebarTabId,
  sidebarTabFromId,
  applySidebarPatch,
  type SidebarOwner,
  type ThreadSidebarState,
  type ThreadSidebarPatch,
  type ThreadSidebarApi,
} from "../../thread-sidebar-state.js";
export class ThreadSidebarController {
  #states: Record<string, ThreadSidebarState> = {};
  #listeners = new Set<() => void>();
  #queues = new Map<string, Promise<number>>();
  #error: string | null = null;
  constructor(readonly api?: ThreadSidebarApi) {}
  snapshot = () => this.#states;
  get = (owner: SidebarOwner | string) => this.#states[sidebarOwnerKey(owner)];
  error = () => this.#error;
  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };
  #emit() {
    for (const listener of this.#listeners) listener();
  }
  accept = (state: ThreadSidebarState) => {
    const key = sidebarOwnerKey(state.owner);
    if ((this.#states[key]?.revision ?? -1) > state.revision) return;
    this.#states = { ...this.#states, [key]: state };
    this.#emit();
  };
  async load(owner: SidebarOwner | string) {
    try {
      if (this.api) this.accept(await this.api.read(owner));
    } catch (error) {
      this.#error = `Sidebar state: ${String(error)}`;
      this.#emit();
    }
  }
  edit(
    input: SidebarOwner | string,
    makePatch: (state: ThreadSidebarState) => ThreadSidebarPatch,
    renderedRevision?: number,
  ): Promise<void> {
    const owner = sidebarOwner(input);
    const key = sidebarOwnerKey(owner);
    if (
      renderedRevision !== undefined &&
      this.#states[key] &&
      renderedRevision !== this.#states[key].revision
    ) {
      this.#error =
        "Sidebar state: Sidebar changed elsewhere. Your edit was not applied; try again.";
      this.#emit();
      return Promise.resolve();
    }
    const observed = renderedRevision ?? this.#states[key]?.revision;
    const previous = this.#queues.get(key);
    const result = (previous ?? Promise.resolve(observed)).then(
      async (expected) => {
        const current =
          this.#states[key] ??
          (this.api ? await this.api.read(owner) : emptySidebarState(owner));
        if (expected !== undefined && current.revision !== expected)
          throw Error(
            "Sidebar changed elsewhere. Your edit was not applied; try again.",
          );
        const patch = makePatch(current);
        const reply = this.api
          ? await this.api.update({
              owner,
              expectedRevision: current.revision,
              patch,
            })
          : { applied: true, state: applySidebarPatch(current, patch) };
        this.accept(reply.state);
        if (!reply.applied)
          throw Error(
            "Sidebar changed elsewhere. Your edit was not applied; try again.",
          );
        this.#error = null;
        this.#emit();
        return reply.state.revision;
      },
    );
    this.#queues.set(key, result);
    return result
      .then(() => undefined)
      .catch((error) => {
        this.#error = `Sidebar state: ${String(error)}`;
        this.#emit();
      })
      .finally(() => {
        if (this.#queues.get(key) === result) this.#queues.delete(key);
      });
  }
  select(owner: SidebarOwner | string, id: string) {
    return this.edit(owner, (state) => ({
      selectedTab: id || null,
      ...(id && !state.tabs.some((tab) => sidebarTabId(tab) === id)
        ? { tabs: [...state.tabs, sidebarTabFromId(id)] }
        : {}),
    }));
  }
  remove(owner: SidebarOwner | string, id: string) {
    return this.edit(owner, (state) => {
      const index = state.tabs.findIndex((tab) => sidebarTabId(tab) === id);
      const tabs = state.tabs.filter((tab) => sidebarTabId(tab) !== id);
      const neighbor = tabs[Math.min(index, tabs.length - 1)];
      return {
        tabs,
        selectedTab:
          state.selectedTab === id
            ? neighbor
              ? sidebarTabId(neighbor)
              : null
            : state.selectedTab,
      };
    });
  }
}
