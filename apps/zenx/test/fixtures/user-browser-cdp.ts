import assert from "node:assert/strict";
import { createServer } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";

export function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

export async function nextTurn(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

export async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("test condition timed out");
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

export async function listen(
  server: ReturnType<typeof createServer>,
): Promise<number> {
  return await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      const address = server.address();
      if (address === null || typeof address === "string")
        reject(new Error("test server did not bind"));
      else resolve(address.port);
    });
  });
}

export async function close(
  server: ReturnType<typeof createServer>,
): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error === undefined ? resolve() : reject(error))),
  );
}

export async function createFakeCdpServer(): Promise<{
  endpoint: string;
  count(method: string): number;
  methods(): string[];
  requests(method: string): Record<string, unknown>[];
  invalidateActionAt(
    phase: "evaluate" | "confirmation",
    event?: { method: string; params: Record<string, unknown> },
  ): void;
  invalidateSetupAt(
    phase:
      | "before-frame-tree-response"
      | "after-frame-tree"
      | "after-isolated-world"
      | "before-post-isolated-world-barrier-response",
    event?: { method: string; params: Record<string, unknown> },
  ): void;
  loseNextCreateReply(): void;
  dropNextCreateReply(): void;
  dropNextAttachReply(): void;
  failNextAttachReply(): void;
  holdNextAttachReply(): void;
  releaseLateAttachReply(): void;
  holdNextAttachErrorReply(): void;
  releaseLateAttachErrorReply(): void;
  holdNextActionReply(): void;
  heldActionStarted(): Promise<void>;
  releaseLateActionReply(): void;
  actionResponseSent(): boolean;
  holdNextConfirmationReply(): void;
  heldConfirmationStarted(): Promise<void>;
  releaseLateConfirmationReply(): void;
  confirmationResponseSent(): boolean;
  dropNextEnableReply(): void;
  failNextEnableReply(): void;
  dropNextRuntimeEnableReply(): void;
  failNextRuntimeEnableReply(): void;
  dropNextDetachReply(): void;
  dropDetachReplies(count: number): void;
  detachSession(): void;
  emitDetached(sessionId: string, targetId?: string): void;
  latestSessionId(): string;
  detachedSessionIds(): string[];
  detachInspector(): void;
  invalidateNextAttachment(): void;
  destroyTarget(targetId: string): void;
  removeTarget(targetId: string): void;
  addTargets(count: number): void;
  disconnect(): void;
  emitScreencastFrame(value: string, frameNumber: number): void;
  emitRawScreencastFrame(data: string, frameNumber: number): void;
  emitMainDocumentChange(): void;
  close(): Promise<void>;
}> {
  const sockets = new Set<WebSocket>();
  const methods: string[] = [];
  const requests: Array<{ method: string; params: Record<string, unknown> }> =
    [];
  const targets = new Map([["target-1", "https://example.test/account"]]);
  const sessionContexts = new Map<string, number>();
  const sessionTargets = new Map<string, string>();
  const runtimeEnabledSessions = new Set<string>();
  const detachedSessionIds: string[] = [];
  let nextSession = 1;
  let latestSession = "";
  let nextContext = 100;
  let endpoint = "";
  let invalidateNextAttachment = false;
  let actionInvalidation:
    | {
        phase: "evaluate" | "confirmation";
        event: { method: string; params: Record<string, unknown> };
      }
    | undefined;
  let setupInvalidation:
    | {
        phase:
          | "before-frame-tree-response"
          | "after-frame-tree"
          | "after-isolated-world"
          | "before-post-isolated-world-barrier-response";
        event: { method: string; params: Record<string, unknown> };
      }
    | undefined;
  let postIsolatedWorldInvalidation:
    | {
        sessionId: string | undefined;
        event: { method: string; params: Record<string, unknown> };
      }
    | undefined;
  let loseCreateReply = false;
  let dropCreateReply = false;
  let dropAttachReply = false;
  let failAttachReply = false;
  let holdAttachReply = false;
  let holdAttachErrorReply = false;
  let holdActionReply = false;
  let actionResponseSent = false;
  const heldActionStarted = deferred<void>();
  let holdConfirmationReply = false;
  let confirmationResponseSent = false;
  const heldConfirmationStarted = deferred<void>();
  let dropEnableReply = false;
  let failEnableReply = false;
  let dropRuntimeEnableReply = false;
  let failRuntimeEnableReply = false;
  let dropDetachReplyCount = 0;
  let lateAttachReply:
    | {
        socket: WebSocket;
        id: number;
        response:
          { result: { sessionId: string } } | { error: { message: string } };
      }
    | undefined;
  let lateActionReply:
    { socket: WebSocket; id: number; result: unknown } | undefined;
  let lateConfirmationReply:
    { socket: WebSocket; id: number; result: unknown } | undefined;
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/json/list") {
      response.end(
        JSON.stringify(
          [...targets].map(([id, url]) => ({
            id,
            type: "page",
            title: "",
            url,
          })),
        ),
      );
      return;
    }
    response.end(
      JSON.stringify({
        Browser: "Chrome/140.0.1.2",
        webSocketDebuggerUrl:
          endpoint.replace("http:", "ws:") + "/devtools/browser/id",
      }),
    );
  });
  const webSockets = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    webSockets.handleUpgrade(request, socket, head, (webSocket) => {
      webSockets.emit("connection", webSocket, request);
    });
  });
  webSockets.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("message", (raw) => {
      const request = JSON.parse(raw.toString()) as {
        id: number;
        method: string;
        params: Record<string, unknown>;
        sessionId?: string;
      };
      methods.push(request.method);
      requests.push({ method: request.method, params: request.params });
      let result: unknown = {};
      if (request.method === "Target.getTargets") {
        result = {
          targetInfos: [...targets].map(([targetId, url]) => ({
            targetId,
            type: "page",
            title: targetId === "target-1" ? "Account" : "",
            url,
          })),
        };
      } else if (request.method === "Target.createTarget") {
        const targetId = `target-${String(targets.size + 1)}`;
        targets.set(targetId, String(request.params.url ?? "about:blank"));
        if (loseCreateReply) {
          loseCreateReply = false;
          socket.terminate();
          return;
        }
        if (dropCreateReply) {
          dropCreateReply = false;
          return;
        }
        result = { targetId };
      } else if (request.method === "Target.attachToTarget") {
        if (holdAttachErrorReply) {
          holdAttachErrorReply = false;
          lateAttachReply = {
            socket,
            id: request.id,
            response: { error: { message: "known late attach failure" } },
          };
          return;
        }
        if (failAttachReply) {
          failAttachReply = false;
          socket.send(
            JSON.stringify({
              id: request.id,
              error: { message: "known attach failure" },
            }),
          );
          return;
        }
        latestSession = `session-${String(nextSession++)}`;
        sessionTargets.set(
          latestSession,
          String(request.params.targetId ?? "target-1"),
        );
        if (invalidateNextAttachment) {
          invalidateNextAttachment = false;
          socket.send(
            JSON.stringify({
              method: "Target.detachedFromTarget",
              params: { sessionId: latestSession, targetId: "target-1" },
            }),
          );
        }
        result = { sessionId: latestSession };
        if (dropAttachReply) {
          dropAttachReply = false;
          return;
        }
        if (holdAttachReply) {
          holdAttachReply = false;
          lateAttachReply = {
            socket,
            id: request.id,
            response: { result: { sessionId: latestSession } },
          };
          return;
        }
      } else if (request.method === "Page.enable") {
        if (failEnableReply) {
          failEnableReply = false;
          socket.send(
            JSON.stringify({
              id: request.id,
              error: { message: "known enable failure" },
            }),
          );
          return;
        }
        if (dropEnableReply) {
          dropEnableReply = false;
          return;
        }
      } else if (request.method === "Runtime.enable") {
        if (failRuntimeEnableReply) {
          failRuntimeEnableReply = false;
          socket.send(
            JSON.stringify({
              id: request.id,
              error: { message: "known Runtime.enable failure" },
            }),
          );
          return;
        }
        if (dropRuntimeEnableReply) {
          dropRuntimeEnableReply = false;
          return;
        }
        runtimeEnabledSessions.add(request.sessionId ?? "");
      } else if (request.method === "Page.getFrameTree") {
        result = {
          frameTree: {
            frame: {
              id: "main",
              loaderId: "loader",
              url: "https://example.test/account",
            },
          },
        };
        const postBarrierInvalidation = postIsolatedWorldInvalidation;
        if (
          postBarrierInvalidation !== undefined &&
          postBarrierInvalidation.sessionId === request.sessionId
        ) {
          postIsolatedWorldInvalidation = undefined;
          emitSetupInvalidation(
            socket,
            request.sessionId,
            postBarrierInvalidation.event,
            runtimeEnabledSessions,
          );
          socket.send(JSON.stringify({ id: request.id, result }));
          return;
        }
        if (setupInvalidation?.phase === "before-frame-tree-response") {
          const invalidation = setupInvalidation;
          setupInvalidation = undefined;
          emitSetupInvalidation(
            socket,
            request.sessionId,
            invalidation.event,
            runtimeEnabledSessions,
          );
        }
        if (setupInvalidation?.phase === "after-frame-tree") {
          const invalidation = setupInvalidation;
          setupInvalidation = undefined;
          socket.send(JSON.stringify({ id: request.id, result }));
          emitSetupInvalidation(
            socket,
            request.sessionId,
            invalidation.event,
            runtimeEnabledSessions,
          );
          return;
        }
      } else if (request.method === "Page.createIsolatedWorld") {
        const sessionId = request.sessionId ?? "";
        let context = sessionContexts.get(sessionId);
        if (context === undefined) {
          context = nextContext++;
          sessionContexts.set(sessionId, context);
        }
        result = { executionContextId: context };
        if (
          setupInvalidation?.phase ===
          "before-post-isolated-world-barrier-response"
        ) {
          const invalidation = setupInvalidation;
          setupInvalidation = undefined;
          postIsolatedWorldInvalidation = {
            sessionId: request.sessionId,
            event: invalidation.event,
          };
        }
        if (setupInvalidation?.phase === "after-isolated-world") {
          const invalidation = setupInvalidation;
          setupInvalidation = undefined;
          socket.send(JSON.stringify({ id: request.id, result }));
          emitSetupInvalidation(
            socket,
            request.sessionId,
            invalidation.event,
            runtimeEnabledSessions,
          );
          return;
        }
      } else if (request.method === "Runtime.evaluate") {
        const expression = String(request.params.expression ?? "");
        const isAction = expression.includes("const expected =");
        const isConfirmation = expression === "void 0";
        if (
          (actionInvalidation?.phase === "evaluate" && isAction) ||
          (actionInvalidation?.phase === "confirmation" && isConfirmation)
        ) {
          const invalidation = actionInvalidation;
          actionInvalidation = undefined;
          if (
            !invalidation.event.method.startsWith("Runtime.") ||
            runtimeEnabledSessions.has(request.sessionId ?? "")
          ) {
            socket.send(
              JSON.stringify({
                method: invalidation.event.method,
                sessionId: request.sessionId,
                params: invalidation.event.params,
              }),
            );
          }
        }
        result = {
          result: {
            value: expression.includes("const expected =")
              ? { ok: true }
              : {
                  visibleText: "Signed in as Alice",
                  targets: [
                    {
                      selector: "#continue",
                      tag: "input",
                      role: "input",
                      name: "Continue",
                      type: "text",
                      id: "continue",
                      fieldName: "",
                      autocomplete: "",
                      href: "",
                      actions: ["click", "type"],
                    },
                  ],
                },
          },
        };
        if (isAction && holdActionReply) {
          holdActionReply = false;
          lateActionReply = { socket, id: request.id, result };
          heldActionStarted.resolve();
          return;
        }
        if (isConfirmation && holdConfirmationReply) {
          holdConfirmationReply = false;
          lateConfirmationReply = { socket, id: request.id, result };
          heldConfirmationStarted.resolve();
          return;
        }
      } else if (request.method === "Page.navigate") {
        const targetId = sessionTargets.get(request.sessionId ?? "");
        assert.ok(targetId);
        targets.set(targetId, String(request.params.url ?? "about:blank"));
      } else if (
        request.method === "Target.detachFromTarget" &&
        dropDetachReplyCount > 0
      ) {
        dropDetachReplyCount -= 1;
        return;
      } else if (request.method === "Target.detachFromTarget") {
        const sessionId = String(request.params.sessionId ?? "");
        detachedSessionIds.push(sessionId);
        sessionTargets.delete(sessionId);
      }
      socket.send(JSON.stringify({ id: request.id, result }));
    });
  });
  const port = await listen(server);
  endpoint = `http://127.0.0.1:${String(port)}`;
  return {
    endpoint,
    count: (method) =>
      methods.filter((candidate) => candidate === method).length,
    methods: () => [...methods],
    requests: (method) =>
      requests
        .filter((candidate) => candidate.method === method)
        .map((candidate) => candidate.params),
    invalidateActionAt: (phase, event) => {
      actionInvalidation = {
        phase,
        event: event ?? {
          method: "Page.frameStartedNavigating",
          params: {
            frameId: "main",
            url: "https://example.test/next",
            navigationType: "reload",
          },
        },
      };
    },
    invalidateSetupAt: (phase, event) => {
      setupInvalidation = {
        phase,
        event: event ?? {
          method: "Page.frameStartedNavigating",
          params: {
            frameId: "main",
            url: "https://example.test/next",
            navigationType: "reload",
          },
        },
      };
    },
    loseNextCreateReply: () => {
      loseCreateReply = true;
    },
    dropNextCreateReply: () => {
      dropCreateReply = true;
    },
    dropNextAttachReply: () => {
      dropAttachReply = true;
    },
    failNextAttachReply: () => {
      failAttachReply = true;
    },
    holdNextAttachReply: () => {
      holdAttachReply = true;
    },
    releaseLateAttachReply: () => {
      const late = lateAttachReply;
      lateAttachReply = undefined;
      if (late !== undefined && late.socket.readyState === late.socket.OPEN) {
        late.socket.send(JSON.stringify({ id: late.id, ...late.response }));
      }
    },
    holdNextAttachErrorReply: () => {
      holdAttachErrorReply = true;
    },
    releaseLateAttachErrorReply: () => {
      const late = lateAttachReply;
      lateAttachReply = undefined;
      if (late !== undefined && late.socket.readyState === late.socket.OPEN) {
        late.socket.send(JSON.stringify({ id: late.id, ...late.response }));
      }
    },
    holdNextActionReply: () => {
      holdActionReply = true;
    },
    heldActionStarted: async () => await heldActionStarted.promise,
    releaseLateActionReply: () => {
      const late = lateActionReply;
      lateActionReply = undefined;
      actionResponseSent = true;
      if (late !== undefined && late.socket.readyState === late.socket.OPEN) {
        late.socket.send(JSON.stringify({ id: late.id, result: late.result }));
      }
    },
    actionResponseSent: () => actionResponseSent,
    holdNextConfirmationReply: () => {
      holdConfirmationReply = true;
    },
    heldConfirmationStarted: async () => await heldConfirmationStarted.promise,
    releaseLateConfirmationReply: () => {
      const late = lateConfirmationReply;
      lateConfirmationReply = undefined;
      confirmationResponseSent = true;
      if (late !== undefined && late.socket.readyState === late.socket.OPEN) {
        late.socket.send(JSON.stringify({ id: late.id, result: late.result }));
      }
    },
    confirmationResponseSent: () => confirmationResponseSent,
    dropNextEnableReply: () => {
      dropEnableReply = true;
    },
    failNextEnableReply: () => {
      failEnableReply = true;
    },
    dropNextRuntimeEnableReply: () => {
      dropRuntimeEnableReply = true;
    },
    failNextRuntimeEnableReply: () => {
      failRuntimeEnableReply = true;
    },
    dropNextDetachReply: () => {
      dropDetachReplyCount += 1;
    },
    dropDetachReplies: (count) => {
      dropDetachReplyCount += count;
    },
    detachSession: () => {
      for (const socket of sockets) {
        socket.send(
          JSON.stringify({
            method: "Target.detachedFromTarget",
            params: { sessionId: latestSession, targetId: "target-1" },
          }),
        );
      }
    },
    emitDetached: (sessionId, targetId) => {
      for (const socket of sockets) {
        socket.send(
          JSON.stringify({
            method: "Target.detachedFromTarget",
            params: {
              sessionId,
              ...(targetId === undefined ? {} : { targetId }),
            },
          }),
        );
      }
    },
    latestSessionId: () => latestSession,
    detachedSessionIds: () => [...detachedSessionIds],
    detachInspector: () => {
      for (const socket of sockets) {
        socket.send(
          JSON.stringify({
            method: "Inspector.detached",
            sessionId: latestSession,
            params: { reason: "target_closed" },
          }),
        );
      }
    },
    invalidateNextAttachment: () => {
      invalidateNextAttachment = true;
    },
    destroyTarget: (targetId) => {
      for (const socket of sockets) {
        socket.send(
          JSON.stringify({
            method: "Target.targetDestroyed",
            params: { targetId },
          }),
        );
      }
    },
    removeTarget: (targetId) => {
      targets.delete(targetId);
    },
    addTargets: (count) => {
      for (let index = targets.size; index < count; index += 1) {
        targets.set(
          `stress-${String(index)}`,
          `https://example.test/stress/${String(index)}`,
        );
      }
    },
    disconnect: () => {
      for (const socket of sockets) socket.terminate();
    },
    emitScreencastFrame: (value, frameNumber) => {
      for (const socket of sockets) {
        socket.send(
          JSON.stringify({
            method: "Page.screencastFrame",
            sessionId: latestSession,
            params: {
              data: Buffer.from(value).toString("base64"),
              metadata: {
                deviceWidth: 1280,
                deviceHeight: 720,
                timestamp: frameNumber,
              },
              sessionId: frameNumber,
            },
          }),
        );
      }
    },
    emitRawScreencastFrame: (data, frameNumber) => {
      for (const socket of sockets) {
        socket.send(
          JSON.stringify({
            method: "Page.screencastFrame",
            sessionId: latestSession,
            params: {
              data,
              metadata: {
                deviceWidth: 1280,
                deviceHeight: 720,
                timestamp: frameNumber,
              },
              sessionId: frameNumber,
            },
          }),
        );
      }
    },
    emitMainDocumentChange: () => {
      for (const socket of sockets) {
        socket.send(
          JSON.stringify({
            method: "Page.frameStartedNavigating",
            sessionId: latestSession,
            params: {
              frameId: "main",
              url: "https://example.test/next",
              navigationType: "differentDocument",
            },
          }),
        );
      }
    },
    close: async () => {
      for (const socket of sockets) socket.terminate();
      await new Promise<void>((resolve) => webSockets.close(() => resolve()));
      await close(server);
    },
  };
}

function emitSetupInvalidation(
  socket: WebSocket,
  sessionId: string | undefined,
  event: { method: string; params: Record<string, unknown> },
  runtimeEnabledSessions: ReadonlySet<string>,
): void {
  if (event.method === "__disconnect") {
    socket.terminate();
    return;
  }
  if (event.method === "Target.detachedFromTarget") {
    socket.send(
      JSON.stringify({
        method: event.method,
        params: { ...event.params, sessionId },
      }),
    );
    return;
  }
  if (
    event.method.startsWith("Runtime.") &&
    !runtimeEnabledSessions.has(sessionId ?? "")
  ) {
    return;
  }
  socket.send(JSON.stringify({ ...event, sessionId }));
}
