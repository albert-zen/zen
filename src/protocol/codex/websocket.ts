import { WebSocket, WebSocketServer } from "ws";

import type { ZenAppServer } from "../../app-server.js";
import { CodexConnection } from "./connection.js";
import type { JsonRpcMessage } from "./wire.js";

export interface CodexWebSocketServer {
  url: string;
  close(): Promise<void>;
}

export async function serveCodexWebSocket(options: {
  appServer: ZenAppServer;
  zenHome: string;
  listen: string;
}): Promise<CodexWebSocketServer> {
  const endpoint = new URL(options.listen);
  if (endpoint.protocol !== "ws:") {
    throw new Error("Zen currently supports ws:// App Server listeners only");
  }
  if (!isLoopback(endpoint.hostname)) {
    throw new Error(
      `Refusing unauthenticated non-loopback listener: ${endpoint.hostname}`,
    );
  }
  const requestedPort =
    endpoint.port.length === 0 ? 0 : Number.parseInt(endpoint.port, 10);
  const server = new WebSocketServer({
    host: endpoint.hostname,
    port: requestedPort,
    path: endpoint.pathname === "/" ? undefined : endpoint.pathname,
  });
  const connections = new Set<CodexConnection>();

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
    connections.add(connection);

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
      void connection.receive(message);
    });
    socket.once("close", () => {
      connection.close("WebSocket closed");
      connections.delete(connection);
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
