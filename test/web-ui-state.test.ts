import { describe, expect, it } from "vitest";

import type { ThreadSnapshot } from "../src/app-server-protocol.js";
import {
  applyAppServerNotification,
  createWebUiState,
  InteractionProjection
} from "../src/web-ui-state.js";

describe("web ui state projection", () => {
  it("caches snapshots and processes 1k/5k ordered appends with constant work and no sequence copies", () => {
    const projection = new InteractionProjection({ id: "thread-1", status: "idle", turns: [], items: [] });
    const baseline = projection.getWork();
    const initial = projection.getSnapshot();
    let listenerCalls = 0;
    projection.subscribe(() => { listenerCalls += 1; });

    for (let seq = 1; seq <= 1000; seq += 1) {
      projection.apply({
        type: "item/appended",
        threadId: "thread-1",
        turnId: "turn-1",
        item: item({ id: `item-${seq}`, seq, type: "user.message.completed", payload: { content: String(seq) } })
      });
    }
    const atOneThousand = projection.getSnapshot();
    expect(workSince(baseline, projection.getWork())).toEqual({ fastPathOperations: 1000, rebuilds: 0, sequenceCopies: 0, fullMaterializations: 0, sequenceTraversals: 0, mapClones: 0, indexRebuilds: 0 });

    for (let seq = 1001; seq <= 5000; seq += 1) {
      projection.apply({
        type: "item/appended",
        threadId: "thread-1",
        turnId: "turn-1",
        item: item({ id: `item-${seq}`, seq, type: "user.message.completed", payload: { content: String(seq) } })
      });
    }
    expect(workSince(baseline, projection.getWork())).toEqual({ fastPathOperations: 5000, rebuilds: 0, sequenceCopies: 0, fullMaterializations: 0, sequenceTraversals: 0, mapClones: 0, indexRebuilds: 0 });

    const snapshot = projection.getSnapshot();
    expect(initial).not.toBe(snapshot);
    expect(snapshot.items).toHaveLength(5000);
    expect(snapshot.timelineRows).toHaveLength(5000);
    expect(listenerCalls).toBe(5000);
    expect(atOneThousand.items).toHaveLength(1000);
    expect(atOneThousand.timelineRows).toHaveLength(1000);

    const unchanged = projection.getSnapshot();
    projection.apply({
      type: "item/appended", threadId: "thread-1", turnId: "turn-1",
      item: item({ id: "item-5000", seq: 5000, type: "user.message.completed", payload: { content: "5000" } })
    });
    expect(projection.getSnapshot()).toBe(unchanged);
    expect(listenerCalls).toBe(5000);
  });

  it("keeps stable shell slots when approval resolution tombstones a row", () => {
    let state = createWebUiState({ id: "thread-1", status: "running", turns: [], items: [] });
    const append = (nextItem: ReturnType<typeof item>) => {
      state = applyAppServerNotification(state, { type: "item/appended", threadId: "thread-1", turnId: "turn-1", item: nextItem });
    };
    append(item({ id: "shell-1", seq: 1, type: "tool.call.started", payload: { toolName: "shell", input: { command: "one" } } }));
    append(item({ id: "approval-1", seq: 2, type: "approval.requested", payload: { approvalId: "approval-1" } }));
    append(item({ id: "shell-2", seq: 3, type: "tool.call.started", payload: { toolName: "shell", input: { command: "two" } } }));
    append(item({ id: "approval-1-resolved", seq: 4, type: "approval.resolved", payload: { approvalId: "approval-1", decision: "approveOnce" } }));
    append(item({ id: "shell-2-output", seq: 5, type: "tool.output.delta", targetId: "shell-2", payload: { delta: { stream: "stdout", chunk: "two output" } } }));

    expect([...state.timelineRows]).toEqual([
      expect.objectContaining({ type: "shell", itemId: "shell-1", stdout: "" }),
      expect.objectContaining({ type: "shell", itemId: "shell-2", stdout: "two output" }),
      expect.objectContaining({ type: "approval-resolved", itemId: "approval-1-resolved" })
    ]);
  });

  it("processes 1k/5k shell and approval facts without rebuilds, copies, or materialization", () => {
    const projection = new InteractionProjection({ id: "thread-1", status: "running", turns: [], items: [] });
    const baseline = projection.getWork();
    let seq = 0;
    for (let index = 1; index <= 1000; index += 1) {
      const shellId = `shell-${index}`;
      const approvalId = `approval-${index}`;
      for (const nextItem of [
        item({ id: shellId, seq: ++seq, type: "tool.call.started", payload: { toolName: "shell", input: { command: String(index) } } }),
        item({ id: approvalId, seq: ++seq, type: "approval.requested", targetId: shellId, payload: { approvalId } }),
        item({ id: `${approvalId}-resolved`, seq: ++seq, type: "approval.resolved", targetId: shellId, payload: { approvalId, decision: "approveOnce" } }),
        item({ id: `${shellId}-output`, seq: ++seq, type: "tool.output.delta", targetId: shellId, payload: { delta: { stream: "stdout", chunk: "x" } } }),
        item({ id: `${shellId}-result`, seq: ++seq, type: "tool.result.completed", targetId: shellId, payload: { content: "exitCode: 0\nstdout:\nx\nstderr:\n" } })
      ]) {
        projection.apply({ type: "item/appended", threadId: "thread-1", turnId: "turn-1", item: nextItem });
      }
    }
    expect(workSince(baseline, projection.getWork())).toEqual({ fastPathOperations: 5000, rebuilds: 0, sequenceCopies: 0, fullMaterializations: 0, sequenceTraversals: 0, mapClones: 0, indexRebuilds: 0 });
  });

  it("records the actual copies, traversal, map clone, and index rebuild on the slow path", () => {
    const projection = new InteractionProjection({ id: "thread-1", status: "running", turns: [], items: [] });
    const baseline = projection.getWork();
    projection.apply({ type: "item/appended", threadId: "thread-1", turnId: "turn-1", item: item({ id: "second", seq: 2, type: "user.message.completed", payload: { content: "second" } }) });
    projection.apply({ type: "item/appended", threadId: "thread-1", turnId: "turn-1", item: item({ id: "first", seq: 1, type: "user.message.completed", payload: { content: "first" } }) });

    const work = workSince(baseline, projection.getWork());
    expect(work.fastPathOperations).toBe(1);
    expect(work.rebuilds).toBe(1);
    expect(work.mapClones).toBe(1);
    expect(work.indexRebuilds).toBe(1);
    expect(work.sequenceCopies).toBeGreaterThan(0);
    expect(work.fullMaterializations).toBeGreaterThan(0);
    expect(work.sequenceTraversals).toBeGreaterThan(0);
  });
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
    expect([...state.timelineRows]).toEqual([
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

  it("keeps system prompt items in state without rendering transcript rows", () => {
    const state = createWebUiState({
      id: "thread-1",
      status: "idle",
      turns: [
        {
          id: "turn-1",
          runId: "run-1",
          status: "completed",
          itemIds: ["system-1", "user-1"]
        }
      ],
      items: [
        item({
          id: "system-1",
          seq: 1,
          type: "system.message.completed",
          payload: { content: "You are Zen." }
        }),
        item({
          id: "user-1",
          seq: 2,
          type: "user.message.completed",
          payload: { content: "Hello" }
        })
      ]
    });

    expect(state.items.map((entry) => entry.type)).toEqual([
      "system.message.completed",
      "user.message.completed"
    ]);
    expect([...state.timelineRows]).toEqual([
      expect.objectContaining({
        type: "user",
        itemId: "user-1",
        content: "Hello"
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

    expect([...state.timelineRows]).toEqual(
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
    expect([...state.timelineRows]).toEqual(
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

    expect([...state.timelineRows]).toEqual([
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

    expect([...state.timelineRows]).toEqual([
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
      decision: "approveOnce",
      item: item({
        id: "approval-resolved",
        seq: 2,
        type: "approval.resolved",
        payload: {
          approvalId: "approval-1",
          decision: "approveOnce"
        }
      })
    });

    expect(state.timelineRows.filter((row) => row.type === "approval-pending")).toEqual(
      []
    );
    expect([...state.timelineRows]).toEqual([
      expect.objectContaining({
        type: "approval-resolved",
        itemId: "approval-resolved",
        approvalId: "approval-1",
        decision: "approveOnce"
      })
    ]);
  });

  it("projects first-class approval Items emitted by policy tool runtime", () => {
    const state = createWebUiState({
      id: "thread-1",
      status: "running",
      turns: [],
      items: [
        item({
          id: "approval-request-delta",
          seq: 1,
          type: "approval.requested",
          payload: {
            approvalId: "approval-1",
            threadId: "thread-1",
            turnId: "turn-1",
            runId: "run-1",
            toolCallId: "call-1",
            toolName: "shell",
            reason: "Run command?"
          }
        }),
        item({
          id: "approval-resolved-delta",
          seq: 2,
          type: "approval.resolved",
          payload: {
            approvalId: "approval-1",
            threadId: "thread-1",
            turnId: "turn-1",
            runId: "run-1",
            toolCallId: "call-1",
            toolName: "shell",
            decision: "decline"
          }
        })
      ]
    });

    expect([...state.timelineRows]).toEqual([
      expect.objectContaining({
        type: "approval-resolved",
        itemId: "approval-resolved-delta",
        approvalId: "approval-1",
        decision: "decline"
      })
    ]);
  });

  it("preserves approval rows for shell-targeted first-class Items", () => {
    const state = createWebUiState({
      id: "thread-1",
      status: "running",
      turns: [],
      items: [
        item({
          id: "shell-started",
          seq: 1,
          type: "tool.call.started",
          payload: {
            toolCallId: "call-1",
            toolName: "shell",
            input: { command: "npm test" }
          }
        }),
        item({
          id: "approval-request-delta",
          seq: 2,
          type: "approval.requested",
          targetId: "shell-started",
          payload: {
            approvalId: "approval-1",
            threadId: "thread-1",
            turnId: "turn-1",
            runId: "run-1",
            toolCallId: "call-1",
            toolName: "shell",
            reason: "Run command?"
          }
        }),
        item({
          id: "approval-resolved-delta",
          seq: 3,
          type: "approval.resolved",
          targetId: "shell-started",
          payload: {
            approvalId: "approval-1",
            threadId: "thread-1",
            turnId: "turn-1",
            runId: "run-1",
            toolCallId: "call-1",
            toolName: "shell",
            decision: "approveOnce"
          }
        })
      ]
    });

    expect([...state.timelineRows]).toEqual([
      expect.objectContaining({
        type: "shell",
        status: "running",
        command: "npm test"
      }),
      expect.objectContaining({
        type: "approval-resolved",
        approvalId: "approval-1",
        decision: "approveOnce"
      })
    ]);
  });

  it("projects shell output deltas into a running shell workbench row", () => {
    const state = createWebUiState({
      id: "thread-1",
      status: "running",
      turns: [],
      items: [
        item({
          id: "shell-started",
          seq: 1,
          type: "tool.call.started",
          payload: {
            toolCallId: "call-shell-1",
            toolName: "shell",
            input: { command: "npm test" }
          }
        }),
        item({
          id: "stdout-1",
          seq: 2,
          type: "tool.output.delta",
          targetId: "shell-started",
          payload: {
            toolCallId: "call-shell-1",
            toolName: "shell",
            delta: { stream: "stdout", chunk: "running tests\n" },
            index: 0
          }
        }),
        item({
          id: "stderr-1",
          seq: 3,
          type: "tool.output.delta",
          targetId: "shell-started",
          payload: {
            toolCallId: "call-shell-1",
            toolName: "shell",
            delta: { stream: "stderr", chunk: "warning\n" },
            index: 1
          }
        })
      ]
    });

    expect([...state.timelineRows]).toEqual([
      expect.objectContaining({
        type: "shell",
        itemId: "shell-started",
        toolCallId: "call-shell-1",
        command: "npm test",
        status: "running",
        stdout: "running tests\n",
        stderr: "warning\n"
      })
    ]);
  });

  it("projects completed shell results with parsed exit code and output", () => {
    const state = createWebUiState({
      id: "thread-1",
      status: "idle",
      turns: [],
      items: [
        item({
          id: "shell-started",
          seq: 1,
          type: "tool.call.started",
          payload: {
            toolCallId: "call-shell-1",
            toolName: "shell",
            input: { command: "npm test" }
          }
        }),
        item({
          id: "shell-result",
          seq: 2,
          type: "tool.result.completed",
          targetId: "shell-started",
          payload: {
            toolCallId: "call-shell-1",
            toolName: "shell",
            content: "exitCode: 0\nstdout:\nok\nstderr:\nwarn"
          }
        })
      ]
    });

    expect([...state.timelineRows]).toEqual([
      expect.objectContaining({
        type: "shell",
        status: "completed",
        exitCode: 0,
        stdout: "ok",
        stderr: "warn"
      })
    ]);
  });

  it("projects non-zero shell results as failed workbench rows", () => {
    const state = createWebUiState({
      id: "thread-1",
      status: "failed",
      turns: [],
      items: [
        item({
          id: "shell-started",
          seq: 1,
          type: "tool.call.started",
          payload: {
            toolCallId: "call-shell-1",
            toolName: "shell",
            input: { command: "npm test" }
          }
        }),
        item({
          id: "shell-result",
          seq: 2,
          type: "tool.result.completed",
          targetId: "shell-started",
          payload: {
            toolCallId: "call-shell-1",
            toolName: "shell",
            content: "exitCode: 7\nstderr:\nbad"
          }
        })
      ]
    });

    expect([...state.timelineRows]).toEqual([
      expect.objectContaining({
        type: "shell",
        status: "failed",
        exitCode: 7,
        stderr: "bad"
      })
    ]);
  });

  it("projects canceled shell errors as interrupted workbench rows", () => {
    const state = createWebUiState({
      id: "thread-1",
      status: "idle",
      turns: [],
      items: [
        item({
          id: "shell-started",
          seq: 1,
          type: "tool.call.started",
          payload: {
            toolCallId: "call-shell-1",
            toolName: "shell",
            input: { command: "npm test" }
          }
        }),
        item({
          id: "shell-error",
          seq: 2,
          type: "tool.error",
          targetId: "shell-started",
          payload: {
            toolCallId: "call-shell-1",
            toolName: "shell",
            message: "Shell command canceled"
          }
        })
      ]
    });

    expect([...state.timelineRows]).toEqual([
      expect.objectContaining({
        type: "shell",
        status: "interrupted",
        error: "Shell command canceled"
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

  it("uses the latest terminal turn to derive idle status after an older failure", () => {
    let state = createWebUiState({
      id: "thread-1",
      status: "failed",
      turns: [
        {
          id: "turn-1",
          runId: "run-1",
          status: "failed",
          itemIds: []
        }
      ],
      items: []
    });

    state = applyAppServerNotification(state, {
      type: "turn/completed",
      threadId: "thread-1",
      turn: {
        id: "turn-2",
        runId: "run-2",
        status: "completed",
        itemIds: []
      }
    });

    expect(state.currentThread?.status).toBe("idle");
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
    expect([...state.timelineRows]).toEqual([]);
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

function workSince(
  before: ReturnType<InteractionProjection["getWork"]>,
  after: ReturnType<InteractionProjection["getWork"]>
): ReturnType<InteractionProjection["getWork"]> {
  return {
    fastPathOperations: after.fastPathOperations - before.fastPathOperations,
    rebuilds: after.rebuilds - before.rebuilds,
    sequenceCopies: after.sequenceCopies - before.sequenceCopies,
    fullMaterializations: after.fullMaterializations - before.fullMaterializations,
    sequenceTraversals: after.sequenceTraversals - before.sequenceTraversals,
    mapClones: after.mapClones - before.mapClones,
    indexRebuilds: after.indexRebuilds - before.indexRebuilds
  };
}
