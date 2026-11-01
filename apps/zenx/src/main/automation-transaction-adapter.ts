/** Storage-only body references; public service receipts keep their original bodies. */
import {
  AutomationTransactionStore,
  fingerprintOperationBody,
  type AutomationMetadata,
  type AutomationRoomEvent,
  type AutomationTransaction,
} from "./automation-transaction-store.js";
import type { TriggerSnapshot } from "./trigger-types.js";

export async function readAutomationProjection(
  journal: AutomationTransactionStore,
): Promise<TriggerSnapshot> {
  const position = journal.position;
  const metadata = journal.metadata();
  const rooms: TriggerSnapshot["rooms"] = [];
  for (const room of metadata.rooms) {
    const { operations, ...bodyFree } = room;
    const snapshot = {
      ...position,
      roomId: room.id,
      messageCount: room.messageCount,
    };
    let cursor: number | null = 0;
    let messages: TriggerSnapshot["rooms"][number]["messages"] = [];
    while (cursor !== null && messages.length < 50) {
      const page = await journal.readRoomPage(room.id, cursor, snapshot);
      messages = [...page.messages, ...messages].slice(-50);
      cursor = page.nextCursor;
    }
    rooms.push({
      ...bodyFree,
      messages,
      ...(operations === undefined
        ? {}
        : {
            operations: await Promise.all(
              operations.map(async (operation) => {
                const { bodyRef, ...receipt } = operation;
                return {
                  ...receipt,
                  ...(await journal.readOperationBody(room.id, bodyRef)),
                };
              }),
            ),
          }),
    });
  }
  return { triggers: metadata.triggers, history: metadata.history, rooms };
}

/** Called once inside the existing service mutation slot; does not read old bodies. */
export function automationTransactionForSnapshot(
  journal: AutomationTransactionStore,
  snapshot: TriggerSnapshot,
  roomEvents: readonly AutomationRoomEvent[],
  domains = { rooms: true, triggers: true },
): AutomationTransaction {
  const previous = journal.metadata();
  if (!domains.rooms && roomEvents.length)
    throw Error("Room event outside the active Room owner");
  const events: AutomationRoomEvent[] = structuredClone([...roomEvents]);
  const rooms: AutomationMetadata["rooms"] = domains.rooms
    ? snapshot.rooms.map((room) => {
        const { messages: _messages, operations, ...roomMetadata } = room;
        const prior = previous.rooms.find(
          (candidate) => candidate.id === room.id,
        );
        const added = events.filter(
          (event) =>
            event.type === "message" && event.message.roomId === room.id,
        ).length;
        const count = (prior?.messageCount ?? 0) + added;
        const projectedCount = (room as typeof room & { messageCount?: number })
          .messageCount;
        if (projectedCount !== undefined && projectedCount !== count)
          throw Error("Room projection count does not match new events");
        return {
          ...roomMetadata,
          messageCount: count,
          ...(operations === undefined
            ? {}
            : {
                operations: operations.map((operation) => {
                  const { text, replyTo, ...receipt } = operation;
                  const body = {
                    text,
                    ...(replyTo === undefined ? {} : { replyTo }),
                  };
                  const sha256 = fingerprintOperationBody(body);
                  const existing = prior?.operations?.find(
                    (candidate) => candidate.id === operation.id,
                  );
                  if (existing) {
                    if (existing.bodyRef.sha256 !== sha256)
                      throw Error("Immutable Room operation payload changed");
                    return { ...receipt, bodyRef: existing.bodyRef };
                  }
                  if (
                    operation.messageId !== null &&
                    operation.kind === undefined
                  ) {
                    // The core verifies a same-frame or existing human message and its hash.
                    return {
                      ...receipt,
                      bodyRef: {
                        kind: "message" as const,
                        id: operation.messageId,
                        sha256,
                      },
                    };
                  }
                  events.push({
                    type: "operationBody",
                    roomId: room.id,
                    operationId: operation.id,
                    ...body,
                  });
                  return {
                    ...receipt,
                    bodyRef: {
                      kind: "operation" as const,
                      id: operation.id,
                      sha256,
                    },
                  };
                }),
              }),
        };
      })
    : previous.rooms;
  return {
    metadata: {
      triggers: domains.triggers ? snapshot.triggers : previous.triggers,
      history: domains.triggers ? snapshot.history : previous.history,
      rooms,
    },
    roomEvents: events,
  };
}
