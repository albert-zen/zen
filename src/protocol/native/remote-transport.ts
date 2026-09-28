import { createServer, type Server as HttpsServer } from "node:https";
import type { IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocket, WebSocketServer } from "ws";
import {
  RemoteHostAccess,
  RemoteHostError,
  type RemoteEventView,
} from "./remote-host.js";

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
  const server: HttpsServer = createServer(
    { cert: options.tls.cert, key: options.tls.key, minVersion: "TLSv1.2" },
    (request, response) => {
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
      request.on("data", (part: Buffer) => {
        payload += part.toString("utf8");
        if (payload.length > 2048) request.destroy();
      });
      request.on("end", () => {
        void (async () => {
          try {
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
        `HTTP/1.1 ${status} ${status === 403 ? "Forbidden" : "Unauthorized"}\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n`,
      );
      socket.destroy();
    };
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
      unsubscribeRevocations();
      for (const socket of sockets) socket.terminate();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      wsServer.close();
    },
  };
}
interface DeviceSocket extends WebSocket {
  deviceId: string;
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
  const send = (data: unknown) => {
    if (socket.readyState !== WebSocket.OPEN) return;
    const json = JSON.stringify(data);
    if (Buffer.byteLength(json) > 2 * 1024 * 1024) {
      socket.send(
        JSON.stringify({
          id: isRecord(data) ? data.id : null,
          error: {
            code: -32000,
            message: "Response too large",
            data: { code: "invalid_request" },
          },
        }),
      );
      return;
    }
    socket.send(json);
  };
  socket.once("close", () => dispose());
  socket.on("message", (raw, isBinary) => {
    if (isBinary) {
      socket.close(1003, "JSON text only");
      return;
    }
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
        access.authenticate(deviceId, token);
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
            const pending: RemoteEventView[] = [];
            let ready = false;
            dispose = access.subscribe(
              deviceId,
              token,
              workspaceId,
              threadId,
              (event) => {
                if (generation !== subscriptionGeneration) return;
                if (!ready) pending.push(event);
                else send({ method: "zen/remote/thread/event", params: event });
              },
            );
            try {
              result = await access.resume(
                deviceId,
                token,
                workspaceId,
                threadId,
              );
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
            ready = true;
            for (const event of pending)
              send({ method: "zen/remote/thread/event", params: event });
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
      }
    })();
  });
}
