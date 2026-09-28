import { randomBytes } from "node:crypto";
import { createServer, type Server as HttpsServer } from "node:https";
import type { IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import {
  RemoteHostAccess,
  RemoteHostError,
  projectRemoteRecoveryPage,
  type RemoteEventView,
  type RemoteRecoveryBoundary,
  type RemoteRecoveryPosition,
} from "./remote-host.js";
import type { RemoteRecoveryPage } from "./remote-wire.js";

export interface RemoteTransportOptions {
  /** Explicit administrator opt-in; no implicit listener or fallback to plaintext. */
  enabled: true;
  listen: string;
  port: number;
  tls: { cert: Buffer | string; key: Buffer | string };
  access: RemoteHostAccess;
}
export interface RemoteHostTransport {
  url: string;
  close(): Promise<void>;
}

// Explicit admission bounds for this one isolated Host; the absolute deadlines
// cover trickle traffic, not just Node's inactivity/request defaults.
export const REMOTE_MAX_CONNECTIONS = 64;
export const REMOTE_MAX_UNAUTHENTICATED = 16;
export const REMOTE_MAX_CLIENTS = 32;
export const REMOTE_HANDSHAKE_MS = 5_000;
export const REMOTE_UNAUTHENTICATED_MS = 10_000;
export const REMOTE_PAIR_BODY_MS = 5_000;
const REMOTE_PENDING_EVENTS_BYTES = 512 * 1024;
const REMOTE_MAX_OUTBOUND_BUFFER = 2 * 1024 * 1024;

export async function serveRemoteHost(
  options: RemoteTransportOptions,
): Promise<RemoteHostTransport> {
  if (
    options.enabled !== true ||
    !options.tls.cert ||
    !options.tls.key ||
    !options.listen ||
    !Number.isInteger(options.port) ||
    options.port < 0 ||
    options.port > 65535
  )
    throw new Error(
      "Remote Host requires explicit enabled flag, TLS identity and listen address",
    );
  let closing = false;
  let pendingPairBodies = 0;
  const rawSockets = new Set<Duplex>();
  const unauthenticated = new Map<Duplex, ReturnType<typeof setTimeout>>();
  const server: HttpsServer = createServer(
    {
      cert: options.tls.cert,
      key: options.tls.key,
      minVersion: "TLSv1.2",
      handshakeTimeout: REMOTE_HANDSHAKE_MS,
    },
    (request, response) => {
      if (closing || pendingPairBodies >= REMOTE_MAX_UNAUTHENTICATED) {
        response.writeHead(503, { Connection: "close" });
        response.end("{}");
        return;
      }
      response.setHeader("cache-control", "no-store");
      response.setHeader("content-type", "application/json");
      if (request.url !== "/pair" || request.method !== "POST") {
        response.writeHead(404);
        response.end("{}");
        return;
      }
      if (
        request.headers.origin !== undefined ||
        request.headers["content-type"] !== "application/json"
      ) {
        response.writeHead(403);
        response.end("{}");
        return;
      }
      let payload = "";
      pendingPairBodies += 1;
      let released = false;
      const deadline = setTimeout(
        () => request.socket.destroy(),
        REMOTE_PAIR_BODY_MS,
      );
      const release = () => {
        if (released) return;
        released = true;
        pendingPairBodies -= 1;
        clearTimeout(deadline);
      };
      response.once("close", release);
      request.on("data", (part: Buffer) => {
        payload += part.toString("utf8");
        if (payload.length > 2048) request.destroy();
      });
      request.on("end", () => {
        release();
        void (async () => {
          try {
            if (closing) return;
            const data = JSON.parse(payload) as unknown;
            if (
              !isRecord(data) ||
              typeof data.hostId !== "string" ||
              typeof data.deviceId !== "string" ||
              typeof data.code !== "string"
            )
              throw new RemoteHostError("invalid_request");
            const result = await options.access.pair({
              hostId: data.hostId,
              deviceId: data.deviceId,
              code: data.code,
            });
            response.writeHead(200);
            response.end(JSON.stringify(result));
          } catch {
            response.writeHead(401);
            response.end(JSON.stringify({ error: "pairing_failed" }));
          }
        })();
      });
    },
  );
  server.maxConnections = REMOTE_MAX_CONNECTIONS;
  server.headersTimeout = REMOTE_HANDSHAKE_MS;
  server.requestTimeout = REMOTE_UNAUTHENTICATED_MS;
  server.keepAliveTimeout = 1_000;
  server.on("connection", (socket) => {
    if (closing || rawSockets.size >= REMOTE_MAX_CONNECTIONS) {
      socket.destroy();
      return;
    }
    rawSockets.add(socket);
    socket.once("close", () => rawSockets.delete(socket));
  });
  server.on("secureConnection", (socket) => {
    if (closing || unauthenticated.size >= REMOTE_MAX_UNAUTHENTICATED) {
      socket.destroy();
      return;
    }
    const deadline = setTimeout(
      () => socket.destroy(),
      REMOTE_UNAUTHENTICATED_MS,
    );
    unauthenticated.set(socket, deadline);
    socket.once("close", () => {
      clearTimeout(deadline);
      unauthenticated.delete(socket);
    });
  });
  const sockets = new Set<WebSocket>();
  const wsServer = new WebSocketServer({
    noServer: true,
    maxPayload: 64 * 1024,
    perMessageDeflate: false,
  });
  const unsubscribeRevocations = options.access.onRevocation((deviceId) => {
    for (const socket of sockets)
      if ((socket as DeviceSocket).deviceId === deviceId)
        socket.close(4003, "revoked");
  });
  server.on("upgrade", (request, socket, head) => {
    const reject = (status: number) => {
      socket.write(
        `HTTP/1.1 ${status} ${status === 503 ? "Service Unavailable" : status === 403 ? "Forbidden" : "Unauthorized"}\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n`,
      );
      socket.destroy();
    };
    if (closing || sockets.size >= REMOTE_MAX_CLIENTS) {
      reject(503);
      return;
    }
    if (request.url !== "/remote" || request.headers.origin !== undefined) {
      reject(403);
      return;
    }
    const deviceId = request.headers["x-zen-device-id"];
    const auth = request.headers.authorization;
    if (
      typeof deviceId !== "string" ||
      typeof auth !== "string" ||
      !auth.startsWith("Bearer ")
    ) {
      reject(401);
      return;
    }
    const token = auth.slice(7);
    try {
      options.access.authenticate(deviceId, token);
    } catch {
      reject(401);
      return;
    }
    wsServer.handleUpgrade(request, socket, head, (ws) => {
      const deadline = unauthenticated.get(socket);
      if (deadline !== undefined) clearTimeout(deadline);
      unauthenticated.delete(socket);
      (ws as DeviceSocket).deviceId = deviceId;
      sockets.add(ws);
      attach(ws, request, deviceId, token, options.access);
      ws.once("close", () => sockets.delete(ws));
    });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(options.port, options.listen, () => {
        server.off("error", reject);
        resolve();
      });
    });
  } catch (error) {
    unsubscribeRevocations();
    wsServer.close();
    throw error;
  }
  const address = server.address() as AddressInfo;
  const hostname = address.address.includes(":")
    ? `[${address.address}]`
    : address.address;
  return {
    url: `wss://${hostname}:${String(address.port)}/remote`,
    async close() {
      if (closing) return;
      closing = true;
      unsubscribeRevocations();
      const closed = new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      for (const socket of sockets) socket.terminate();
      for (const socket of rawSockets) socket.destroy();
      server.closeAllConnections();
      await closed;
      wsServer.close();
    },
  };
}
interface DeviceSocket extends WebSocket {
  deviceId: string;
}
interface RecoverySession {
  generation: number;
  workspaceId: string;
  threadId: string;
  boundary: RemoteRecoveryBoundary;
  position: RemoteRecoveryPosition | null;
  cursor: string | null;
  previousCursor?: string;
  previousPage?: RemoteRecoveryPage;
  finish(): void;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function attach(
  socket: WebSocket,
  _request: IncomingMessage,
  deviceId: string,
  token: string,
  access: RemoteHostAccess,
): void {
  let initialized = false;
  let dispose = () => {};
  let subscriptionGeneration = 0;
  let recovery: RecoverySession | undefined;
  let pageBusy = false;
  let activeRequests = 0;
  const invalidateRecovery = (state: RecoverySession) => {
    // An older in-flight page may finish after another resume has installed a
    // new subscription. It must neither clear nor reply with that newer state.
    if (recovery !== state || subscriptionGeneration !== state.generation)
      return;
    subscriptionGeneration += 1;
    dispose();
    dispose = () => {};
    recovery = undefined; // drops the cached page and the bounded event barrier
  };
  const send = (data: unknown) => {
    if (socket.readyState !== WebSocket.OPEN) return;
    if (socket.bufferedAmount > REMOTE_MAX_OUTBOUND_BUFFER) {
      socket.terminate(); // client must restart recovery; no unbounded buffer
      return;
    }
    const json = JSON.stringify(data);
    if (Buffer.byteLength(json) > 2 * 1024 * 1024) {
      if (isRecord(data) && data.method === "zen/remote/thread/event") {
        socket.terminate(); // large public item is recoverable through text fragments
      } else
        socket.send(
          JSON.stringify({
            id: isRecord(data) ? data.id : null,
            error: {
              code: -32000,
              message: "entry_too_large",
              data: { code: "entry_too_large" },
            },
          }),
        );
      return;
    }
    socket.send(json);
  };
  socket.once("close", () => {
    dispose();
    recovery = undefined;
  });
  socket.on("message", (raw, isBinary) => {
    if (isBinary) {
      socket.close(1003, "JSON text only");
      return;
    }
    if (activeRequests >= 4) {
      socket.close(1013, "Too many concurrent requests");
      return;
    }
    activeRequests += 1;
    void (async () => {
      let id: string | number | null = null;
      try {
        const request = JSON.parse(raw.toString()) as unknown;
        if (
          !isRecord(request) ||
          (typeof request.id !== "string" && typeof request.id !== "number") ||
          typeof request.method !== "string" ||
          !isRecord(request.params)
        )
          throw new RemoteHostError("invalid_request");
        id = request.id;
        const p = request.params;
        if (request.method !== "zen/remote/hello" && !initialized)
          throw new RemoteHostError("unauthorized");
        try {
          access.authenticate(deviceId, token);
        } catch (error) {
          if (recovery !== undefined) invalidateRecovery(recovery);
          throw error;
        }
        const str = (key: string) => {
          const value = p[key];
          if (typeof value !== "string" || value.length > 32768)
            throw new RemoteHostError("invalid_request");
          return value;
        };
        let result: unknown;
        switch (request.method) {
          case "zen/remote/hello":
            if (typeof p.version !== "number")
              throw new RemoteHostError("invalid_request");
            result = await access.hello(
              deviceId,
              token,
              str("hostId"),
              p.version,
            );
            initialized = true;
            break;
          case "zen/remote/workspaces":
            result = { workspaces: await access.workspaces(deviceId, token) };
            break;
          case "zen/remote/threads":
            result = {
              threads: await access.threads(
                deviceId,
                token,
                str("workspaceId"),
              ),
            };
            break;
          case "zen/remote/create":
            result = await access.create(deviceId, token, str("workspaceId"));
            break;
          case "zen/remote/resume": {
            const workspaceId = str("workspaceId"),
              threadId = str("threadId");
            const generation = ++subscriptionGeneration;
            dispose();
            recovery = undefined;
            const pending: RemoteEventView[] = [];
            let pendingBytes = 0;
            let overflow = false;
            let ready = false;
            const reset = () => {
              if (generation !== subscriptionGeneration) return;
              subscriptionGeneration += 1;
              dispose();
              dispose = () => {};
              recovery = undefined;
              send({
                method: "zen/remote/thread/reset",
                params: { threadId, reason: "resync_required" },
              });
            };
            const finish = () => {
              ready = true;
              if (overflow) {
                reset();
                return;
              }
              for (const event of pending)
                send({ method: "zen/remote/thread/event", params: event });
              pending.length = 0;
              pendingBytes = 0;
            };
            dispose = access.subscribe(
              deviceId,
              token,
              workspaceId,
              threadId,
              (event) => {
                if (generation !== subscriptionGeneration) return;
                if (event === null) {
                  if (ready) reset();
                  else {
                    overflow = true;
                    pending.length = 0;
                    pendingBytes = 0;
                  }
                  return;
                }
                if (ready) {
                  send({ method: "zen/remote/thread/event", params: event });
                  return;
                }
                if (overflow) return;
                const bytes = Buffer.byteLength(JSON.stringify(event));
                if (pendingBytes + bytes > REMOTE_PENDING_EVENTS_BYTES) {
                  overflow = true;
                  pending.length = 0;
                  pendingBytes = 0;
                } else {
                  pending.push(event);
                  pendingBytes += bytes;
                }
              },
            );
            try {
              const initial = await access.beginRecovery(
                deviceId,
                token,
                workspaceId,
                threadId,
              );
              if (generation !== subscriptionGeneration)
                throw new RemoteHostError("stale_cursor");
              const projected = projectRemoteRecoveryPage(
                initial.thread,
                initial.boundary,
                { itemIndex: 0, textOffset: 0 },
              );
              const cursor =
                projected.next === null
                  ? null
                  : randomBytes(24).toString("base64url");
              result = { ...projected.page, nextCursor: cursor };
              recovery = {
                generation,
                workspaceId,
                threadId,
                boundary: initial.boundary,
                position: projected.next,
                cursor,
                finish,
              };
            } catch (error) {
              if (generation === subscriptionGeneration) {
                dispose();
                dispose = () => {};
              }
              throw error;
            }
            if (generation !== subscriptionGeneration)
              throw new RemoteHostError("invalid_request");
            send({ id, result });
            if (recovery?.cursor === null) finish();
            return;
          }
          case "zen/remote/resume/page": {
            const cursor = str("cursor");
            const state = recovery;
            if (
              state === undefined ||
              state.generation !== subscriptionGeneration
            )
              throw new RemoteHostError("stale_cursor");
            const retry =
              cursor === state.previousCursor &&
              state.previousPage !== undefined;
            if (
              pageBusy ||
              (!retry && (cursor !== state.cursor || state.position === null))
            )
              throw new RemoteHostError("stale_cursor");
            pageBusy = true;
            try {
              const thread = await access.recoveryThread(
                deviceId,
                token,
                state.workspaceId,
                state.boundary,
              );
              if (
                state !== recovery ||
                state.generation !== subscriptionGeneration
              )
                throw new RemoteHostError("stale_cursor");
              if (retry) {
                // Replaying bytes is idempotent, but never replays an old
                // authorization decision (including a terminal page).
                send({ id, result: state.previousPage });
                return;
              }
              const projected = projectRemoteRecoveryPage(
                thread,
                state.boundary,
                state.position!,
              );
              const nextCursor =
                projected.next === null
                  ? null
                  : randomBytes(24).toString("base64url");
              const page: RemoteRecoveryPage = {
                ...projected.page,
                nextCursor,
              };
              state.previousCursor = cursor;
              state.previousPage = page; // at most one bounded page for response-loss retries
              state.position = projected.next;
              state.cursor = nextCursor;
              send({ id, result: page });
              if (nextCursor === null) state.finish();
            } catch (error) {
              if (!(
                error instanceof RemoteHostError &&
                error.code === "stale_cursor"
              ))
                invalidateRecovery(state);
              throw error;
            } finally {
              pageBusy = false;
            }
            return;
          }
          case "zen/remote/send":
            result = await access.send(deviceId, token, {
              workspaceId: str("workspaceId"),
              threadId: str("threadId"),
              clientId: str("clientId"),
              text: str("text"),
            });
            break;
          case "zen/remote/interrupt":
            result = await access.interrupt(
              deviceId,
              token,
              str("workspaceId"),
              str("threadId"),
              str("expectedTurnId"),
            );
            break;
          default:
            throw new RemoteHostError("invalid_request");
        }
        send({ id, result });
      } catch (error) {
        const code =
          error instanceof RemoteHostError ? error.code : "invalid_request";
        send({ id, error: { code: -32000, message: code, data: { code } } });
      } finally {
        activeRequests -= 1;
      }
    })();
  });
}
