import { describe, expect, it } from "vitest";

import {
  AgentLoop,
  InMemoryItemList,
  type ModelContext,
  type ModelEvent,
  type ModelGateway,
  type ToolRuntime
} from "../src/index.js";

describe("AgentLoop", () => {
  it("runs a full fake model turn without a tool call through the public API", async () => {
    const itemList = createItems();
    const observedContexts: ModelContext[] = [];
    const model = fakeModel([
      { type: "message.completed", content: "Hello from fake model" }
    ], observedContexts);
    const agent = new AgentLoop({ itemList, model });

    const result = await agent.run({
      input: "Hello",
      runId: "run-1",
      turnId: "turn-1"
    });

    expect(observedContexts).toEqual([
      {
        parts: [{ type: "message", role: "user", content: "Hello" }]
      }
    ]);
    expect(result.items.map((item) => item.type)).toEqual([
      "run.started",
      "turn.started",
      "user.message.completed",
      "model.request.started",
      "assistant.message.started",
      "assistant.message.completed",
      "model.request.completed",
      "turn.completed",
      "run.completed"
    ]);
    expect(result.items).toEqual(itemList.getItems());
    expect(result.finalContext.parts).toEqual([
      { type: "message", role: "user", content: "Hello" },
      { type: "message", role: "assistant", content: "Hello from fake model" }
    ]);
  });

  it("executes one fake tool call and exposes the result to a follow-up model step", async () => {
    const itemList = createItems();
    const observedContexts: ModelContext[] = [];
    let modelCalls = 0;
    const model: ModelGateway = {
      async *generate(context) {
        observedContexts.push(context);
        modelCalls += 1;

        if (modelCalls === 1) {
          yield {
            type: "message.completed",
            content: "Checking the weather.",
            toolCalls: [
              {
                id: "call-weather-1",
                name: "weather",
                input: { city: "Shanghai" }
              }
            ]
          };
          return;
        }

        yield {
          type: "message.completed",
          content: "It is sunny in Shanghai."
        };
      }
    };
    const toolRuntime: ToolRuntime = {
      async *execute(call) {
        expect(call).toEqual({
          id: "call-weather-1",
          name: "weather",
          input: { city: "Shanghai" }
        });
        yield { type: "result.completed", content: "Sunny and 24C" };
      }
    };
    const agent = new AgentLoop({ itemList, model, toolRuntime });

    const result = await agent.run({
      input: "What is the weather?",
      runId: "run-1",
      turnId: "turn-1"
    });

    expect(result.items.map((item) => item.type)).toEqual([
      "run.started",
      "turn.started",
      "user.message.completed",
      "model.request.started",
      "assistant.message.started",
      "assistant.message.completed",
      "model.request.completed",
      "tool.call.started",
      "tool.result.completed",
      "model.request.started",
      "assistant.message.started",
      "assistant.message.completed",
      "model.request.completed",
      "turn.completed",
      "run.completed"
    ]);
    expect(observedContexts[1]?.parts).toEqual([
      { type: "message", role: "user", content: "What is the weather?" },
      { type: "message", role: "assistant", content: "Checking the weather." },
      {
        type: "toolResult",
        toolCallId: "call-weather-1",
        toolName: "weather",
        content: "Sunny and 24C"
      }
    ]);
    expect(result.finalContext.parts).toEqual([
      { type: "message", role: "user", content: "What is the weather?" },
      { type: "message", role: "assistant", content: "Checking the weather." },
      {
        type: "toolResult",
        toolCallId: "call-weather-1",
        toolName: "weather",
        content: "Sunny and 24C"
      },
      { type: "message", role: "assistant", content: "It is sunny in Shanghai." }
    ]);
  });

  it("keeps completed assistant output authoritative when streamed deltas differ", async () => {
    const itemList = createItems();
    const model = fakeModel([
      { type: "text.delta", text: "draft " },
      { type: "text.delta", text: "answer" },
      { type: "message.completed", content: "final answer" }
    ]);
    const agent = new AgentLoop({ itemList, model });

    const result = await agent.run({
      input: "Answer with a rewrite",
      runId: "run-1",
      turnId: "turn-1"
    });

    expect(result.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "assistant.message.delta",
          payload: { delta: "draft ", index: 0 }
        }),
        expect.objectContaining({
          type: "assistant.message.delta",
          payload: { delta: "answer", index: 1 }
        }),
        expect.objectContaining({
          type: "assistant.message.completed",
          payload: { content: "final answer" }
        })
      ])
    );
    expect(result.finalContext.parts).toEqual([
      { type: "message", role: "user", content: "Answer with a rewrite" },
      { type: "message", role: "assistant", content: "final answer" }
    ]);
  });

  it("lets hooks add auditable effects without hidden state mutation", async () => {
    const itemList = createItems();
    const model = fakeModel([
      { type: "message.completed", content: "Hook-visible answer" }
    ]);
    const agent = new AgentLoop({
      itemList,
      model,
      hooks: {
        onItemAppended({ item }) {
          if (item.type !== "user.message.completed") {
            return;
          }

          return {
            append: [
              {
                type: "hook.effect",
                runId: item.runId,
                turnId: item.turnId,
                causeId: item.id,
                visibility: "trace",
                payload: {
                  hook: "onItemAppended",
                  effect: "audit",
                  itemType: item.type
                }
              }
            ]
          };
        }
      }
    });

    const result = await agent.run({
      input: "Record hook evidence",
      runId: "run-1",
      turnId: "turn-1"
    });

    const userItem = result.items.find(
      (item) => item.type === "user.message.completed"
    );

    expect(result.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "hook.effect",
          causeId: userItem?.id,
          visibility: "trace",
          payload: {
            hook: "onItemAppended",
            effect: "audit",
            itemType: "user.message.completed"
          }
        })
      ])
    );
    expect(result.finalContext.parts).toEqual([
      { type: "message", role: "user", content: "Record hook evidence" },
      { type: "message", role: "assistant", content: "Hook-visible answer" }
    ]);
  });

  it("notifies observers in the same appended item order as the item list", async () => {
    const observed: string[] = [];
    const itemList = createItems();

    itemList.observe((item) => {
      observed.push(`${item.seq}:${item.type}`);
    });

    const model = fakeModel([
      { type: "text.delta", text: "Hello" },
      { type: "message.completed", content: "Hello" }
    ]);
    const agent = new AgentLoop({ itemList, model });

    const result = await agent.run({
      input: "Observe the run",
      runId: "run-1",
      turnId: "turn-1"
    });

    expect(observed).toEqual(
      result.items.map((item) => `${item.seq}:${item.type}`)
    );
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

function fakeModel(
  events: readonly ModelEvent[],
  observedContexts: ModelContext[] = []
): ModelGateway {
  return {
    async *generate(context) {
      observedContexts.push(context);
      yield* events;
    }
  };
}
