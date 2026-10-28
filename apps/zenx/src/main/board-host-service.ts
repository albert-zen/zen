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
  rooms: {
    roomsAvailable(): boolean;
    snapshot(): { rooms: ZenXRoom[] };
    postAddressedRoomMessage(
      roomId: string,
      threadId: string,
      clientId: string,
      text: string,
    ): Promise<RoomDeliveryView>;
  };
  executeTool(
    input: BoardToolRequest,
    signal: AbortSignal,
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
    const { thread } = await this.options.appServer.request("zen/thread/read", {
      threadId: owner.threadId,
    });
    if (thread.id !== owner.threadId || thread.archived)
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

  async execute(
    input: BoardOwner,
    action: { tool: string; arguments: Record<string, unknown> },
    signal: AbortSignal,
  ): Promise<ToolExecutionResult> {
    // Validate supported mechanism before any Host or model activity.
    const request = validateBoardToolRequest({
      threadId: validateBoardOwner(input).threadId,
      tool: action.tool,
      arguments: action.arguments,
    });
    signal.throwIfAborted();
    const owner = await this.readOwner(input);
    signal.throwIfAborted();
    this.#assertRoom(owner);
    return await this.options.executeTool(request, signal);
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
