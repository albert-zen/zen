import { describe, expect, it } from "vitest";

import {
  filterProtocolItems,
  toProtocolItem,
  toThreadSnapshot,
  type AppServerNotification,
  type AppServerRequest,
  type AppServerResponse,
  type Item
} from "./test-exports.js";

describe("app server protocol", () => {
  it("projects items into JSON-safe cloned protocol items", () => {
    const source = item({
      payload: {
        content: "hello",
        nested: { values: [1, Number.NaN, undefined] }
      },
      meta: {
        trace: { ok: true },
        unsupported: undefined
      }
    });

    const projected = toProtocolItem(source);

    expect(projected).toEqual({
      id: "item-1",
      type: "assistant.message.completed",
      createdAtMs: 1000,
      seq: 1,
      runId: "run-1",
      turnId: "turn-1",
      payload: {
        content: "hello",
        nested: { values: [1, null, null] }
      },
      meta: {
        trace: { ok: true }
      }
    });

    (projected.payload as { nested: { values: unknown[] } }).nested.values.push(
      "changed"
    );

    expect(source.payload).toEqual({
      content: "hello",
      nested: { values: [1, Number.NaN, undefined] }
    });
  });

  it("filters internal items from default protocol views", () => {
    const visible = item({ id: "visible", seq: 1 });
    const internal = item({
      id: "internal",
      seq: 2,
      visibility: "internal"
    });

    expect(filterProtocolItems([visible, internal]).map((entry) => entry.id)).toEqual([
      "visible"
    ]);
    expect(
      filterProtocolItems([visible, internal], { includeInternal: true }).map(
        (entry) => entry.id
      )
    ).toEqual(["visible", "internal"]);
  });

  it("derives thread and turn lifecycle projections from items", () => {
    const snapshot = toThreadSnapshot({
      threadId: "thread-1",
      items: [
        item({
          id: "item-1",
          seq: 1,
          type: "turn.queued",
          visibility: "trace",
          payload: { input: "hello" }
        }),
        item({ id: "item-2", seq: 2, payload: { content: "visible" } }),
        item({
          id: "item-3",
          seq: 3,
          type: "turn.completed",
          visibility: "trace",
          payload: { status: "completed" }
        }),
        item({ id: "item-4", seq: 4, visibility: "internal" })
      ]
    });

    expect(snapshot).toEqual({
      id: "thread-1",
      status: "idle",
      turns: [
        {
          id: "turn-1",
          runId: "run-1",
          status: "completed",
          itemIds: ["item-1", "item-2", "item-3", "item-4"]
        }
      ],
      items: [
        expect.objectContaining({ id: "item-1", type: "turn.queued" }),
        expect.objectContaining({
          id: "item-2",
          payload: { content: "visible" }
        }),
        expect.objectContaining({ id: "item-3", type: "turn.completed" })
      ]
    });

    (snapshot.turns[0]?.itemIds as string[]).push("mutated");

    expect(snapshot.turns[0]?.itemIds).toEqual([
      "item-1",
      "item-2",
      "item-3",
      "item-4",
      "mutated"
    ]);
  });

  it("exposes typed request, response, and notification discriminants", () => {
    const request: AppServerRequest = {
      method: "turn/start",
      params: {
        threadId: "thread-1",
        input: "hello"
      }
    };
    const response: AppServerResponse = {
      method: "turn/start",
      ok: true,
      result: {
        turn: {
          id: "turn-1",
          runId: "run-1",
          status: "inProgress",
          itemIds: []
        }
      }
    };
    const notification: AppServerNotification = {
      type: "item/appended",
      threadId: "thread-1",
      turnId: "turn-1",
      item: toProtocolItem(item())
    };

    expect(request.method).toBe("turn/start");
    expect(response.ok).toBe(true);
    expect(notification.type).toBe("item/appended");
  });
});

function item(overrides: Partial<Item> = {}): Item {
  return {
    id: "item-1",
    type: "assistant.message.completed",
    createdAtMs: 1000,
    seq: 1,
    runId: "run-1",
    turnId: "turn-1",
    payload: { content: "hello" },
    ...overrides
  };
}
