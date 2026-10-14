import WebSocket from "ws";

export function traceOwnedCdpTransport(
  browserSocketUrl: string,
  record: (value: Record<string, unknown>) => void,
  now: () => number = () => performance.now(),
  fixtureSocketUrls: ReadonlySet<string> = new Set(),
): () => void {
  const originalSend = WebSocket.prototype.send;
  const methods = new Set([
    "Target.getTargets",
    "Target.createTarget",
    "Target.attachToTarget",
    "Target.detachFromTarget",
    "Target.detachedFromTarget",
    "Target.attachedToTarget",
    "Inspector.targetCrashed",
    "Target.targetDestroyed",
    "Target.setDiscoverTargets",
    "Page.enable",
    "Page.getFrameTree",
    "Page.createIsolatedWorld",
    "Page.captureScreenshot",
    "Page.frameNavigated",
    "Page.navigatedWithinDocument",
    "Page.frameStoppedLoading",
    "Runtime.enable",
    "Runtime.evaluate",
    "Runtime.releaseObject",
    "Runtime.executionContextCreated",
    "Runtime.executionContextDestroyed",
    "Runtime.executionContextsCleared",
    "DOM.describeNode",
    "DOM.resolveNode",
    "Input.dispatchMouseEvent",
    "Input.dispatchKeyEvent",
  ]);
  let active = true;
  const aliases = new Map<string, number>();
  const alias = (value: unknown): number | undefined => {
    if (typeof value !== "string") return undefined;
    const known = aliases.get(value);
    if (known !== undefined) return known;
    if (aliases.size >= 128) return undefined;
    const token = aliases.size + 1;
    aliases.set(value, token);
    return token;
  };
  const sockets = new Map<
    WebSocket,
    {
      message(raw: unknown): void;
      close(code: number): void;
      error(): void;
      pending: Map<
        number,
        { method: string; at: number; route?: number; routeKey?: string }
      >;
      number: number;
    }
  >();
  const emit = (value: Record<string, unknown>) => {
    try {
      if (active) record(value);
    } catch {
      /* Diagnostics never affect transport. */
    }
  };
  const send = function (this: WebSocket, ...args: unknown[]) {
    try {
      if (
        active &&
        (this.url === browserSocketUrl || fixtureSocketUrls.has(this.url)) &&
        typeof args[0] === "string"
      ) {
        let observed = sockets.get(this);
        if (!observed && sockets.size < 4) {
          const number = sockets.size + 1;
          const pending = new Map<
            number,
            { method: string; at: number; route?: number; routeKey?: string }
          >();
          observed = {
            number,
            pending,
            message: (raw) => {
              try {
                const message = JSON.parse(String(raw)) as {
                  id?: number;
                  method?: string;
                  sessionId?: string;
                  error?: { code?: unknown };
                  params?: {
                    sessionId?: string;
                    targetId?: string;
                    waitingForDebugger?: boolean;
                    targetInfo?: { targetId?: string };
                  };
                };
                if (Number.isSafeInteger(message.id)) {
                  const sent = pending.get(message.id!);
                  if (sent) {
                    const route = alias(message.sessionId);
                    const routeMatches = message.sessionId === sent.routeKey;
                    if (routeMatches) pending.delete(message.id!);
                    emit({
                      kind: "reply",
                      socket: number,
                      id: message.id,
                      method: sent.method,
                      elapsedMs: now() - sent.at,
                      originalRequest: true,
                      requestRoute: sent.route,
                      responseRoute: route,
                      routeMatches,
                      outcome: message.error ? "protocol-error" : "success",
                      ...(typeof message.error?.code === "number"
                        ? { errorCode: message.error.code }
                        : {}),
                    });
                  }
                } else if (message.method && methods.has(message.method)) {
                  emit({
                    kind: "event",
                    socket: number,
                    method: message.method,
                    route: alias(message.sessionId),
                    affectedRoute: alias(message.params?.sessionId),
                    target: alias(
                      message.params?.targetId ??
                        message.params?.targetInfo?.targetId,
                    ),
                    ...(typeof message.params?.waitingForDebugger === "boolean"
                      ? {
                          waitingForDebugger: message.params.waitingForDebugger,
                        }
                      : {}),
                  });
                }
              } catch {
                /* Malformed or late diagnostics cannot alter a reply. */
              }
            },
            close: (code) => emit({ kind: "close", socket: number, code }),
            error: () => emit({ kind: "error", socket: number }),
          };
          sockets.set(this, observed);
          this.on("message", observed.message);
          this.on("close", observed.close);
          this.on("error", observed.error);
        }
        const message = JSON.parse(args[0]) as {
          id?: number;
          method?: string;
          sessionId?: string;
        };
        if (
          observed &&
          Number.isSafeInteger(message.id) &&
          typeof message.method === "string"
        ) {
          const method = methods.has(message.method) ? message.method : "other";
          if (observed.pending.size >= 64)
            observed.pending.delete(observed.pending.keys().next().value!);
          const route = alias(message.sessionId);
          observed.pending.set(message.id!, {
            method,
            at: now(),
            route,
            routeKey: message.sessionId,
          });
          emit({
            kind: "send",
            socket: observed.number,
            endpoint: this.url === browserSocketUrl ? "browser" : "fixture",
            id: message.id,
            method,
            route,
          });
        }
      }
    } catch {
      /* The original send must run even if diagnostics fail. */
    }
    return Reflect.apply(originalSend, this, args);
  };
  WebSocket.prototype.send = send;
  return () => {
    active = false;
    if (WebSocket.prototype.send === send)
      WebSocket.prototype.send = originalSend;
    for (const [socket, observed] of sockets) {
      socket.removeListener("message", observed.message);
      socket.removeListener("close", observed.close);
      socket.removeListener("error", observed.error);
      observed.pending.clear();
    }
    sockets.clear();
    aliases.clear();
  };
}

/** Preserve startup and the final tail; omitted middle events stay explicit. */
export function boundedCdpRecords(limit = 2048) {
  if (!Number.isSafeInteger(limit) || limit < 1)
    throw new Error("Invalid diagnostic limit");
  const first: unknown[] = [];
  const tail: unknown[] = [];
  let next = 0;
  let dropped = 0;
  return {
    push(value: unknown) {
      if (first.length < limit) first.push(value);
      else if (tail.length < limit) tail.push(value);
      else {
        tail[next] = value;
        next = (next + 1) % limit;
        dropped++;
      }
    },
    snapshot() {
      return {
        records: [...first, ...tail.slice(next), ...tail.slice(0, next)],
        dropped,
      };
    },
  };
}
