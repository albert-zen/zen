import { describe, expect, it } from "vitest";

import { ContextCompiler, type Item } from "../src/index.js";

describe("ContextCompiler", () => {
  it("compiles completed system messages into model context by seq", () => {
    const compiler = new ContextCompiler();
    const context = compiler.compile([
      item({
        id: "user-1",
        seq: 2,
        type: "user.message.completed",
        payload: { content: "Hi" }
      }),
      item({
        id: "system-1",
        seq: 1,
        type: "system.message.completed",
        payload: { content: "You are Zen." }
      })
    ]);

    expect(context.parts).toEqual([
      { type: "message", role: "system", content: "You are Zen." },
      { type: "message", role: "user", content: "Hi" }
    ]);
  });

  it("compiles completed user and assistant messages into model context by seq", () => {
    const compiler = new ContextCompiler();
    const laterAssistant = item({
      id: "assistant-1",
      seq: 3,
      type: "assistant.message.completed",
      payload: { content: "Hello." }
    });
    const earlierUser = item({
      id: "user-1",
      seq: 1,
      type: "user.message.completed",
      payload: { content: "Hi" }
    });

    const context = compiler.compile([laterAssistant, earlierUser]);

    expect(context).toEqual({
      parts: [
        { type: "message", role: "user", content: "Hi" },
        { type: "message", role: "assistant", content: "Hello." }
      ]
    });
  });

  it("ignores assistant and tool delta items when compiling completed context", () => {
    const compiler = new ContextCompiler();
    const items = [
      item({
        id: "user-1",
        seq: 1,
        type: "user.message.completed",
        payload: { content: "Run the search" }
      }),
      item({
        id: "assistant-delta-1",
        seq: 2,
        type: "assistant.message.delta",
        targetId: "assistant-1",
        visibility: "trace",
        payload: { delta: "Searching", index: 0 }
      }),
      item({
        id: "tool-delta-1",
        seq: 3,
        type: "tool.output.delta",
        targetId: "tool-result-1",
        visibility: "trace",
        payload: { delta: "partial result", index: 0 }
      }),
      item({
        id: "assistant-1",
        seq: 4,
        type: "assistant.message.completed",
        payload: { content: "I found the answer." }
      })
    ];

    const context = compiler.compile(items);

    expect(context.parts).toEqual([
      { type: "message", role: "user", content: "Run the search" },
      { type: "message", role: "assistant", content: "I found the answer." }
    ]);
  });

  it("ignores lifecycle and internal items by default", () => {
    const compiler = new ContextCompiler();
    const items = [
      item({
        id: "run-started",
        seq: 1,
        type: "run.started",
        visibility: "trace",
        payload: { input: "start" }
      }),
      item({
        id: "internal-user",
        seq: 2,
        type: "user.message.completed",
        visibility: "internal",
        payload: { content: "hidden instruction" }
      }),
      item({
        id: "visible-user",
        seq: 3,
        type: "user.message.completed",
        payload: { content: "visible request" }
      }),
      item({
        id: "hook-effect",
        seq: 4,
        type: "hook.effect",
        visibility: "internal",
        payload: { hook: "beforeContextCompile" }
      }),
      item({
        id: "turn-completed",
        seq: 5,
        type: "turn.completed",
        visibility: "trace",
        payload: { reason: "stop" }
      })
    ];

    const context = compiler.compile(items);

    expect(context.parts).toEqual([
      { type: "message", role: "user", content: "visible request" }
    ]);
  });

  it("compiles completed tool results with tool call linkage", () => {
    const compiler = new ContextCompiler();
    const items = [
      item({
        id: "assistant-1",
        seq: 1,
        type: "assistant.message.completed",
        payload: { content: "Checking the weather." }
      }),
      item({
        id: "tool-result-1",
        seq: 2,
        type: "tool.result.completed",
        causeId: "assistant-1",
        payload: {
          toolCallId: "call-weather-1",
          toolName: "weather",
          content: "Sunny and 72F"
        }
      })
    ];

    const context = compiler.compile(items);

    expect(context.parts).toEqual([
      {
        type: "message",
        role: "assistant",
        content: "Checking the weather."
      },
      {
        type: "toolResult",
        toolCallId: "call-weather-1",
        toolName: "weather",
        content: "Sunny and 72F"
      }
    ]);
  });

  it("does not mutate input item order or item payloads while compiling context", () => {
    const compiler = new ContextCompiler();
    const userPayload = { content: "Second by seq" };
    const assistantPayload = { content: "First by seq" };
    const input = [
      item({
        id: "user-1",
        seq: 2,
        type: "user.message.completed",
        payload: userPayload
      }),
      item({
        id: "assistant-1",
        seq: 1,
        type: "assistant.message.completed",
        payload: assistantPayload
      })
    ];

    const context = compiler.compile(input);

    expect(context.parts).toEqual([
      { type: "message", role: "assistant", content: "First by seq" },
      { type: "message", role: "user", content: "Second by seq" }
    ]);
    expect(input.map((inputItem) => inputItem.id)).toEqual([
      "user-1",
      "assistant-1"
    ]);
    expect(input[0]?.payload).toBe(userPayload);
    expect(input[1]?.payload).toBe(assistantPayload);
    expect(userPayload).toEqual({ content: "Second by seq" });
    expect(assistantPayload).toEqual({ content: "First by seq" });
  });
});

function item(overrides: Partial<Item>): Item {
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
