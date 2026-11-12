import assert from "node:assert/strict";
import { spawn } from "node:child_process";
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

test("T3 remote bridge accepts the injected MCP endpoint shapes it ignores", async () => {
  for (const endpoint of [
    "http://[::1]:3773/mcp",
    "http://100.64.0.40:3773/mcp",
  ]) {
    await assertCliBridgeStarts(endpoint);
  }
});

async function assertCliBridgeStarts(mcpEndpoint: string): Promise<void> {
  const server = await listeningServer();
  const child = spawn(
    process.execPath,
    [
      path.resolve("dist/apps/cli/src/cli.js"),
      "app-server",
      "--remote",
      serverUrl(server),
      "-c",
      `mcp_servers.t3-code.url=${mcpEndpoint}`,
      "-c",
      'mcp_servers.t3-code.bearer_token_env_var="T3_MCP_BEARER_TOKEN"',
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  try {
    const [socketValue] = await once(server, "connection");
    const socket = socketValue as WebSocket;
    const received = once(socket, "message");
    child.stdin.write('{"id":1,"method":"initialize"}\n');
    const [data] = await received;
    assert.equal(data.toString(), '{"id":1,"method":"initialize"}');
    const forwarded = once(child.stdout, "data");
    socket.send('{"id":1,"result":{"ok":true}}');
    await forwarded;
    child.stdin.end();
    const [exitCode] = await once(child, "close");
    assert.equal(exitCode, 0);
    assert.equal(stderr, "");
    assert.equal(stdout, '{"id":1,"result":{"ok":true}}\n');
  } finally {
    child.kill();
    await closeServer(server);
  }
}

test("T3 MCP options fail closed outside the exact remote bridge shape", async () => {
  const missingValue = await failedCli(["app-server", "-c"]);
  assert.match(missingValue, /Option -c requires a value/u);

  const localListener = await failedCli([
    "app-server",
    "--listen",
    "stdio",
    "-c",
    "mcp_servers.t3-code.url=http://127.0.0.1:3773/mcp",
  ]);
  assert.match(
    localListener,
    /T3 MCP -c options are accepted only with app-server --remote/u,
  );

  const unrelatedConfiguration = await failedCli([
    "app-server",
    "--remote",
    "ws://127.0.0.1:1",
    "-c",
    "model=gpt-5.6-terra",
  ]);
  assert.match(
    unrelatedConfiguration,
    /Unsupported -c configuration for the Zen T3 bridge/u,
  );

  const duplicateConfiguration = await failedCli([
    "app-server",
    "--remote",
    "ws://127.0.0.1:1",
    "-c",
    "mcp_servers.t3-code.url=http://127.0.0.1:3773/mcp",
    "-c",
    "mcp_servers.t3-code.url=http://localhost:3774/mcp",
  ]);
  assert.match(duplicateConfiguration, /Duplicate T3 MCP url/u);

  const credentialedConfiguration = await failedCli([
    "app-server",
    "--remote",
    "ws://127.0.0.1:1",
    "-c",
    "mcp_servers.t3-code.url=http://user:secret@example.test/mcp",
  ]);
  assert.match(credentialedConfiguration, /credential-free http \/mcp URL/u);
});

test("remote bridge rejects host and runtime options that it cannot apply", async () => {
  for (const option of [
    ["--approval", "always"],
    ["--provider", "fake"],
    ["--model", "fake"],
    ["--cwd", process.cwd()],
    ["--data-dir", os.tmpdir()],
    ["--approve"],
    ["--deny"],
    ["--thread", "thread-id"],
  ]) {
    const failure = await failedCli([
      "app-server",
      "--remote",
      "ws://127.0.0.1:1",
      ...option,
    ]);
    assert.match(failure, /Options not supported by app-server --remote/u);
  }
});

async function listeningServer(): Promise<WebSocketServer> {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  return server;
}

async function failedCli(args: string[]): Promise<string> {
  const child = spawn(
    process.execPath,
    [path.resolve("dist/apps/cli/src/cli.js"), ...args],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const [exitCode] = await once(child, "close");
  assert.equal(exitCode, 1);
  return stderr;
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
