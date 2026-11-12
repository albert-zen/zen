import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, request } from "node:https";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { WebSocket, WebSocketServer } from "ws";
import {
  connectFleetRelayHost,
  hashFleetRelayToken,
  serveFleetRelay,
} from "../src/main/fleet-relay.js";
import { startFleetRelayFromFile } from "../src/main/fleet-relay-cli.js";
import {
  NativeFleetClient,
  type NativeFleetCredential,
} from "../src/main/fleet-native.js";

let directory: string, cert: Buffer, key: Buffer;
before(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "zen-fleet-relay-"));
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      path.join(directory, "key.pem"),
      "-out",
      path.join(directory, "cert.pem"),
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
    ],
    { stdio: "ignore" },
  );
  cert = await readFile(path.join(directory, "cert.pem"));
  key = await readFile(path.join(directory, "key.pem"));
});
after(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});

async function nativeFixture(hostId: string, hangPair = false) {
  const headers: Record<string, unknown>[] = [];
  const sockets = new Set<WebSocket>();
  const devices = new Set(["phone"]);
  const server = createServer({ cert, key }, (req, res) => {
    headers.push({ url: req.url, ...req.headers });
    if (req.method !== "POST" || req.url !== "/pair") {
      res.writeHead(404);
      res.end();
      return;
    }
    let body = "";
    req.on("data", (part) => {
      body += part.toString();
    });
    req.on("end", () => {
      const value = JSON.parse(body);
      if (hangPair) return;
      if (value.hostId === hostId && value.code === "fresh-code")
        devices.add(value.deviceId);
      res.writeHead(
        value.hostId === hostId && value.code === "fresh-code" ? 200 : 401,
        { "content-type": "application/json" },
      );
      res.end(
        JSON.stringify(
          value.hostId === hostId && value.code === "fresh-code"
            ? { hostId, deviceId: value.deviceId, token: `grant-${hostId}` }
            : { error: "pairing_failed" },
        ),
      );
    });
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    headers.push({ url: req.url, ...req.headers });
    if (
      req.url !== "/remote" ||
      req.headers.authorization !== `Bearer grant-${hostId}` ||
      !devices.has(String(req.headers["x-zen-device-id"]))
    ) {
      socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws));
  });
  wss.on("connection", (ws: WebSocket) => {
    sockets.add(ws);
    ws.once("close", () => sockets.delete(ws));
    ws.on("message", (raw) => {
      const rpc = JSON.parse(raw.toString());
      ws.send(
        JSON.stringify({
          id: rpc.id,
          result:
            rpc.method === "zen/remote/hello"
              ? {
                  version: 1,
                  hostId,
                  processEpoch: `epoch-${hostId}`,
                  capabilities: ["rooms", "resume", "send"],
                }
              : rpc.method === "zen/remote/workspaces"
                ? { workspaces: [{ id: "work", label: "Work" }] }
                : rpc.method === "large"
                  ? { hostId, text: "x".repeat(2 * 1024 * 1024 - 256) }
                  : { hostId, echo: rpc.params },
        }),
      );
      if (rpc.method === "zen/remote/rooms")
        ws.send(
          JSON.stringify({
            method: "zen/remote/room/event",
            params: { workspaceId: "work", roomId: hostId },
          }),
        );
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    endpoint: `https://127.0.0.1:${(server.address() as AddressInfo).port}`,
    headers,
    sockets,
    async close() {
      for (const ws of sockets) ws.terminate();
      wss.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
function post(
  endpoint: string,
  hostId: string,
  body: unknown,
  headers: Record<string, string> = {},
  ca: Buffer | undefined = cert,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = request(
      new URL("/pair", endpoint),
      {
        method: "POST",
        ca,
        rejectUnauthorized: true,
        headers: {
          "content-type": "application/json",
          "x-zen-host-id": hostId,
          ...headers,
        },
      },
      (res) => {
        let response = "";
        res.on("data", (part) => {
          response += part.toString();
        });
        res.on("end", () =>
          resolve({
            status: res.statusCode!,
            body: response ? JSON.parse(response) : undefined,
          }),
        );
      },
    );
    req.on("error", reject);
    req.end(JSON.stringify(body));
  });
}
function connect(
  endpoint: string,
  hostId: string,
  token: string,
  extra: Record<string, string> = {},
): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const url = new URL("/remote", endpoint);
    url.protocol = "wss:";
    const ws = new WebSocket(url, {
      ca: cert,
      rejectUnauthorized: true,
      headers: {
        "x-zen-host-id": hostId,
        "x-zen-device-id": "phone",
        authorization: `Bearer ${token}`,
        ...extra,
      },
      perMessageDeflate: false,
    });
    ws.on("error", reject);
    ws.once("open", () => resolve(ws));
  });
}
async function rpc(ws: WebSocket, hostId: string, method = "zen/remote/hello") {
  const response = once(ws, "message");
  ws.send(
    JSON.stringify({
      id: "1",
      method,
      params:
        method === "zen/remote/hello"
          ? { hostId, version: 1 }
          : { workspaceId: "work" },
    }),
  );
  return JSON.parse((await response)[0].toString());
}

test("trusted relay forwards TLS pairing and native RPC/events to isolated registered Hosts", async () => {
  const one = await nativeFixture("host-one"),
    two = await nativeFixture("host-two");
  const relay = await serveFleetRelay({
    enabled: true,
    listen: "127.0.0.1",
    port: 0,
    tls: { cert, key },
    registrations: [
      {
        hostId: "host-one",
        tokenSha256: hashFleetRelayToken("fixture-register-one"),
      },
      {
        hostId: "host-two",
        tokenSha256: hashFleetRelayToken("fixture-register-two"),
      },
    ],
  });
  const first = await connectFleetRelayHost({
    hostId: "host-one",
    relayEndpoint: relay.endpoint,
    registrationToken: "fixture-register-one",
    nativeEndpoint: one.endpoint,
    ca: cert,
    nativeCa: cert,
  });
  const second = await connectFleetRelayHost({
    hostId: "host-two",
    relayEndpoint: relay.endpoint,
    registrationToken: "fixture-register-two",
    nativeEndpoint: two.endpoint,
    ca: cert,
    nativeCa: cert,
  });
  let ws: WebSocket | undefined, other: WebSocket | undefined;
  try {
    const paired = await post(relay.endpoint, "host-one", {
      hostId: "host-one",
      deviceId: "phone",
      code: "fresh-code",
    });
    assert.equal(paired.status, 200);
    assert.equal(paired.body.token, "grant-host-one");
    ws = await connect(relay.endpoint, "host-one", paired.body.token);
    other = await connect(relay.endpoint, "host-two", "grant-host-two");
    assert.equal((await rpc(ws, "host-one")).result.hostId, "host-one");
    assert.equal((await rpc(other, "host-two")).result.hostId, "host-two");
    const event = new Promise<any>((resolve) =>
      ws!.on("message", (raw) => {
        const value = JSON.parse(raw.toString());
        if (value.method) resolve(value);
      }),
    );
    await rpc(ws, "host-one", "zen/remote/rooms");
    assert.equal((await event).params.roomId, "host-one");
    assert.ok(
      one.headers.every(
        (header) => header.url === "/pair" || header.url === "/remote",
      ),
    );
    assert.equal(
      one.headers.find((header) => header.url === "/remote")?.authorization,
      "Bearer grant-host-one",
    );
    assert.ok(
      !one.headers.some((header) =>
        JSON.stringify(header).includes("fixture-register"),
      ),
    );
  } finally {
    ws?.terminate();
    other?.terminate();
    await first.close();
    await second.close();
    await relay.close();
    await one.close();
    await two.close();
  }
});

async function relayFixture(
  options: {
    nativeCa?: boolean;
    hangPair?: boolean;
    timeout?: number;
    serverName?: string;
  } = {},
) {
  const native = await nativeFixture("host-one", options.hangPair);
  const relay = await serveFleetRelay({
    enabled: true,
    listen: "127.0.0.1",
    port: 0,
    tls: { cert, key },
    registrations: [
      {
        hostId: "host-one",
        tokenSha256: hashFleetRelayToken("fixture-register-one"),
      },
    ],
    ...(options.timeout === undefined
      ? {}
      : { operationTimeoutMs: options.timeout }),
  });
  const hostOptions = {
    hostId: "host-one",
    relayEndpoint: relay.endpoint,
    registrationToken: "fixture-register-one",
    nativeEndpoint: native.endpoint,
    ca: cert,
    ...(options.nativeCa === false ? {} : { nativeCa: cert }),
    ...(options.serverName === undefined
      ? {}
      : { nativeServerName: options.serverName }),
    ...(options.timeout === undefined
      ? {}
      : { operationTimeoutMs: options.timeout }),
  };
  const bridge = await connectFleetRelayHost(hostOptions);
  return {
    native,
    relay,
    bridge,
    hostOptions,
    async close() {
      await bridge.close();
      await relay.close();
      await native.close();
    },
  };
}

test("registration rejects unknown/wrong credentials and duplicate live Host takeover", async () => {
  const f = await relayFixture();
  try {
    await assert.rejects(
      connectFleetRelayHost({
        ...f.hostOptions,
        registrationToken: "fixture-wrong-register",
      }),
      /registration/,
    );
    await assert.rejects(
      connectFleetRelayHost({ ...f.hostOptions, hostId: "unknown-host" }),
      /registration/,
    );
    await assert.rejects(connectFleetRelayHost(f.hostOptions), /registration/);
    const ws = await connect(f.relay.endpoint, "host-one", "grant-host-one");
    try {
      assert.equal((await rpc(ws, "host-one")).result.hostId, "host-one");
    } finally {
      ws.terminate();
    }
  } finally {
    await f.close();
  }
});

test("TLS is verified at both hops, including the configured native certificate identity", async () => {
  const f = await relayFixture({ nativeCa: false });
  try {
    await assert.rejects(
      connectFleetRelayHost({ ...f.hostOptions, ca: undefined }),
      /TLS/,
    );
    assert.equal(
      (
        await post(f.relay.endpoint, "host-one", {
          hostId: "host-one",
          deviceId: "phone",
          code: "fresh-code",
        })
      ).status,
      502,
    );
    await assert.rejects(
      connect(f.relay.endpoint, "host-one", "grant-host-one"),
      /502/,
    );
    assert.equal(f.native.headers.length, 0);
    await assert.rejects(
      post(f.relay.endpoint, "host-one", {}, {}, Buffer.from("")),
      /self-signed|certificate/,
    );
  } finally {
    await f.close();
  }
  const wrongName = await relayFixture({ serverName: "wrong.example" });
  try {
    assert.equal(
      (
        await post(wrongName.relay.endpoint, "host-one", {
          hostId: "host-one",
          deviceId: "phone",
          code: "fresh-code",
        })
      ).status,
      502,
    );
    assert.equal(wrongName.native.headers.length, 0);
  } finally {
    await wrongName.close();
  }
  const validName = await relayFixture({ serverName: "localhost" });
  try {
    assert.equal(
      (
        await post(validName.relay.endpoint, "host-one", {
          hostId: "host-one",
          deviceId: "phone",
          code: "fresh-code",
        })
      ).status,
      200,
    );
  } finally {
    await validName.close();
  }
});

test("Host routing, native grant rejection, strict Origins, and fixed local destinations fail closed", async () => {
  const f = await relayFixture();
  try {
    const body = { hostId: "host-one", deviceId: "phone", code: "fresh-code" };
    assert.equal(
      (
        await post(f.relay.endpoint, "host-one", {
          ...body,
          hostId: "host-two",
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await post(f.relay.endpoint, "unknown-host", {
          ...body,
          hostId: "unknown-host",
        })
      ).status,
      503,
    );
    assert.equal(
      (
        await post(f.relay.endpoint, "host-one", body, {
          origin: "https://evil.example",
        })
      ).status,
      403,
    );
    assert.equal(f.native.headers.length, 0);
    await assert.rejects(
      connect(f.relay.endpoint, "host-one", "wrong-grant"),
      /401/,
    );
    await assert.rejects(
      connect(f.relay.endpoint, "host-one", "grant-host-one", {
        origin: "https://evil.example",
      }),
      /403/,
    );
    assert.equal(f.native.headers.length, 1);
    for (const value of [
      "http://127.0.0.1",
      "https://user:pass@127.0.0.1",
      "https://127.0.0.1/other",
      "https://127.0.0.1/?token=secret",
      "https://other.example",
    ])
      await assert.rejects(
        connectFleetRelayHost({ ...f.hostOptions, nativeEndpoint: value }),
        /HTTPS authority|loopback/,
      );
    for (const value of [
      "http://relay.example",
      "https://relay.example/remote",
      "https://relay.example/#secret",
    ])
      await assert.rejects(
        connectFleetRelayHost({ ...f.hostOptions, relayEndpoint: value }),
        /HTTPS authority/,
      );
  } finally {
    await f.close();
  }
});

test("native revocation and outbound tunnel disconnect close clients without replay and report offline", async () => {
  const f = await relayFixture();
  let ws: WebSocket | undefined;
  try {
    ws = await connect(f.relay.endpoint, "host-one", "grant-host-one");
    await rpc(ws, "host-one");
    const revoked = once(ws, "close");
    for (const socket of f.native.sockets) socket.close(4003, "revoked");
    assert.equal((await revoked)[0], 4003);
    ws = await connect(f.relay.endpoint, "host-one", "grant-host-one");
    await rpc(ws, "host-one");
    const disconnected = once(ws, "close");
    await f.bridge.close();
    await f.bridge.closed;
    assert.equal((await disconnected)[0], 1011);
    assert.equal(
      (
        await post(f.relay.endpoint, "host-one", {
          hostId: "host-one",
          deviceId: "phone",
          code: "fresh-code",
        })
      ).status,
      503,
    );
    const count = f.native.headers.length;
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(f.native.headers.length, count);
  } finally {
    ws?.terminate();
    await f.close();
  }
});

test("bounded pair deadlines and frame limits preserve full native response/event capacity", async () => {
  const hanging = await relayFixture({ hangPair: true, timeout: 150 });
  try {
    const result = await post(hanging.relay.endpoint, "host-one", {
      hostId: "host-one",
      deviceId: "phone",
      code: "fresh-code",
    });
    assert.equal(result.status, 504);
    assert.equal(hanging.native.headers.length, 1);
  } finally {
    await hanging.close();
  }
  const f = await relayFixture();
  let ws: WebSocket | undefined;
  try {
    ws = await connect(f.relay.endpoint, "host-one", "grant-host-one");
    const large = await rpc(ws, "host-one", "large");
    assert.equal(large.result.text.length, 2 * 1024 * 1024 - 256);
    const binaryClosed = once(ws, "close");
    ws.send(Buffer.from("{}"));
    assert.equal((await binaryClosed)[0], 1003);
    ws = await connect(f.relay.endpoint, "host-one", "grant-host-one");
    const oversized = once(ws, "close");
    ws.send("x".repeat(64 * 1024 + 1));
    assert.equal((await oversized)[0], 1009);
    assert.equal(
      (
        await post(f.relay.endpoint, "host-one", {
          hostId: "host-one",
          deviceId: "phone",
          code: "x".repeat(2048),
        })
      ).status,
      413,
    );
  } finally {
    ws?.terminate();
    await f.close();
  }
});

test("relay CLI starts only from explicit protected configuration and stores registration digests", async () => {
  const configFile = path.join(directory, "relay.json");
  await chmod(path.join(directory, "key.pem"), 0o600);
  const configuration = {
    version: 1,
    enabled: true,
    listen: "127.0.0.1",
    port: 0,
    tlsCertificateFile: path.join(directory, "cert.pem"),
    tlsKeyFile: path.join(directory, "key.pem"),
    registrations: [
      {
        hostId: "host-one",
        tokenSha256: hashFleetRelayToken("fixture-register-one"),
      },
    ],
  };
  await writeFile(configFile, JSON.stringify(configuration), { mode: 0o600 });
  const relay = await startFleetRelayFromFile(configFile);
  try {
    assert.ok(relay.endpoint.startsWith("https://127.0.0.1:"));
  } finally {
    await relay.close();
  }
  if (process.platform !== "win32") {
    await chmod(configFile, 0o644);
    await assert.rejects(startFleetRelayFromFile(configFile), /protected/);
    await chmod(configFile, 0o600);
    await chmod(path.join(directory, "key.pem"), 0o644);
    await assert.rejects(startFleetRelayFromFile(configFile), /protected/);
    await chmod(path.join(directory, "key.pem"), 0o600);
  }
  await writeFile(
    configFile,
    JSON.stringify({ ...configuration, token: "fixture-register-one" }),
    { mode: 0o600 },
  );
  await assert.rejects(startFleetRelayFromFile(configFile), /configuration/);
  await assert.rejects(
    startFleetRelayFromFile("relative-config.json"),
    /absolute/,
  );
});

test("existing native Fleet client pairs and verifies selected Host identity over the relay endpoint", async () => {
  const f = await relayFixture();
  const vault = new Map<string, NativeFleetCredential>();
  const client = new NativeFleetClient({
    ca: cert,
    credentials: {
      get: async (id) => vault.get(id) ?? null,
      set: async (id, value) => {
        vault.set(id, value);
      },
      delete: async (id) => {
        vault.delete(id);
      },
    },
  });
  const peer = {
    transport: "https" as const,
    id: "relay-desktop",
    label: "Relay desktop",
    hostId: "host-one",
    endpoint: f.relay.endpoint,
    workspace: "work",
    access: "control" as const,
  };
  try {
    const paired = await client.pair(peer, "fresh-code");
    assert.equal(paired.paired, true);
    assert.equal((paired as any).token, undefined);
    assert.equal((await client.test(peer)).status, "connected");
    assert.equal(vault.get(peer.id)?.endpoint, f.relay.endpoint);
    await assert.rejects(
      client.test({ ...peer, hostId: "host-two" }),
      /re-pair/,
    );
    assert.ok(
      f.native.headers.some(
        (header) => header["x-zen-device-id"] === paired.deviceId,
      ),
    );
    assert.ok(
      !f.native.headers.some(
        (header) => header.authorization === "Bearer fixture-register-one",
      ),
    );
  } finally {
    await f.close();
  }
});

test("admitted reverse tunnel and native client outlive the unauthenticated socket deadline", async () => {
  const f = await relayFixture();
  const ws = await connect(f.relay.endpoint, "host-one", "grant-host-one");
  try {
    await rpc(ws, "host-one");
    await new Promise((resolve) => setTimeout(resolve, 10_100));
    assert.equal((await rpc(ws, "host-one")).result.hostId, "host-one");
    const paired = await post(f.relay.endpoint, "host-one", {
      hostId: "host-one",
      deviceId: "phone",
      code: "fresh-code",
    });
    assert.equal(paired.status, 200);
  } finally {
    ws.terminate();
    await f.close();
  }
});

test("registration inventories reject shared secrets and malformed/non-TLS options", async () => {
  const registration = {
    hostId: "host-one",
    tokenSha256: hashFleetRelayToken("fixture-register-one"),
  };
  const options = {
    enabled: true as const,
    listen: "127.0.0.1",
    port: 0,
    tls: { cert, key },
    registrations: [registration],
  };
  await assert.rejects(
    serveFleetRelay({
      ...options,
      registrations: [registration, { ...registration, hostId: "host-two" }],
    }),
    /inventory/,
  );
  await assert.rejects(
    serveFleetRelay({ ...options, registrations: [] }),
    /explicit TLS/,
  );
  await assert.rejects(
    serveFleetRelay({ ...options, originEndpoint: "http://relay.example" }),
    /HTTPS/,
  );
  await assert.rejects(
    serveFleetRelay({ ...options, port: -1 }),
    /explicit TLS/,
  );
  assert.throws(() => hashFleetRelayToken("short"), /credential/);
});

test("closing one session at capacity must not tear down all other sessions", async () => {
  const f = await relayFixture();
  const clients: WebSocket[] = [];
  try {
    for (let i = 0; i < 32; i++)
      clients.push(
        await connect(f.relay.endpoint, "host-one", "grant-host-one"),
      );
    assert.equal(f.native.sockets.size, 32);
    const firstNative = [...f.native.sockets][0]!;
    // Model a peer/connection that has not returned its graceful close response yet.
    (firstNative as any)._socket.pause();
    clients[0]!.terminate();
    await new Promise((r) => setTimeout(r, 50));
    let newError = "";
    try {
      clients.push(
        await connect(f.relay.endpoint, "host-one", "grant-host-one"),
      );
    } catch (e) {
      newError = String(e);
    }
    const outcome = await Promise.race([
      f.bridge.closed.then(() => "entire Host tunnel closed"),
      new Promise<string>((r) =>
        setTimeout(() => r("Host tunnel retained"), 250),
      ),
    ]);
    assert.equal(newError, "");
    assert.equal(clients[1]!.readyState, WebSocket.OPEN);
    assert.equal(outcome, "Host tunnel retained");
  } finally {
    for (const ws of clients) ws.terminate();
    await f.close();
  }
});
