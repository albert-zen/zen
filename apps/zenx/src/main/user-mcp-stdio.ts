import { WebSocket } from "ws";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { JSONRPCMessageSchema } from "@modelcontextprotocol/sdk/types.js";
import { readZenXConnectionDescriptor } from "../protocol-client/connection-descriptor.js";
import { readBearerTokenFile } from "../protocol-client/auth.js";
import { validateBoardOwner, type BoardOwner } from "../board-host.js";
import {
  NATIVE_MCP_BIND_METHOD,
  NATIVE_MCP_MESSAGE_METHOD,
} from "../../../../src/protocol/native/bound-mcp.js";

/** Connect only: explicit live Desktop descriptor, fixed owner, no discovery or boot. */
export async function runLiveHostUserMcpStdio(options: {
  descriptorFile: string;
  owner: BoardOwner;
}) {
  const owner = Object.freeze(validateBoardOwner(options.owner));
  const descriptor = await readZenXConnectionDescriptor(options.descriptorFile);
  const token = await readBearerTokenFile(descriptor.authentication.tokenFile);
  const socket = new WebSocket(descriptor.url, {
    headers: { Authorization: `Bearer ${token}` },
    handshakeTimeout: 10000,
  });
  const stdio = new StdioServerTransport(process.stdin, process.stdout, {
    maxBufferSize: 1024 * 1024,
  });
  let next = 1;
  let closed = false;
  const pending = new Map<
    number,
    {
      resolve(value: unknown): void;
      reject(error: Error): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  const close = async () => {
    if (closed) return;
    closed = true;
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(
        new Error(
          "Existing Desktop Host connection closed; writes are not retried",
        ),
      );
    }
    pending.clear();
    socket.close();
    await stdio.close();
  };
  const request = (method: string, params: unknown) =>
    new Promise<unknown>((resolve, reject) => {
      if (closed || socket.readyState !== WebSocket.OPEN) {
        reject(new Error("Desktop Host is unavailable"));
        return;
      }
      if (pending.size >= 128) {
        reject(new Error("Desktop MCP pending transport limit reached"));
        return;
      }
      const id = next++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(
          new Error(
            "Desktop MCP transport acknowledgement timed out; no retry",
          ),
        );
      }, 30000);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params }), (error) => {
        if (error) {
          clearTimeout(timer);
          pending.delete(id);
          reject(error);
        }
      });
    });
  socket.on("message", (data) => {
    try {
      const message = JSON.parse(data.toString());
      if (message.method === NATIVE_MCP_MESSAGE_METHOD) {
        const inner = JSONRPCMessageSchema.parse(message.params?.message);
        void stdio.send(inner).catch(() => close());
      } else if (typeof message.id === "number") {
        const response = pending.get(message.id);
        if (!response) return;
        clearTimeout(response.timer);
        pending.delete(message.id);
        if (message.error)
          response.reject(new Error(String(message.error.message)));
        else response.resolve(message.result);
      }
    } catch {
      void close();
    }
  });
  process.stdin.once("end", () => void close());
  socket.once("close", () => void close());
  stdio.onclose = () => void close();
  stdio.onerror = () => void close();
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    socket.on("error", () => void close());
    await request("initialize", {
      clientInfo: { name: "zenx-bound-mcp-launcher", version: "1" },
    });
    socket.send(JSON.stringify({ method: "initialized" }));
    await request(NATIVE_MCP_BIND_METHOD, { owner });
    stdio.onmessage = (message) => {
      void request(NATIVE_MCP_MESSAGE_METHOD, { message }).catch(
        async (error: unknown) => {
          console.error(
            error instanceof Error
              ? error.message
              : "Desktop MCP tunnel failed",
          );
          await close();
        },
      );
    };
    await stdio.start();
    return { close };
  } catch (error) {
    await close();
    throw error;
  }
}
