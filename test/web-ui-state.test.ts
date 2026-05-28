import { describe, expect, it } from "vitest";

import type { ThreadSnapshot } from "../src/app-server-protocol.js";
import {
  applyAppServerNotification,
  createWebUiState
} from "../src/web-ui-state.js";

describe("web ui state projection", () => {
  it("initializes current thread and timeline rows from a snapshot", () => {
    const snapshot: ThreadSnapshot = {
      id: "thread-1",
      status: "idle",
      turns: [
        {
          id: "turn-1",
          runId: "run-1",
          status: "completed",
          itemIds: ["item-1", "item-2"]
        }
      ],
      items: [
        item({
          id: "item-1",
          seq: 1,
          type: "user.message.completed",
          payload: { content: "Hello" }
        }),
        item({
          id: "item-2",
          seq: 2,
          type: "assistant.message.completed",
          payload: { content: "Hi from Zen" }
        })
      ]
    };

    const state = createWebUiState(snapshot);

    expect(state.currentThread).toEqual({
      id: "thread-1",
      status: "idle",
      turns: snapshot.turns
    });
    expect(state.timelineRows).toEqual([
      expect.objectContaining({
        type: "user",
        itemId: "item-1",
        seq: 1,
        content: "Hello"
      }),
      expect.objectContaining({
        type: "assistant",
        itemId: "item-2",
        seq: 2,
        content: "Hi from Zen"
      })
    ]);
  });

  it("applies appended item notifications in item sequence order", () => {
    let state = createWebUiState({
      id: "thread-1",
      status: "running",
      turns: [],
      items: []
    });

    state = applyAppServerNotification(state, {
      type: "item/appended",
      threadId: "thread-1",
      turnId: "turn-1",
      item: item({
        id: "item-2",
        seq: 2,
        type: "assistant.message.completed",
        payload: { content: "second" }
      })
    });
    state = applyAppServerNotification(state, {
      type: "item/appended",
      threadId: "thread-1",
      turnId: "turn-1",
      item: item({
        id: "item-1",
        seq: 1,
        type: "user.message.completed",
        payload: { content: "first" }
      })
    });

    expect(state.timelineRows.map((row) => row.itemId)).toEqual([
      "item-1",
      "item-2"
    ]);
  });

  it("shows assistant progress from deltas until the completed item becomes authoritative", () => {
    let state = createWebUiState({
      id: "thread-1",
      status: "running",
      turns: [],
      items: [
        item({
          id: "assistant-started",
          seq: 1,
          type: "assistant.message.started",
          payload: {}
        }),
        item({
          id: "delta-1",
          seq: 2,
          type: "assistant.message.delta",
          targetId: "assistant-started",
          payload: { delta: "draft ", index: 0 }
        }),
        item({
          id: "delta-2",
          seq: 3,
          type: "assistant.message.delta",
          targetId: "assistant-started",
          payload: { delta: "answer", index: 1 }
        })
      ]
    });

    expect(state.timelineRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "assistant-progress",
          itemId: "assistant-started",
          content: "draft answer"
        })
      ])
    );

    state = applyAppServerNotification(state, {
      type: "item/appended",
      threadId: "thread-1",
      turnId: "turn-1",
      item: item({
        id: "assistant-completed",
        seq: 4,
        type: "assistant.message.completed",
        targetId: "assistant-started",
        payload: { content: "final answer" }
      })
    });

    expect(state.timelineRows.filter((row) => row.type === "assistant-progress")).toEqual(
      []
    );
    expect(state.timelineRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "assistant",
          itemId: "assistant-completed",
          content: "final answer"
        })
      ])
    );
  });

  it("projects tool call, result, and error items into explicit timeline rows", () => {
    const state = createWebUiState({
      id: "thread-1",
      status: "idle",
      turns: [],
      items: [
        item({
          id: "tool-started",
          seq: 1,
          type: "tool.call.started",
          payload: {
            toolCallId: "call-1",
            toolName: "search",
            input: { query: "zen" }
          }
        }),
        item({
          id: "tool-result",
          seq: 2,
          type: "tool.result.completed",
          targetId: "tool-started",
          payload: {
            toolCallId: "call-1",
            toolName: "search",
            content: "result text"
          }
        }),
        item({
          id: "tool-error",
          seq: 3,
          type: "tool.error",
          targetId: "tool-started",
          payload: {
            toolCallId: "call-1",
            toolName: "search",
            message: "tool failed"
          }
        })
      ]
    });

    expect(state.timelineRows).toEqual([
      expect.objectContaining({
        type: "tool-call",
        itemId: "tool-started",
        toolCallId: "call-1",
        toolName: "search",
        input: { query: "zen" }
      }),
      expect.objectContaining({
        type: "tool-result",
        itemId: "tool-result",
        toolCallId: "call-1",
        content: "result text"
      }),
      expect.objectContaining({
        type: "tool-error",
        itemId: "tool-error",
        toolCallId: "call-1",
        message: "tool failed"
      })
    ]);
  });

  it("projects approval requested and resolved notifications into pending and resolved rows", () => {
    let state = createWebUiState({
      id: "thread-1",
      status: "running",
      turns: [],
      items: []
    });

    state = applyAppServerNotification(state, {
      type: "approval/requested",
      threadId: "thread-1",
      turnId: "turn-1",
      approvalId: "approval-1",
      item: item({
        id: "approval-requested",
        seq: 1,
        type: "approval.requested",
        payload: {
          approvalId: "approval-1",
          toolCallId: "call-1",
          reason: "Run shell command?"
        }
      })
    });

    expect(state.timelineRows).toEqual([
      expect.objectContaining({
        type: "approval-pending",
        itemId: "approval-requested",
        approvalId: "approval-1",
        toolCallId: "call-1",
        reason: "Run shell command?"
      })
    ]);

    state = applyAppServerNotification(state, {
      type: "approval/resolved",
      threadId: "thread-1",
      turnId: "turn-1",
      approvalId: "approval-1",
      decision: "approve",
      item: item({
        id: "approval-resolved",
        seq: 2,
        type: "approval.resolved",
        payload: {
          approvalId: "approval-1",
          decision: "approve"
        }
      })
    });

    expect(state.timelineRows.filter((row) => row.type === "approval-pending")).toEqual(
      []
    );
    expect(state.timelineRows).toEqual([
      expect.objectContaining({
        type: "approval-resolved",
        itemId: "approval-resolved",
        approvalId: "approval-1",
        decision: "approve"
      })
    ]);
  });

  it("updates current thread state from thread and turn lifecycle notifications", () => {
    let state = createWebUiState();

    state = applyAppServerNotification(state, {
      type: "thread/started",
      thread: {
        id: "thread-1",
        status: "idle",
        turns: [],
        items: []
      }
    });
    state = applyAppServerNotification(state, {
      type: "turn/started",
      threadId: "thread-1",
      turn: {
        id: "turn-1",
        runId: "run-1",
        status: "inProgress",
        itemIds: []
      }
    });

    expect(state.currentThread).toEqual({
      id: "thread-1",
      status: "running",
      turns: [
        {
          id: "turn-1",
          runId: "run-1",
          status: "inProgress",
          itemIds: []
        }
      ]
    });

    state = applyAppServerNotification(state, {
      type: "turn/completed",
      threadId: "thread-1",
      turn: {
        id: "turn-1",
        runId: "run-1",
        status: "completed",
        itemIds: ["item-1"]
      }
    });

    expect(state.currentThread).toEqual({
      id: "thread-1",
      status: "idle",
      turns: [
        {
          id: "turn-1",
          runId: "run-1",
          status: "completed",
          itemIds: ["item-1"]
        }
      ]
    });
  });

  it("ignores item notifications for a different current thread", () => {
    const state = applyAppServerNotification(
      createWebUiState({
        id: "thread-1",
        status: "idle",
        turns: [],
        items: []
      }),
      {
        type: "item/appended",
        threadId: "thread-2",
        turnId: "turn-1",
        item: item({
          id: "foreign-item",
          seq: 1,
          type: "user.message.completed",
          payload: { content: "not this thread" }
        })
      }
    );

    expect(state.currentThread?.id).toBe("thread-1");
    expect(state.timelineRows).toEqual([]);
  });
});

function item(
  overrides: Partial<ThreadSnapshot["items"][number]> = {}
): ThreadSnapshot["items"][number] {
  return {
    id: "item-1",
    type: "user.message.completed",
    createdAtMs: 1000,
    seq: 1,
    runId: "run-1",
    turnId: "turn-1",
    payload: {},
    ...overrides
  };
}
