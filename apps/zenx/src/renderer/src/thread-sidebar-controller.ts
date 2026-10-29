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
  #presentation: Record<string, ThreadSidebarState> = {};
  #pendingPresentation = new Map<
    string,
    { owner: SidebarOwner; patches: Map<symbol, ThreadSidebarPatch> }
  >();
  #listeners = new Set<() => void>();
  #queues = new Map<string, Promise<number>>();
  // Disposable UI intent only; Host receipts never advance this local fence.
  #presentationIntents = new Map<string, number>();
  beginPresentationIntent(owner: SidebarOwner | string): number {
    const key = sidebarOwnerKey(owner);
    const intent = (this.#presentationIntents.get(key) ?? 0) + 1;
    this.#presentationIntents.set(key, intent);
    // Local selection projections must observe same-ID explicit navigation too.
    // This publishes no new Host revision, descriptor, or durable fact.
    this.#emit();
    return intent;
  }
  isPresentationIntentCurrent(
    owner: SidebarOwner | string,
    intent: number,
  ): boolean {
    return this.#presentationIntents.get(sidebarOwnerKey(owner)) === intent;
  }
  #error: string | null = null;
  constructor(readonly api?: ThreadSidebarApi) {}
  snapshot = () => this.#presentation;
  get = (owner: SidebarOwner | string) => this.#states[sidebarOwnerKey(owner)];
  error = () => this.#error;
  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };
  #emit() {
    this.#presentation = { ...this.#states };
    for (const [key, pending] of this.#pendingPresentation) {
      const committed = this.#states[key] ?? emptySidebarState(pending.owner);
      this.#presentation[key] = Object.assign(
        {},
        committed,
        ...pending.patches.values(),
      );
    }
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
    // Structural materialization preserves the current local view choice.
    presentationIntent?: number | "preserve",
  ): Promise<void> {
    const owner = sidebarOwner(input);
    const key = sidebarOwnerKey(owner);
    const isCurrent = () =>
      typeof presentationIntent !== "number" ||
      this.isPresentationIntentCurrent(owner, presentationIntent);
    if (!isCurrent()) return Promise.resolve();
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
    // Opening/fullscreen are immediate local presentation, not durable receipts.
    // Keep the authoritative state/revision separate until the Host commits.
    const pendingId = Symbol();
    const visible = this.#presentation[key] ?? emptySidebarState(owner);
    try {
      const preview = makePatch(visible);
      if (
        presentationIntent === undefined &&
        ["open", "fullscreen", "selectedTab", "resourceThreadId"].some(
          (field) => Object.hasOwn(preview, field),
        )
      )
        this.beginPresentationIntent(owner);
      if (
        Object.keys(preview).length > 0 &&
        Object.entries(preview).every(
          ([field, value]) =>
            (field === "open" || field === "fullscreen") &&
            typeof value === "boolean",
        )
      ) {
        let pending = this.#pendingPresentation.get(key);
        if (!pending)
          this.#pendingPresentation.set(
            key,
            (pending = { owner, patches: new Map() }),
          );
        pending.patches.set(pendingId, preview);
        this.#emit();
      }
    } catch {
      // The queued edit reports validation errors through the existing UI error path.
    }
    const observed = renderedRevision ?? this.#states[key]?.revision;
    const previous = this.#queues.get(key);
    const result = (previous ?? Promise.resolve(observed)).then(
      async (expected) => {
        const current =
          this.#states[key] ??
          (this.api ? await this.api.read(owner) : emptySidebarState(owner));
        if (!isCurrent()) return current.revision;
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
        const pending = this.#pendingPresentation.get(key);
        if (pending?.patches.delete(pendingId)) {
          if (!pending.patches.size) this.#pendingPresentation.delete(key);
          this.#emit();
        }
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
