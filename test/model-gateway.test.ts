import { describe, expect, it } from "vitest";

import {
  appendModelResponseItems,
  InMemoryItemList,
  OpenAiCompatibleModelGateway,
  type ModelEvent,
  type ModelGateway
} from "./test-exports.js";

describe("appendModelResponseItems", () => {
  it("appends streamed text deltas as trace items targeting the assistant response", async () => {
    const items = createItems();
    const model = fakeModel([
      { type: "text.delta", text: "Hel" },
      { type: "text.delta", text: "lo" },
      { type: "message.completed", content: "Hello" }
    ]);

    await appendModelResponseItems({
      itemList: items,
      model,
      context: { parts: [] },
      runId: "run-1",
      turnId: "turn-1"
    });

    const snapshot = items.getItems();
    const assistantStarted = snapshot.find(
      (item) => item.type === "assistant.message.started"
    );
    const deltas = snapshot.filter(
      (item) => item.type === "assistant.message.delta"
    );

    expect(assistantStarted).toBeDefined();
    expect(deltas).toEqual([
      expect.objectContaining({
        targetId: assistantStarted?.id,
        visibility: "trace",
        payload: { delta: "Hel", index: 0 }
      }),
      expect.objectContaining({
        targetId: assistantStarted?.id,
        visibility: "trace",
        payload: { delta: "lo", index: 1 }
      })
    ]);
  });

  it("uses completed output as authoritative instead of reconstructing from deltas", async () => {
    const items = createItems();
    const model = fakeModel([
      { type: "text.delta", text: "Hel" },
      { type: "text.delta", text: "lo" },
      { type: "message.completed", content: "Goodbye" }
    ]);

    await appendModelResponseItems({
      itemList: items,
      model,
      context: { parts: [] },
      runId: "run-1",
      turnId: "turn-1"
    });

    expect(
      items
        .getItems()
        .filter((item) => item.type === "assistant.message.completed")
    ).toEqual([
      expect.objectContaining({
        payload: { content: "Goodbye" }
      })
    ]);
  });

  it("appends an assistant error item and completed request item when the model fails", async () => {
    const items = createItems();
    const model: ModelGateway = {
      async *generate() {
        yield { type: "text.delta", text: "partial" };
        throw new Error("fake model failed");
      }
    };

    await appendModelResponseItems({
      itemList: items,
      model,
      context: { parts: [] },
      runId: "run-1",
      turnId: "turn-1"
    });

    const snapshot = items.getItems();
    const requestStarted = snapshot.find(
      (item) => item.type === "model.request.started"
    );
    const assistantStarted = snapshot.find(
      (item) => item.type === "assistant.message.started"
    );

    expect(snapshot).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "assistant.message.error",
          causeId: requestStarted?.id,
          targetId: assistantStarted?.id,
          visibility: "trace",
          payload: {
            message: "fake model failed",
            cause: { name: "Error", message: "fake model failed" }
          }
        }),
        expect.objectContaining({
          type: "model.request.completed",
          causeId: requestStarted?.id,
          visibility: "trace",
          payload: { status: "error" }
        })
      ])
    );
  });

  it("converts emitted model error events into assistant error items", async () => {
    const items = createItems();
    const model = fakeModel([
      { type: "error", error: "provider returned an error" }
    ]);

    await appendModelResponseItems({
      itemList: items,
      model,
      context: { parts: [] },
      runId: "run-1",
      turnId: "turn-1"
    });

    expect(items.getItems()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "assistant.message.error",
          visibility: "trace",
          payload: {
            message: "provider returned an error",
            cause: "provider returned an error"
          }
        }),
        expect.objectContaining({
          type: "model.request.completed",
          payload: { status: "error" }
        })
      ])
    );
  });

  it("appends request lifecycle items around model generation", async () => {
    const items = createItems();
    const context = {
      parts: [{ type: "message" as const, role: "user" as const, content: "Hi" }]
    };
    const options = { model: "fake-model", temperature: 0 };
    let observedContext: unknown;
    let observedOptions: unknown;
    const model: ModelGateway = {
      async *generate(receivedContext, receivedOptions) {
        observedContext = receivedContext;
        observedOptions = receivedOptions;
        yield { type: "message.completed", content: "Hello" };
      }
    };

    await appendModelResponseItems({
      itemList: items,
      model,
      context,
      options,
      runId: "run-1",
      turnId: "turn-1"
    });

    expect(observedContext).toBe(context);
    expect(observedOptions).toBe(options);
    expect(items.getItems().map((item) => item.type)).toEqual([
      "model.request.started",
      "assistant.message.started",
      "assistant.message.completed",
      "model.request.completed"
    ]);
    expect(items.getItems()).toEqual([
      expect.objectContaining({
        id: "item-1",
        type: "model.request.started",
        visibility: "trace",
        payload: { options, contextPartCount: 1 }
      }),
      expect.objectContaining({
        id: "item-2",
        type: "assistant.message.started",
        causeId: "item-1",
        visibility: "trace"
      }),
      expect.objectContaining({
        id: "item-3",
        type: "assistant.message.completed",
        causeId: "item-1",
        targetId: "item-2",
        payload: { content: "Hello" }
      }),
      expect.objectContaining({
        id: "item-4",
        type: "model.request.completed",
        causeId: "item-1",
        targetId: "item-3",
        visibility: "trace",
        payload: { status: "completed" }
      })
    ]);
  });
});

describe("OpenAiCompatibleModelGateway", () => {
  it("sends only compiled context messages without injecting a hidden system prompt", async () => {
    const originalFetch = globalThis.fetch;
    const requests: unknown[] = [];
    globalThis.fetch = (async (_input, init) => {
      requests.push(JSON.parse(String(init?.body)));

      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
            controller.close();
          }
        }),
        { status: 200 }
      );
    }) as typeof fetch;

    try {
      const gateway = new OpenAiCompatibleModelGateway({
        baseUrl: "https://provider.test/v1",
        apiKey: "test-key",
        model: "test-model"
      });

      await collect(
        gateway.generate({
          parts: [
            { type: "message", role: "system", content: "You are Zen." },
            { type: "message", role: "user", content: "Hello" }
          ]
        })
      );
      await collect(gateway.generate({ parts: [] }));

      expect(requests).toEqual([
        expect.objectContaining({
          messages: [
            { role: "system", content: "You are Zen." },
            { role: "user", content: "Hello" }
          ]
        }),
        expect.objectContaining({
          messages: []
        })
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("preserves streamed tool call ids when later provider deltas send empty ids", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            const encoder = new TextEncoder();
            const chunks = [
              {
                choices: [
                  {
                    delta: {
                      tool_calls: [
                        {
                          index: 0,
                          id: "functions.shell:0",
                          function: { name: "shell", arguments: "" }
                        }
                      ]
                    }
                  }
                ]
              },
              {
                choices: [
                  {
                    delta: {
                      tool_calls: [
                        {
                          index: 0,
                          id: "",
                          function: { arguments: "{\"command\"" }
                        }
                      ]
                    }
                  }
                ]
              },
              {
                choices: [
                  {
                    delta: {
                      tool_calls: [
                        {
                          index: 0,
                          id: "",
                          function: { arguments: ":\"Write-Output probe\"}" }
                        }
                      ]
                    }
                  }
                ]
              }
            ];

            for (const chunk of chunks) {
              controller.enqueue(
                encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`)
              );
            }

            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
          }
        }),
        { status: 200 }
      )) as typeof fetch;

    try {
      const gateway = new OpenAiCompatibleModelGateway({
        baseUrl: "https://provider.test/v1",
        apiKey: "test-key",
        model: "test-model"
      });

      await expect(collect(gateway.generate({ parts: [] }))).resolves.toEqual([
        {
          type: "message.completed",
          content: "",
          toolCalls: [
            {
              id: "functions.shell:0",
              name: "shell",
              input: { command: "Write-Output probe" }
            }
          ]
        }
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
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

function fakeModel(events: readonly ModelEvent[]): ModelGateway {
  return {
    async *generate() {
      yield* events;
    }
  };
}

async function collect<T>(events: AsyncIterable<T>): Promise<readonly T[]> {
  const collected: T[] = [];

  for await (const event of events) {
    collected.push(event);
  }

  return collected;
}
