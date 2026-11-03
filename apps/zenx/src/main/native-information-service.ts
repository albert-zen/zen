import { randomUUID } from "node:crypto";
import {
  applyInformationOperations,
  bindInformationEdits,
  defaultInformationLayout,
  informationDefinition,
  parseInformationOperations,
  type InformationLayout,
} from "../information-layout.js";
import type { NativeInformationSnapshot } from "../native-information.js";
import {
  parseSidebarUpdate,
  sidebarOwner,
  sidebarTabId,
  type SidebarAdmission,
  type SidebarOwner,
  type ThreadSidebarPort,
  type ThreadSidebarState,
} from "../thread-sidebar-state.js";

export interface NativeInformationRoom {
  id: string;
  assistant?: { threadId: string };
  members: readonly { threadId: string; name?: string }[];
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("Information object required");
  return value as Record<string, unknown>;
}
function only(value: Record<string, unknown>, keys: readonly string[]) {
  if (Object.keys(value).some((key) => !keys.includes(key)))
    throw Error("Unknown native information field");
}
function identity(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 2048 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  )
    throw Error("Invalid native information identity");
  return value;
}

/** Native human admission into the existing sidebar owner queue and durable CAS. */
export class NativeInformationService {
  constructor(
    readonly options: {
      sidebar: ThreadSidebarPort;
      rooms(): readonly NativeInformationRoom[];
      /** Authoritative native summary read, never transcript/provider content. */
      assertThreadExists(threadId: string): Promise<void>;
      newId?(): string;
    },
  ) {}
  #room(owner: SidebarOwner): NativeInformationRoom | undefined {
    if (owner.kind !== "room") return undefined;
    const room = this.options.rooms().find((entry) => entry.id === owner.id);
    if (!room)
      throw Error("Information Room is unavailable or no longer exists");
    return room;
  }
  #defaultThread(owner: SidebarOwner): string | undefined {
    if (owner.kind === "thread") return owner.id;
    const room = this.#room(owner)!;
    const assistant = room.assistant?.threadId;
    return assistant &&
      room.members.some((member) => member.threadId === assistant)
      ? assistant
      : undefined;
  }
  #defaults(owner: SidebarOwner): InformationLayout {
    return defaultInformationLayout(owner, this.#defaultThread(owner));
  }
  #basis(state: ThreadSidebarState): string {
    // Even saved layouts fence reset/first-edit defaults against assistant changes.
    return JSON.stringify([
      state.informationLayout ? "saved" : "defaults",
      this.#defaults(state.owner).widgets.map((widget) => widget.id),
    ]);
  }
  #snapshot(state: ThreadSidebarState): NativeInformationSnapshot {
    const room = this.#room(state.owner);
    const resourceThreadId = this.#defaultThread(state.owner);
    return {
      owner: structuredClone(state.owner),
      revision: state.revision,
      basis: this.#basis(state),
      layout: structuredClone(
        state.informationLayout ?? this.#defaults(state.owner),
      ),
      members: room ? room.members.map((member) => ({ ...member })) : [],
      ...(resourceThreadId ? { resourceThreadId } : {}),
    };
  }
  #assertMember(owner: SidebarOwner, threadId: string): void {
    if (
      owner.kind === "thread"
        ? threadId !== owner.id
        : !this.#room(owner)!.members.some(
            (member) => member.threadId === threadId,
          )
    )
      throw Error("Information source is not a current member of this owner");
  }
  #admit(
    owner: SidebarOwner,
    document: SidebarAdmission,
    memberIds: readonly string[] = [],
    basis?: { state: ThreadSidebarState; value: string },
    relatedThreadIds: readonly string[] = [],
  ): SidebarAdmission {
    return async () => {
      await document();
      this.#room(owner);
      const ids = [
        ...new Set([
          ...(owner.kind === "thread" ? [owner.id] : []),
          ...memberIds,
        ]),
      ];
      for (const id of ids) {
        this.#assertMember(owner, id);
        await this.options.assertThreadExists(id);
      }
      for (const id of new Set(relatedThreadIds))
        await this.options.assertThreadExists(id);
      // Recheck all mutable admission facts after the last asynchronous read.
      await document();
      this.#room(owner);
      for (const id of ids) this.#assertMember(owner, id);
      if (basis && this.#basis(basis.state) !== basis.value)
        throw Error(
          "Information default binding changed before admission; read again",
        );
    };
  }
  async read(
    input: SidebarOwner | string,
    document: SidebarAdmission,
  ): Promise<NativeInformationSnapshot> {
    const owner = sidebarOwner(input);
    await document();
    this.#room(owner);
    const state = await this.options.sidebar.read(
      owner,
      this.#admit(owner, document),
    );
    return this.#snapshot(state);
  }
  async update(
    value: unknown,
    document: SidebarAdmission,
  ): Promise<NativeInformationSnapshot & { applied: boolean }> {
    await document();
    const input = object(value);
    only(input, [
      "owner",
      "expectedRevision",
      "basis",
      "operations",
      "resourceThreadId",
    ]);
    const owner = sidebarOwner(input.owner as SidebarOwner);
    const request = parseSidebarUpdate({
      owner,
      expectedRevision: input.expectedRevision,
      patch: {},
    });
    if (typeof input.basis !== "string")
      throw Error("Read the exact information basis before editing");
    if (!Array.isArray(input.operations) || !input.operations.length)
      throw Error("Information operations required");
    const edits = structuredClone(input.operations);
    const selected =
      input.resourceThreadId === undefined
        ? this.#defaultThread(owner)
        : identity(input.resourceThreadId);
    const current = await this.options.sidebar.read(
      owner,
      this.#admit(owner, document),
    );
    const basis = this.#basis(current);
    if (current.revision !== request.expectedRevision || basis !== input.basis)
      return { applied: false, ...this.#snapshot(current) };
    const initial = this.#defaults(owner);
    const layout = current.informationLayout ?? initial;
    const defaults = defaultInformationLayout(owner, selected);
    // Human presentation authority permits cleaning up retired member placements.
    // It never grants the retired binding provider content/action authority.
    let draft = structuredClone(layout);
    const requiredMembers = new Set<string>();
    const operations = edits.flatMap((raw) => {
      const edit = object(raw);
      if (
        edit.op === "add" &&
        informationDefinition(edit.type).source === "thread"
      ) {
        if (!selected)
          throw Error(
            "Choose a current Room member for this information source",
          );
        this.#assertMember(owner, selected);
        requiredMembers.add(selected);
      }
      if (edit.op === "set") {
        const widget = draft.widgets.find((entry) => entry.id === edit.id);
        if (
          widget?.binding.kind === "member" &&
          (edit.visible === true || edit.config !== undefined)
        ) {
          this.#assertMember(owner, widget.binding.resourceThreadId);
          requiredMembers.add(widget.binding.resourceThreadId);
        }
      }
      const liveIds = this.#room(owner)?.members.map(
        (member) => member.threadId,
      );
      const target = draft.widgets.find((widget) => widget.id === edit.id);
      const orphan =
        target?.binding.kind === "member" &&
        !liveIds?.includes(target.binding.resourceThreadId);
      const cleanup =
        orphan &&
        (edit.op === "move" ||
          edit.op === "remove" ||
          (edit.op === "set" &&
            edit.visible !== true &&
            edit.config === undefined));
      const bound = cleanup
        ? parseInformationOperations({ operations: [edit] }).operations
        : bindInformationEdits(
            { operations: [edit] },
            {
              owner,
              // Owner-only components do not use this value. Empty Rooms invent no member.
              callerThreadId: selected ?? "",
              editableThreadIds: liveIds,
              // Reset only authorizes current members, then the existing reset codec
              // hides retired placements in the full draft without touching bindings.
              current:
                edit.op === "reset"
                  ? {
                      ...draft,
                      widgets: draft.widgets.filter(
                        (widget) =>
                          widget.binding.kind !== "member" ||
                          liveIds?.includes(widget.binding.resourceThreadId),
                      ),
                    }
                  : draft,
              defaults,
              newId: this.options.newId ?? randomUUID,
            },
          );
      if (edit.op === "reset") {
        if (selected) this.#assertMember(owner, selected);
        for (const widget of defaults.widgets)
          if (widget.binding.kind === "member")
            requiredMembers.add(widget.binding.resourceThreadId);
      }
      draft = applyInformationOperations(draft, { operations: bound });
      return bound;
    });
    request.patch.informationLayout = {
      ...(current.informationLayout ? {} : { initial }),
      operations,
    };
    const result = await this.options.sidebar.update(
      request,
      this.#admit(owner, document, [...requiredMembers], {
        state: current,
        value: basis,
      }),
      { kind: "ui" },
    );
    return { applied: result.applied, ...this.#snapshot(result.state) };
  }
  /** Existing presentation/resources keep their API; raw layout input is never admitted. */
  async readSidebar(
    input: SidebarOwner | string,
    document: SidebarAdmission,
  ): Promise<ThreadSidebarState> {
    const owner = sidebarOwner(input);
    await document();
    this.#room(owner);
    return this.options.sidebar.read(owner, this.#admit(owner, document));
  }
  async updateSidebar(value: unknown, document: SidebarAdmission) {
    await document();
    const input = object(value);
    if (Object.hasOwn(object(input.patch), "informationLayout"))
      throw Error(
        "Information edits require the native operation API, never layout replacement",
      );
    const request = parseSidebarUpdate(input);
    const current = await this.options.sidebar.read(
      request.owner,
      this.#admit(request.owner, document),
    );
    const resources = new Set<string>();
    const conversations = new Set<string>();
    if (request.patch.resourceThreadId)
      resources.add(request.patch.resourceThreadId);
    for (const tab of request.patch.tabs ?? []) {
      // Old descriptors retain exact ownership, including retired members, so a
      // presentation edit cannot strand or silently rebind an existing resource.
      if (
        current.tabs.some(
          (saved) =>
            sidebarTabId(saved) === sidebarTabId(tab) &&
            JSON.stringify(saved) === JSON.stringify(tab),
        )
      )
        continue;
      if (tab.resourceThreadId) resources.add(tab.resourceThreadId);
      // Existing side-chat tabs may point at another real Thread. They are not
      // Room resource bindings and do not inherit member resource authority.
      if (tab.kind === "thread") conversations.add(tab.threadId);
    }
    return this.options.sidebar.update(
      request,
      this.#admit(request.owner, document, [...resources], undefined, [
        ...conversations,
      ]),
      { kind: "ui" },
    );
  }
}
