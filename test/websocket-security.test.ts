import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { request } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { WebSocket, type ClientOptions } from "ws";

import { createHostedAppServer } from "../apps/cli/src/host.js";
import { InMemoryThreadJournal } from "../src/journal.js";
import { serveCodexWebSocket } from "../src/protocol/codex/websocket.js";

const bearerToken = "test-secret-token";

function testHost() {
  return createHostedAppServer({
    cwd: process.cwd(),
    dataDirectory: path.join(os.tmpdir(), "unused-zen-test-data"),
    model: "fake",
    approvalPolicy: "never",
    provider: { type: "fake" },
    journal: new InMemoryThreadJournal(),
  });
}

test("WebSocket accepts a native client with the configured bearer token", async () => {
  const server = await serveCodexWebSocket({
    appServer: testHost(),
    zenHome: path.join(os.tmpdir(), "zen-home"),
    listen: "ws://127.0.0.1:0",
    bearerToken,
  });
  const socket = await connectWebSocket(server.url, {
    headers: { Authorization: `Bearer ${bearerToken}` },
  });
  try {
    const responsePromise = once(socket, "message");
    socket.send(
      JSON.stringify({
        id: 1,
        method: "initialize",
        params: {
          clientInfo: { name: "test", title: "Test", version: "1" },
          capabilities: null,
        },
      }),
    );
    const [data] = await responsePromise;
    const response = JSON.parse(String(data)) as Record<string, unknown>;
    assert.equal(response.id, 1);
    assert("result" in response);
  } finally {
    socket.close();
    await once(socket, "close");
    await server.close();
  }
});

test("WebSocket rejects missing and incorrect bearer tokens without leaking them", async () => {
  const server = await serveCodexWebSocket({
    appServer: testHost(),
    zenHome: path.join(os.tmpdir(), "zen-home"),
    listen: "ws://127.0.0.1:0",
    bearerToken,
  });
  try {
    const missing = await rejectedHandshake(server.url);
    assert.equal(missing.statusCode, 401);
    assert.equal(missing.authenticate, "Bearer");
    assert(!missing.body.includes(bearerToken));

    const incorrect = await rejectedHandshake(server.url, {
      Authorization: "Bearer wrong-token",
    });
    assert.equal(incorrect.statusCode, 401);
    assert.equal(incorrect.authenticate, "Bearer");
    assert(!incorrect.body.includes(bearerToken));
    assert(!incorrect.body.includes("wrong-token"));
  } finally {
    await server.close();
  }
});

test("WebSocket rejects browser-originated connections even when authorized", async () => {
  const server = await serveCodexWebSocket({
    appServer: testHost(),
    zenHome: path.join(os.tmpdir(), "zen-home"),
    listen: "ws://127.0.0.1:0",
    bearerToken,
  });
  try {
    const rejected = await rejectedHandshake(server.url, {
      Authorization: `Bearer ${bearerToken}`,
      Origin: "https://attacker.example",
    });
    assert.equal(rejected.statusCode, 403);
    assert(!rejected.body.includes(bearerToken));
  } finally {
    await server.close();
  }
});

async function connectWebSocket(
  url: string,
  options: ClientOptions,
): Promise<WebSocket> {
  const socket = new WebSocket(url, options);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return socket;
}

async function rejectedHandshake(
  url: string,
  headers: Record<string, string> = {},
): Promise<{
  statusCode: number | undefined;
  authenticate: string | undefined;
  body: string;
}> {
  const endpoint = new URL(url.replace(/^ws:/u, "http:"));
  return await new Promise((resolve, reject) => {
    const handshake = request(endpoint, {
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Key": randomBytes(16).toString("base64"),
        "Sec-WebSocket-Version": "13",
        ...headers,
      },
    });
    handshake.once("response", (response) => {
      response.setEncoding("utf8");
      let body = "";
      response.on("data", (chunk: string) => {
        body += chunk;
      });
      response.once("end", () => {
        resolve({
          statusCode: response.statusCode,
          authenticate:
            typeof response.headers["www-authenticate"] === "string"
              ? response.headers["www-authenticate"]
              : undefined,
          body,
        });
      });
      response.once("error", reject);
    });
    handshake.once("upgrade", (_response, socket) => {
      socket.destroy();
      reject(new Error("Expected the WebSocket handshake to be rejected"));
    });
    handshake.once("error", reject);
    handshake.end();
  });
}
