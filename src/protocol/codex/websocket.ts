import { createHash, timingSafeEqual } from "node:crypto";

import { WebSocket, WebSocketServer } from "ws";

import type { ZenAppServer } from "../../app-server.js";
import { CodexConnection } from "./connection.js";
import type { JsonRpcMessage } from "./wire.js";
import { NativeConnection } from "../native/connection.js";
import { NativeRecoveryProjection } from "../native/recovery.js";

export interface CodexWebSocketServer {
  url: string;
  close(): Promise<void>;
}

export async function serveCodexWebSocket(options: {
  appServer: ZenAppServer;
  zenHome: string;
  listen: string;
  bearerToken?: string;
  processEpoch?: string;
}): Promise<CodexWebSocketServer> {
  const endpoint = new URL(options.listen);
  if (endpoint.protocol !== "ws:") {
    throw new Error("Zen currently supports ws:// App Server listeners only");
  }
  if (!isLoopback(endpoint.hostname)) {
    throw new Error(`Refusing non-loopback listener: ${endpoint.hostname}`);
  }
  if (options.bearerToken !== undefined && options.bearerToken.length === 0) {
    throw new Error("WebSocket bearer token must not be empty");
  }
  const requestedPort =
    endpoint.port.length === 0 ? 0 : Number.parseInt(endpoint.port, 10);
  const server = new WebSocketServer({
    host: endpoint.hostname,
    port: requestedPort,
    path: endpoint.pathname === "/" ? undefined : endpoint.pathname,
    verifyClient: (info, accept) => {
      if (info.req.headers.origin !== undefined) {
        accept(false, 403, "Forbidden");
        return;
      }
      if (
        options.bearerToken !== undefined &&
        !hasExpectedBearerToken(
          info.req.headers.authorization,
          options.bearerToken,
        )
      ) {
        accept(false, 401, "Unauthorized", {
          "WWW-Authenticate": "Bearer",
        });
        return;
      }
      accept(true);
    },
  });
  const connections = new Set<CodexConnection>();
  const nativeConnections = new Set<NativeConnection>();
  const nativeProjection = new NativeRecoveryProjection(options.appServer, {
    ...(options.processEpoch === undefined
      ? {}
      : { processEpoch: options.processEpoch }),
  });

  server.on("connection", (socket) => {
    const connection = new CodexConnection({
      appServer: options.appServer,
      zenHome: options.zenHome,
      send: (message) => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify(message));
        }
      },
    });
    const nativeConnection = new NativeConnection({
      projection: nativeProjection,
      send: (message) => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify(message));
        }
      },
    });
    connections.add(connection);
    nativeConnections.add(nativeConnection);

    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        socket.close(1003, "Zen accepts JSON text frames only");
        return;
      }
      let message: JsonRpcMessage;
      try {
        message = JSON.parse(data.toString()) as JsonRpcMessage;
      } catch {
        socket.send(
          JSON.stringify({
            id: null,
            error: { code: -32700, message: "Parse error" },
          }),
        );
        return;
      }
      if (NativeConnection.handles(message))
        void nativeConnection.receive(message);
      else {
        void connection.receive(message).then(() => {
          if (
            "method" in message &&
            message.method === "thread/unsubscribe" &&
            typeof message.params === "object" &&
            message.params !== null &&
            typeof (message.params as { threadId?: unknown }).threadId ===
              "string"
          ) {
            nativeConnection.unsubscribe(
              (message.params as { threadId: string }).threadId,
            );
          }
        });
      }
    });
    socket.once("close", () => {
      connection.close("WebSocket closed");
      nativeConnection.close();
      connections.delete(connection);
      nativeConnections.delete(nativeConnection);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("WebSocket listener did not expose a TCP address");
  }
  const path = endpoint.pathname === "/" ? "" : endpoint.pathname;
  return {
    url: `ws://${endpoint.hostname}:${String(address.port)}${path}`,
    close: async () => {
      for (const connection of connections) {
        connection.close("Server stopped");
      }
      for (const connection of nativeConnections) connection.close();
      nativeProjection.close();
      for (const client of server.clients) {
        client.close(1001, "Server stopped");
      }
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined) {
            resolve();
          } else {
            reject(error);
          }
        });
      });
    },
  };
}

function isLoopback(hostname: string): boolean {
  return (
    hostname === "127.0.0.1" ||
    hostname === "localhost" ||
    hostname === "::1" ||
    hostname === "[::1]"
  );
}

function hasExpectedBearerToken(
  authorization: string | undefined,
  bearerToken: string,
): boolean {
  const actual = createHash("sha256")
    .update(authorization ?? "")
    .digest();
  const expected = createHash("sha256")
    .update(`Bearer ${bearerToken}`)
    .digest();
  return timingSafeEqual(actual, expected);
}
