import { describe, expect, it } from "vitest";

import {
  appendToolExecutionItems,
  HookRuntime,
  InMemoryItemList,
  type ToolRuntime
} from "./test-exports.js";

describe("appendToolExecutionItems", () => {
  it("executes assistant-requested fake tools and appends start and completed result items", async () => {
    const items = createItems();
    const assistant = items.append({
      type: "assistant.message.completed",
      runId: "run-1",
      turnId: "turn-1",
      payload: {
        content: "Checking the weather.",
        toolCalls: [
          {
            id: "call-weather-1",
            name: "weather",
            input: { city: "Shanghai" }
          }
        ]
      }
    });
    const runtime: ToolRuntime = {
      async *execute(call) {
        expect(call).toEqual({
          id: "call-weather-1",
          name: "weather",
          input: { city: "Shanghai" }
        });

        yield {
          type: "result.completed",
          content: "Sunny and 24C"
        };
      }
    };

    await appendToolExecutionItems({
      itemList: items,
      toolRuntime: runtime,
      assistantItem: assistant
    });

    expect(items.getItems()).toEqual([
      assistant,
      expect.objectContaining({
        id: "item-2",
        type: "tool.call.started",
        causeId: assistant.id,
        visibility: "trace",
        payload: {
          toolCallId: "call-weather-1",
          toolName: "weather",
          input: { city: "Shanghai" }
        }
      }),
      expect.objectContaining({
        id: "item-3",
        type: "tool.result.completed",
        causeId: "item-2",
        targetId: "item-2",
        payload: {
          toolCallId: "call-weather-1",
          toolName: "weather",
          input: { city: "Shanghai" },
          content: "Sunny and 24C"
        }
      })
    ]);
  });

  it("appends tool output deltas as trace items targeting the started tool call", async () => {
    const items = createItems();
    const assistant = appendAssistantToolCall(items);
    const runtime: ToolRuntime = {
      async *execute() {
        yield { type: "output.delta", delta: "partial " };
        yield { type: "output.delta", delta: "output" };
        yield { type: "result.completed", content: "partial output" };
      }
    };

    await appendToolExecutionItems({
      itemList: items,
      toolRuntime: runtime,
      assistantItem: assistant
    });

    const snapshot = items.getItems();
    const started = snapshot.find((item) => item.type === "tool.call.started");

    expect(snapshot).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "item-3",
          type: "tool.output.delta",
          causeId: started?.id,
          targetId: started?.id,
          visibility: "trace",
          payload: expect.objectContaining({
            toolCallId: "call-weather-1",
            toolName: "weather",
            delta: "partial ",
            index: 0
          })
        }),
        expect.objectContaining({
          id: "item-4",
          type: "tool.output.delta",
          causeId: started?.id,
          targetId: started?.id,
          visibility: "trace",
          payload: expect.objectContaining({
            toolCallId: "call-weather-1",
            toolName: "weather",
            delta: "output",
            index: 1
          })
        })
      ])
    );
  });

  it("appends a tool error item with failure details while preserving prior trace", async () => {
    const items = createItems();
    const assistant = appendAssistantToolCall(items);
    const runtime: ToolRuntime = {
      async *execute() {
        yield { type: "output.delta", delta: "before failure" };
        throw new Error("fake tool failed");
      }
    };

    await appendToolExecutionItems({
      itemList: items,
      toolRuntime: runtime,
      assistantItem: assistant
    });

    expect(items.getItems().map((item) => item.type)).toEqual([
      "assistant.message.completed",
      "tool.call.started",
      "tool.output.delta",
      "tool.error"
    ]);
    expect(items.getItems()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "item-3",
          type: "tool.output.delta",
          targetId: "item-2",
          payload: expect.objectContaining({ delta: "before failure" })
        }),
        expect.objectContaining({
          id: "item-4",
          type: "tool.error",
          causeId: "item-2",
          targetId: "item-2",
          visibility: "trace",
          payload: expect.objectContaining({
            toolCallId: "call-weather-1",
            toolName: "weather",
            message: "fake tool failed",
            cause: { name: "Error", message: "fake tool failed" }
          })
        })
      ])
    );
  });

  it("returns appended tool execution items for one assistant tool-call batch", async () => {
    const items = createItems();
    const assistant = items.append({
      type: "assistant.message.completed",
      runId: "run-1",
      turnId: "turn-1",
      payload: {
        content: "Checking multiple tools.",
        toolCalls: [
          { id: "call-weather-1", name: "weather", input: { city: "Shanghai" } },
          { id: "call-time-1", name: "time", input: { zone: "Asia/Shanghai" } }
        ]
      }
    });
    const runtime: ToolRuntime = {
      async *execute(call) {
        yield {
          type: "result.completed",
          content: `${call.name} result`
        };
      }
    };

    const result = await appendToolExecutionItems({
      itemList: items,
      toolRuntime: runtime,
      assistantItem: assistant
    });

    expect(result.started.map((item) => item.payload)).toEqual([
      {
        toolCallId: "call-weather-1",
        toolName: "weather",
        input: { city: "Shanghai" }
      },
      {
        toolCallId: "call-time-1",
        toolName: "time",
        input: { zone: "Asia/Shanghai" }
      }
    ]);
    expect(result.completed.map((item) => item.payload)).toEqual([
      expect.objectContaining({
        toolCallId: "call-weather-1",
        content: "weather result"
      }),
      expect.objectContaining({
        toolCallId: "call-time-1",
        content: "time result"
      })
    ]);
    expect(result.errors).toEqual([]);
  });

  it("lets beforeToolCall hooks block a tool call with visible hook.effect evidence", async () => {
    const items = createItems();
    const assistant = appendAssistantToolCall(items);
    const hooks = new HookRuntime({
      itemList: items,
      hooks: {
        beforeToolCall({ call }) {
          return {
            decision: {
              type: "block",
              reason: `blocked ${call.name}`
            }
          };
        }
      }
    });
    let toolExecuted = false;
    const runtime: ToolRuntime = {
      async *execute() {
        toolExecuted = true;
        yield { type: "result.completed", content: "should not run" };
      }
    };

    const result = await appendToolExecutionItems({
      itemList: items,
      toolRuntime: runtime,
      assistantItem: assistant,
      hookRuntime: hooks
    });

    expect(toolExecuted).toBe(false);
    expect(result).toEqual({ started: [], completed: [], errors: [] });
    expect(items.getItems()).toEqual([
      assistant,
      expect.objectContaining({
        id: "item-2",
        type: "hook.effect",
        runId: "run-1",
        turnId: "turn-1",
        visibility: "trace",
        payload: {
          hook: "beforeToolCall",
          effect: "block",
          reason: "blocked weather",
          toolCallId: "call-weather-1",
          toolName: "weather"
        }
      })
    ]);
  });
});

function createItems(): InMemoryItemList {
  return new InMemoryItemList({
    generateId: (() => {
      let nextId = 0;
      return () => `item-${++nextId}`;
    })(),
    clock: () => 1000
  });
}

function appendAssistantToolCall(items: InMemoryItemList) {
  return items.append({
    type: "assistant.message.completed",
    runId: "run-1",
    turnId: "turn-1",
    payload: {
      content: "Checking the weather.",
      toolCalls: [
        {
          id: "call-weather-1",
          name: "weather",
          input: { city: "Shanghai" }
        }
      ]
    }
  });
}
