import assert from "node:assert/strict";
import { once } from "node:events";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import { WebSocket, WebSocketServer } from "ws";

import {
  bridgeCodexStdioToWebSocket,
  readBearerTokenFile,
} from "../src/protocol/codex/bridge.js";

test("reads a trimmed bearer token only from a private regular file", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zen-token-"));
  const tokenFile = path.join(directory, "app-server.token");
  try {
    await writeFile(tokenFile, "  private-token\n", { mode: 0o600 });
    assert.equal(await readBearerTokenFile(tokenFile), "private-token");

    if (process.platform !== "win32") {
      await chmod(tokenFile, 0o644);
      await assert.rejects(
        readBearerTokenFile(tokenFile),
        /readable by group or others/u,
      );
    }

    await chmod(tokenFile, 0o600);
    await writeFile(tokenFile, " \n\t", { mode: 0o600 });
    await assert.rejects(readBearerTokenFile(tokenFile), /is empty/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("bridges JSONL in both directions and authenticates with bearer", async () => {
  const server = await listeningServer();
  const input = new PassThrough();
  const output = new PassThrough();
  try {
    const connected = once(server, "connection");
    const bridge = bridgeCodexStdioToWebSocket({
      url: serverUrl(server),
      bearerToken: "bridge-token",
      input,
      output,
    });
    const [socketValue, requestValue] = await connected;
    const socket = socketValue as WebSocket;
    const request = requestValue as {
      headers: { authorization?: string };
    };
    assert.equal(request.headers.authorization, "Bearer bridge-token");

    const received = once(socket, "message");
    input.write('{"id":1,"method":"initialize"}\n');
    const [data, isBinary] = await received;
    assert.equal(isBinary, false);
    assert.equal(data.toString(), '{"id":1,"method":"initialize"}');

    const forwarded = once(output, "data");
    socket.send('{"id":1,"result":{"ok":true}}');
    const [stdout] = await forwarded;
    assert.equal(stdout.toString(), '{"id":1,"result":{"ok":true}}\n');

    input.end();
    await bridge;
  } finally {
    input.end();
    await closeServer(server);
  }
});

test("rejects binary frames from the central App Server", async () => {
  const server = await listeningServer();
  const input = new PassThrough();
  try {
    const connected = once(server, "connection");
    const bridge = bridgeCodexStdioToWebSocket({
      url: serverUrl(server),
      input,
      output: new PassThrough(),
    });
    const [socketValue] = await connected;
    const socket = socketValue as WebSocket;
    const ready = once(socket, "message");
    input.write('{"method":"ready"}\n');
    await ready;
    const rejected = assert.rejects(bridge, /binary WebSocket frame/u);
    socket.send(Buffer.from([1, 2, 3]), { binary: true });
    await rejected;
  } finally {
    input.end();
    await closeServer(server);
  }
});

async function listeningServer(): Promise<WebSocketServer> {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  return server;
}

function serverUrl(server: WebSocketServer): string {
  const address = server.address();
  assert(address !== null && typeof address !== "string");
  return `ws://127.0.0.1:${String(address.port)}`;
}

async function closeServer(server: WebSocketServer): Promise<void> {
  for (const client of server.clients) {
    client.terminate();
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
}
