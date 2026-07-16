import { describe, expect, it } from "vitest";

import {
  AppServer,
  type AppServerClient,
  type AppServerNotificationListener,
  type AppServerSubscription,
  BrowserAppServerTransportClient,
  HttpAppServerClient,
  WebUiClient,
  serveAppServerHttpTransport,
  type ModelGateway
} from "../src/index.js";

describe("Web UI client", () => {
  it("uses same-origin browser routes without receiving a capability", async () => {
    const requests: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    let eventUrl: string | undefined;
    const eventSource = new RecordingEventSource();
    const client = new BrowserAppServerTransportClient({
      baseUrl: "https://cross-origin.invalid",
      fetch: (async (input, init) => {
        requests.push({ input, init });
        return new Response(
          JSON.stringify({
            method: "thread/list",
            ok: true,
            result: { threads: [] }
          }),
          { status: 200 }
        );
      }) as typeof fetch,
      createEventSource: (url) => {
        eventUrl = url;
        return eventSource;
      }
    });

    await client.request({ method: "thread/list" });
    const unsubscribe = client.subscribe(() => undefined);

    expect(requests).toHaveLength(1);
    expect(requests[0]?.input).toBe("/request");
    expect(requests[0]?.init?.headers).toEqual({
      accept: "application/json",
      "content-type": "application/json"
    });
    expect(eventUrl).toBe("/events");

    unsubscribe();
  });

  it("connects through real transport and projects streamed turn notifications", async () => {
    const server = new AppServer({
      threadManagerOptions: {
        generateThreadId: sequence("thread"),
        generateRunId: sequence("run"),
        generateTurnId: sequence("turn"),
        generateItemId: sequence("item"),
        clock: () => 1000,
        runtimeFactory: () => ({
          model: {
            async *generate() {
              yield { type: "text.delta", text: "Hel" };
              yield { type: "text.delta", text: "lo" };
              yield { type: "message.completed", content: "Hello" };
            }
          } satisfies ModelGateway
        })
      }
    });
    const transport = await serveAppServerHttpTransport({ appServer: server });
    const client = new HttpAppServerClient({
      baseUrl: transport.url,
      capability: transport.capability
    });
    const webUi = new WebUiClient({ client });

    try {
      await webUi.connect();
      expect(webUi.getSnapshot().connection.status).toBe("connected");
      expect(webUi.getSnapshot().state.currentThread?.id).toBe("thread-1");

      await webUi.submitMessage("Hello");
      await waitForStatus(webUi, "connected");

      const snapshot = webUi.getSnapshot();
      expect(snapshot.state.currentThread?.status).toBe("idle");
      expect(snapshot.state.timelineRows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "user", content: "Hello" }),
          expect.objectContaining({ type: "assistant", content: "Hello" })
        ])
      );
    } finally {
      webUi.disconnect();
      await transport.close();
    }
  });

  it("shows failed and disconnected states outside the item projection", async () => {
    const client = new RecordingClient();
    const webUi = new WebUiClient({ client });

    await webUi.connect();
    await webUi.submitMessage("fail");
    client.emit({
      type: "turn/failed",
      threadId: "thread-1",
      turn: {
        id: "turn-1",
        runId: "run-1",
        status: "failed",
        itemIds: []
      },
      error: {
        code: "MODEL_FAILED",
        message: "model failed"
      }
    });

    expect(webUi.getSnapshot()).toEqual(
      expect.objectContaining({
        connection: {
          mode: "real",
          status: "failed",
          message: "model failed"
        },
        state: expect.objectContaining({
          currentThread: expect.objectContaining({ status: "failed" })
        })
      })
    );

    webUi.disconnect();

    expect(webUi.getSnapshot().connection).toEqual({
      mode: "real",
      status: "disconnected"
    });
  });

  it("resumes an existing thread by reading it through the client", async () => {
    const client = new RecordingClient();
    const webUi = new WebUiClient({ client });

    await webUi.connect({ threadId: "thread-1" });

    expect(webUi.getSnapshot()).toEqual(
      expect.objectContaining({
        connection: { mode: "real", status: "connected" },
        state: expect.objectContaining({
          currentThread: {
            id: "thread-1",
            status: "idle",
            turns: []
          }
        })
      })
    );
    expect(client.requests.map((request) => request.method)).toEqual(["thread/read"]);
  });
});

function sequence(prefix: string): () => string {
  let nextId = 0;

  return () => `${prefix}-${++nextId}`;
}

async function waitForStatus(
  client: WebUiClient,
  status: ReturnType<WebUiClient["getSnapshot"]>["connection"]["status"]
): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (client.getSnapshot().connection.status === status) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  throw new Error(`Timed out waiting for ${status}`);
}

class RecordingClient implements AppServerClient {
  private listener?: AppServerNotificationListener;
  readonly requests: Parameters<AppServerClient["request"]>[0][] = [];

  request(request: Parameters<AppServerClient["request"]>[0]) {
    this.requests.push(request);

    if (request.method === "thread/start") {
      return Promise.resolve({
        method: "thread/start",
        ok: true,
        result: {
          thread: {
            id: "thread-1",
            status: "idle",
            turns: [],
            items: []
          }
        }
      } as const);
    }

    if (request.method === "thread/read") {
      return Promise.resolve({
        method: "thread/read",
        ok: true,
        result: {
          thread: {
            id: "thread-1",
            status: "idle",
            turns: [],
            items: []
          }
        }
      } as const);
    }

    if (request.method === "turn/start") {
      this.emit({
        type: "turn/started",
        threadId: "thread-1",
        turn: {
          id: "turn-1",
          runId: "run-1",
          status: "inProgress",
          itemIds: []
        }
      });

      return Promise.resolve({
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
      } as const);
    }

    return Promise.resolve({
      method: request.method,
      ok: false,
      error: {
        code: "UNKNOWN_METHOD",
        message: `Unknown method ${request.method}`
      }
    } as const);
  }

  subscribe(listener: AppServerNotificationListener): AppServerSubscription {
    this.listener = listener;

    return () => {
      this.listener = undefined;
    };
  }

  emit(notification: Parameters<AppServerNotificationListener>[0]): void {
    this.listener?.(notification);
  }
}

class RecordingEventSource {
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  addEventListener(): void {}

  close(): void {}
}
