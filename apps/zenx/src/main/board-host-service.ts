import type { BoardNavigationTarget } from "../../../../packages/zenx-board-plugin/src/board.js";
import type { BrowserModelRoute } from "./capabilities/model-browser-metadata.js";
import {
  sidebarTabId,
  type ThreadSidebarPort,
  type ThreadSidebarTab,
} from "../thread-sidebar-state.js";
import { randomUUID } from "node:crypto";
import {
  validateBoardOwner,
  validateBoardToolRequest,
  type BoardOwner,
  type BoardToolRequest,
} from "../board-host.js";
import {
  deliverAssistantInput,
  type AssistantInputPort,
} from "./assistant-preset.js";
import type {
  ClientRequestParams,
  ClientRequestResults,
} from "../protocol-client/index.js";
import type { ToolExecutionResult } from "../../../../src/tool.js";
import type { RoomDeliveryView, ZenXRoom } from "./trigger-types.js";

interface BoardAppServerPort extends AssistantInputPort {
  request<
    M extends
      | "thread/read"
      | "turn/start"
      | "turn/steer"
      | "zen/turn/send-unarchived"
      | "zen/thread/read",
  >(
    method: M,
    params: ClientRequestParams[M],
  ): Promise<ClientRequestResults[M]>;
}
export interface BoardHostServiceOptions {
  appServer: BoardAppServerPort;
  /** Existing native summary projection; passive Board refresh never loads Items. */
  readThreadSummary(
    threadId: string,
  ): Promise<{ threadId: string; archived: boolean } | undefined>;
  rooms: {
    roomsAvailable(): boolean;
    snapshot(): { rooms: ZenXRoom[] };
    /** Required for Room execution; Thread-only adapters need not subscribe. */
    onChange?(listener: () => void): () => void;
    postAddressedRoomMessage(
      roomId: string,
      threadId: string,
      clientId: string,
      text: string,
    ): Promise<RoomDeliveryView>;
  };
  sidebar?: ThreadSidebarPort;
  readBrowserModelTarget?(
    threadId: string,
    targetId: string,
  ): Promise<BrowserModelRoute | undefined>;
  isSidebarIntentClosed?(threadId: string, intentId: string): boolean;
  executeTool(
    input: BoardToolRequest,
    signal: AbortSignal,
    assertOwner: () => void,
  ): Promise<ToolExecutionResult>;
}
export type BoardDeliveryReceipt =
  | {
      kind: "thread";
      threadId: string;
      turnId: string;
      mode: "start" | "steer";
      admission: "accepted";
    }
  | {
      kind: "room";
      roomId: string;
      threadId: string;
      delivery: RoomDeliveryView;
    };

/** Exact owner checks and existing Host admission only; no drafts or execution state. */
export class BoardHostService {
  constructor(readonly options: BoardHostServiceOptions) {}

  makeClientId(input: BoardOwner): string {
    const owner = validateBoardOwner(input);
    this.#assertRoom(owner);
    if (owner.kind === "thread") return randomUUID();
    const room = this.options.rooms
      .snapshot()
      .rooms.find((entry) => entry.id === owner.roomId)!;
    return `${room.operationEpoch ?? "legacy"}:${randomUUID()}`;
  }

  async readOwner(input: unknown): Promise<BoardOwner> {
    const owner = validateBoardOwner(input);
    this.#assertRoom(owner);
    const thread = await this.options.readThreadSummary(owner.threadId);
    if (!thread || thread.threadId !== owner.threadId || thread.archived)
      throw new Error("Board Thread is unavailable or archived");
    this.#assertRoom(owner);
    return owner;
  }

  async deliver(
    input: BoardOwner,
    text: string,
    clientId: string,
    signal: AbortSignal,
  ): Promise<BoardDeliveryReceipt> {
    if (
      typeof text !== "string" ||
      !text.trim() ||
      text.length > 100_000 ||
      typeof clientId !== "string" ||
      !clientId.trim() ||
      clientId.length > 512
    )
      throw new Error("Board message or client identity is invalid");
    signal.throwIfAborted();
    const owner = await this.readOwner(input);
    signal.throwIfAborted();
    if (owner.kind === "room") {
      const delivery = await this.options.rooms.postAddressedRoomMessage(
        owner.roomId,
        owner.threadId,
        clientId,
        text,
      );
      return {
        kind: "room",
        roomId: owner.roomId,
        threadId: owner.threadId,
        delivery,
      };
    }
    const receipt = await deliverAssistantInput(
      this.options.appServer,
      {
        threadId: owner.threadId,
        clientUserMessageId: clientId,
        input: [{ type: "text", text }],
      },
      signal,
      { requireUnarchived: true },
    );
    return {
      kind: "thread",
      threadId: owner.threadId,
      turnId: receipt.turnId,
      mode: receipt.mode,
      admission: "accepted",
    };
  }

  async readNavigationTarget(
    owner: BoardOwner,
    target: BoardNavigationTarget,
  ): Promise<BrowserModelRoute | undefined> {
    if (target.kind === "url") return;
    await this.readOwner(owner);
    const route = await this.options.readBrowserModelTarget?.(
      owner.threadId,
      target.id,
    );
    if (
      !route ||
      route.ownerThreadId !== owner.threadId ||
      route.targetId !== target.id ||
      (target.kind === "external-browser") !==
        !!route.backend?.startsWith("connected")
    )
      return;
    await this.readOwner(owner);
    return route;
  }

  async navigate(
    input: BoardOwner,
    target: BoardNavigationTarget,
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted();
    const owner = await this.readOwner(input);
    const sidebar = this.options.sidebar;
    if (!sidebar) throw new Error("Board resource navigation is unavailable");
    const scope = {
      kind: owner.kind,
      id: owner.kind === "room" ? owner.roomId : owner.threadId,
    };
    const admit = () => {
      signal.throwIfAborted();
      this.#assertRoom(owner);
    };
    const current = await sidebar.read(scope, admit);
    let tab: ThreadSidebarTab;
    if (target.kind === "url") {
      const existing = current.tabs.find(
        (entry) =>
          entry.kind === "webpage" &&
          entry.url === target.url &&
          (entry.resourceThreadId ??
            (scope.kind === "thread" ? scope.id : undefined)) ===
            owner.threadId &&
          !this.options.isSidebarIntentClosed?.(owner.threadId, entry.id),
      );
      tab = existing ?? {
        kind: "webpage",
        id: randomUUID(),
        url: target.url,
        resourceThreadId: owner.threadId,
      };
    } else {
      if (!(await this.readNavigationTarget(owner, target)))
        throw new Error(
          "This exact browser target is unavailable or closed; inspect it again. It was not reopened.",
        );
      tab = {
        kind: target.kind,
        id: target.id,
        resourceThreadId: owner.threadId,
      };
    }
    await this.readOwner(owner);
    admit();
    const id = sidebarTabId(tab);
    const tabs = current.tabs.some((entry) => sidebarTabId(entry) === id)
      ? current.tabs
      : [...current.tabs, tab];
    const result = await sidebar.update(
      {
        owner: scope,
        expectedRevision: current.revision,
        patch: { tabs, selectedTab: id, open: true },
      },
      admit,
      { kind: "ui" },
    );
    if (!result.applied)
      throw new Error(
        "Sidebar changed; navigation was not applied. Review before trying again.",
      );
  }

  async execute(
    input: BoardOwner,
    action: { tool: string; arguments: Record<string, unknown> },
    signal: AbortSignal,
  ): Promise<ToolExecutionResult> {
    // Validate supported mechanism before any Host or model activity.
    const request = validateBoardToolRequest({
      threadId: validateBoardOwner(input).threadId,
      owner: validateBoardOwner(input),
      tool: action.tool,
      arguments: action.arguments,
    });
    const owner = validateBoardOwner(input);
    signal.throwIfAborted();
    if (owner.kind === "room" && !this.options.rooms.onChange)
      throw new Error("Room execution membership observation is unavailable");
    const revoked = new AbortController();
    const liveSignal = AbortSignal.any([signal, revoked.signal]);
    const assertOwner = () => {
      liveSignal.throwIfAborted();
      this.#assertRoom(owner);
    };
    const unsubscribe =
      owner.kind === "room"
        ? this.options.rooms.onChange?.(() => {
            try {
              assertOwner();
            } catch (error) {
              revoked.abort(error);
            }
          })
        : undefined;
    try {
      assertOwner();
      await this.readOwner(owner);
      assertOwner();
      return await this.options.executeTool(request, liveSignal, assertOwner);
    } finally {
      unsubscribe?.();
    }
  }

  #assertRoom(owner: BoardOwner): void {
    if (owner.kind !== "room") return;
    const room = this.options.rooms.roomsAvailable()
      ? this.options.rooms
          .snapshot()
          .rooms.find((entry) => entry.id === owner.roomId)
      : undefined;
    if (!room?.members.some((member) => member.threadId === owner.threadId))
      throw new Error("Board's exact Room member is no longer available");
  }
}
