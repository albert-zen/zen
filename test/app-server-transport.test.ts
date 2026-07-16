import { describe, expect, it } from "vitest";

import {
  AgentInteractionSession,
  AppServer,
  type AppServerClient,
  type AppServerNotification,
  type AppServerResponse,
  HttpAppServerClient,
  serveAppServerHttpTransport,
  type ModelGateway,
  type ToolRuntime
} from "../src/index.js";

const TEST_CAPABILITY = "test-capability-0123456789-abcdef-0123456789";

describe("App Server HTTP transport", () => {
  it("rejects requests without a matching capability before dispatch", async () => {
    const server = createServer();
    const transport = await serveAppServerHttpTransport({
      appServer: server,
      capability: TEST_CAPABILITY
    });

    try {
      for (const authorization of [
        undefined,
        "Bearer mismatched-capability-0123456789-abcdef"
      ]) {
        const unauthorized = await fetch(new URL("/request", transport.url), {
          method: "POST",
          headers: {
            ...(authorization ? { authorization } : {}),
            "content-type": "application/json"
          },
          body: JSON.stringify({ method: "thread/start" })
        });
        const unauthorizedBody = await unauthorized.text();

        expect(unauthorized.status).toBe(401);
        expect(JSON.parse(unauthorizedBody)).toEqual({
          method: "transport/request",
          ok: false,
          error: {
            code: "UNAUTHORIZED",
            message: "App Server capability is missing or invalid"
          }
        });
        expect(unauthorizedBody).not.toContain(TEST_CAPABILITY);
      }

      const authorized = await fetch(new URL("/request", transport.url), {
        method: "POST",
        headers: {
          authorization: `Bearer ${TEST_CAPABILITY}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({ method: "thread/list" })
      });

      await expect(authorized.json()).resolves.toEqual({
        method: "thread/list",
        ok: true,
        result: { threads: [], persistenceFailures: [] }
      });
    } finally {
      await transport.close();
    }
  });

  it("generates independent 256-bit capabilities by default", async () => {
    const first = await serveAppServerHttpTransport({ appServer: createServer() });
    const second = await serveAppServerHttpTransport({ appServer: createServer() });

    try {
      expect(Buffer.from(first.capability, "base64url")).toHaveLength(32);
      expect(Buffer.from(second.capability, "base64url")).toHaveLength(32);
      expect(first.capability).not.toBe(second.capability);
    } finally {
      await first.close();
      await second.close();
    }
  });

  it("rejects short, whitespace, and control-character provided capabilities", async () => {
    const capabilities = [
      "too-short",
      "provided capability 0123456789 abcdef 0123456789",
      "provided-capability-0123456789\u0000abcdef-0123456789"
    ];

    for (const capability of capabilities) {
      let rejection: unknown;

      try {
        await serveAppServerHttpTransport({
          appServer: createServer(),
          capability
        });
      } catch (cause) {
        rejection = cause;
      }

      expect(rejection).toEqual(
        new Error(
          "App Server capability must be at least 32 bytes without whitespace or control characters"
        )
      );
      expect(String(rejection)).not.toContain(capability);
    }
  });

  it("rejects event streams without a matching capability before subscribing", async () => {
    const server = createServer();
    const transport = await serveAppServerHttpTransport({
      appServer: server,
      capability: TEST_CAPABILITY
    });

    try {
      for (const authorization of [
        undefined,
        "Bearer mismatched-capability-0123456789-abcdef"
      ]) {
        const response = await fetch(new URL("/events", transport.url), {
          headers: authorization ? { authorization } : undefined
        });

        expect(response.status).toBe(401);
        const body = await response.text();
        expect(JSON.parse(body)).toEqual({
          method: "transport/request",
          ok: false,
          error: {
            code: "UNAUTHORIZED",
            message: "App Server capability is missing or invalid"
          }
        });
        expect(body).not.toContain(TEST_CAPABILITY);
      }
    } finally {
      await transport.close();
    }
  });

  it("lets a client start, list, and read threads through transport", async () => {
    const server = createServer();
    const transport = await serveAppServerHttpTransport({ appServer: server });
    const client = new HttpAppServerClient({
      baseUrl: transport.url,
      capability: transport.capability
    });

    try {
      const start = await client.request({ method: "thread/start" });

      expect(start).toEqual({
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
      });

      if (!start.ok || start.method !== "thread/start") {
        throw new Error("thread/start failed");
      }

      await expect(client.request({ method: "thread/list" })).resolves.toEqual({
        method: "thread/list",
        ok: true,
        result: { threads: [start.result.thread], persistenceFailures: [] }
      });
      await expect(
        client.request({
          method: "thread/read",
          params: { threadId: start.result.thread.id }
        })
      ).resolves.toEqual({
        method: "thread/read",
        ok: true,
        result: { thread: start.result.thread }
      });
    } finally {
      await transport.close();
    }
  });

  it("streams running turn notifications in item sequence order", async () => {
    const notifications: AppServerNotification[] = [];
    const server = createServer({
      model: {
        async *generate() {
          yield { type: "text.delta", text: "Hel" };
          yield { type: "text.delta", text: "lo" };
          yield { type: "message.completed", content: "Hello" };
        }
      }
    });
    const transport = await serveAppServerHttpTransport({ appServer: server });
    const client = new HttpAppServerClient({
      baseUrl: transport.url,
      capability: transport.capability
    });
    const unsubscribe = client.subscribe((notification) => {
      notifications.push(notification);
    });

    try {
      const start = await client.request({ method: "thread/start" });

      if (!start.ok || start.method !== "thread/start") {
        throw new Error("thread/start failed");
      }

      await client.request({
        method: "turn/start",
        params: {
          threadId: start.result.thread.id,
          input: "Hello"
        }
      });
      await waitForNotification(
        notifications,
        (notification) => notification.type === "turn/completed"
      );

      expect(notifications.map((notification) => notification.type)).toEqual([
        "thread/started",
        "item/appended",
        "item/appended",
        "item/appended",
        "turn/started",
        "item/appended",
        "item/appended",
        "item/appended",
        "item/appended",
        "item/appended",
        "item/appended",
        "item/appended",
        "item/appended",
        "item/appended",
        "turn/completed"
      ]);
      expect(
        notifications
          .filter((notification) => notification.type === "item/appended")
          .map((notification) => notification.item.seq)
      ).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    } finally {
      unsubscribe();
      await transport.close();
    }
  });

  it("interrupts a running turn through transport", async () => {
    const notifications: AppServerNotification[] = [];
    const toolAborted = createDeferred<void>();
    const server = createServer({
      model: {
        async *generate() {
          yield {
            type: "message.completed",
            content: "Calling long tool",
            toolCalls: [{ id: "call-1", name: "fake-tool", input: {} }]
          };
        }
      },
      toolRuntime: {
        async *execute(_call, context) {
          if (!context.signal) {
            throw new Error("missing abort signal");
          }

          context.signal.addEventListener("abort", () => toolAborted.resolve(), {
            once: true
          });
          yield { type: "output.delta", delta: "started" };
          await toolAborted.promise;
          yield { type: "error", error: new Error("fake tool canceled") };
        }
      }
    });
    const transport = await serveAppServerHttpTransport({ appServer: server });
    const client = new HttpAppServerClient({
      baseUrl: transport.url,
      capability: transport.capability
    });
    const unsubscribe = client.subscribe((notification) => {
      notifications.push(notification);
    });

    try {
      const start = await client.request({ method: "thread/start" });

      if (!start.ok || start.method !== "thread/start") {
        throw new Error("thread/start failed");
      }

      await client.request({
        method: "turn/start",
        params: {
          threadId: start.result.thread.id,
          input: "Use the tool"
        }
      });
      await waitForNotification(
        notifications,
        (notification) =>
          notification.type === "item/appended" &&
          notification.item.type === "tool.output.delta"
      );

      const interrupt = await client.request({
        method: "turn/interrupt",
        params: { threadId: start.result.thread.id }
      });

      expect(interrupt).toEqual({
        method: "turn/interrupt",
        ok: true,
        result: {
          turn: expect.objectContaining({ status: "inProgress" })
        }
      });
      await toolAborted.promise;
      await waitForNotification(
        notifications,
        (notification) => notification.type === "turn/completed"
      );

      const read = await client.request({
        method: "thread/read",
        params: { threadId: start.result.thread.id }
      });

      if (!read.ok || read.method !== "thread/read") {
        throw new Error("thread/read failed");
      }

      expect(read.result.thread.status).toBe("idle");
      expect(read.result.thread.turns.at(-1)).toEqual(
        expect.objectContaining({ status: "canceled" })
      );
      expect(read.result.thread.items.map((item) => item.type)).not.toContain(
        "tool.error"
      );
    } finally {
      unsubscribe();
      await transport.close();
    }
  });

  it("lets an AppServerClient consumer resume a listed thread through transport", async () => {
    const server = createServer();
    const transport = await serveAppServerHttpTransport({ appServer: server });
    const client = new HttpAppServerClient({
      baseUrl: transport.url,
      capability: transport.capability
    });
    const session = new AgentInteractionSession({ client });

    try {
      const start = await client.request({ method: "thread/start" });

      if (!start.ok || start.method !== "thread/start") {
        throw new Error("thread/start failed");
      }

      const threads = await session.listThreads();
      const resumed = await session.resumeThread(threads[0]?.id ?? "");

      expect(threads).toEqual([
        {
          id: start.result.thread.id,
          status: "idle",
          turns: 0,
          items: 0
        }
      ]);
      expect({ ...resumed.thread, items: [...(resumed.thread?.items ?? [])] }).toEqual(start.result.thread);
    } finally {
      session.dispose();
      await transport.close();
    }
  });

  it("returns explicit transport errors for malformed HTTP requests", async () => {
    const server = createServer();
    const transport = await serveAppServerHttpTransport({ appServer: server });

    try {
      const response = await fetch(new URL("/request", transport.url), {
        method: "POST",
        headers: {
          authorization: `Bearer ${transport.capability}`,
          "content-type": "application/json"
        },
        body: "{"
      });
      const body = (await response.json()) as AppServerResponse;

      expect(response.status).toBe(400);
      expect(body).toEqual({
        method: "transport/request",
        ok: false,
        error: {
          code: "INVALID_JSON",
          message: "App Server transport request body must be valid JSON"
        }
      });
    } finally {
      await transport.close();
    }
  });

  it("does not authorize cross-origin browser requests or emit CORS headers", async () => {
    const server = createServer();
    const transport = await serveAppServerHttpTransport({ appServer: server });

    try {
      const preflight = await fetch(new URL("/request", transport.url), {
        method: "OPTIONS",
        headers: {
          origin: "http://127.0.0.1:8080",
          "access-control-request-method": "POST",
          "access-control-request-headers": "content-type"
        }
      });

      expect(preflight.status).toBe(401);
      expect(preflight.headers.get("access-control-allow-origin")).toBeNull();
      expect(preflight.headers.get("access-control-allow-methods")).toBeNull();

      const response = await fetch(new URL("/request", transport.url), {
        method: "POST",
        headers: {
          origin: "http://127.0.0.1:8080",
          "content-type": "application/json"
        },
        body: JSON.stringify({ method: "thread/start" })
      });

      expect(response.status).toBe(401);
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
      await expect(response.json()).resolves.toEqual(
        expect.objectContaining({
          method: "transport/request",
          ok: false,
          error: expect.objectContaining({ code: "UNAUTHORIZED" })
        })
      );
    } finally {
      await transport.close();
    }
  });

  it("requires explicit opt-in before binding beyond loopback", async () => {
    const server = createServer();
    let unexpectedTransport:
      | Awaited<ReturnType<typeof serveAppServerHttpTransport>>
      | undefined;
    let rejection: unknown;

    try {
      unexpectedTransport = await serveAppServerHttpTransport({
        appServer: server,
        host: "0.0.0.0"
      });
    } catch (cause) {
      rejection = cause;
    } finally {
      await unexpectedTransport?.close();
    }

    expect(rejection).toEqual(
      new Error("Non-loopback App Server binding requires explicit opt-in")
    );

    const optedIn = await serveAppServerHttpTransport({
      appServer: server,
      host: "0.0.0.0",
      allowRemoteBind: true
    });

    try {
      expect(new URL(optedIn.url).hostname).toBe("0.0.0.0");
    } finally {
      await optedIn.close();
    }
  });

  it("redacts the capability from protocol error bodies", async () => {
    const appServer = {
      async request() {
        throw new Error(`upstream failure included ${TEST_CAPABILITY}`);
      },
      subscribe() {
        return () => undefined;
      }
    } satisfies AppServerClient;
    const transport = await serveAppServerHttpTransport({
      appServer,
      capability: TEST_CAPABILITY
    });

    try {
      const response = await fetch(new URL("/request", transport.url), {
        method: "POST",
        headers: {
          authorization: `Bearer ${TEST_CAPABILITY}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({ method: "thread/list" })
      });
      const body = await response.text();

      expect(response.status).toBe(500);
      expect(body).not.toContain(TEST_CAPABILITY);
      expect(JSON.parse(body)).toEqual({
        method: "transport/request",
        ok: false,
        error: {
          code: "UPSTREAM_REQUEST_FAILED",
          message: "App Server request failed"
        }
      });
    } finally {
      await transport.close();
    }
  });

  it("rejects non-protocol client responses with an explicit transport error", async () => {
    const server = await listenWithPlainTextResponse();
    const client = new HttpAppServerClient({
      baseUrl: server.url,
      capability: TEST_CAPABILITY
    });

    try {
      await expect(client.request({ method: "thread/list" })).rejects.toMatchObject({
        name: "AppServerTransportError",
        code: "INVALID_RESPONSE_JSON"
      });
    } finally {
      await server.close();
    }
  });
});

function createServer(
  options: {
    readonly model?: ModelGateway;
    readonly toolRuntime?: ToolRuntime;
  } = {}
): AppServer {
  return new AppServer({
    threadManagerOptions: {
      generateThreadId: sequence("thread"),
      generateRunId: sequence("run"),
      generateTurnId: sequence("turn"),
      generateItemId: sequence("item"),
      clock: () => 1000,
      runtimeFactory: () => ({
        model:
          options.model ??
          ({
            async *generate() {
              yield { type: "message.completed", content: "default response" };
            }
          } satisfies ModelGateway),
        toolRuntime: options.toolRuntime
      })
    }
  });
}

function sequence(prefix: string): () => string {
  let nextId = 0;

  return () => `${prefix}-${++nextId}`;
}

async function waitForNotification(
  notifications: readonly AppServerNotification[],
  predicate: (notification: AppServerNotification) => boolean
): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (notifications.some(predicate)) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  throw new Error("Timed out waiting for notification");
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (cause?: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });

  return { promise, resolve, reject };
}

async function listenWithPlainTextResponse(): Promise<{
  readonly url: string;
  close(): Promise<void>;
}> {
  const { createServer } = await import("node:http");
  const httpServer = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("not json");
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(0, "127.0.0.1", () => {
      httpServer.off("error", reject);
      resolve();
    });
  });

  const address = httpServer.address();

  if (!address || typeof address === "string") {
    throw new Error("plain text test server did not bind to a TCP port");
  }

  return {
    url: `http://${address.address}:${address.port}`,
    async close() {
      await new Promise<void>((resolve, reject) => {
        httpServer.close((cause) => {
          if (cause) {
            reject(cause);
            return;
          }

          resolve();
        });
      });
    }
  };
}
