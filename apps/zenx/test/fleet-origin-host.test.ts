import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, chmod } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WebSocket } from "ws";
import { createHostedAppServer } from "../../cli/src/host.js";
import { InMemoryThreadJournal } from "../../../src/journal.js";
import {
  FleetHostService,
  type FleetHostConfig,
} from "../src/main/fleet-host.js";
import {
  NativeFleetClient,
  type NativeFleetCredential,
} from "../src/main/fleet-native.js";
import type { NativeFleetDevice } from "../src/main/fleet.js";
import {
  REMOTE_HOST_VERSION,
  REMOTE_METHODS,
} from "../../../src/protocol/native/remote-wire.js";

test("Fleet Host wires the exact SAN-bound Android Origin while keeping pairing Origin-free", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fleet-origin-host-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const key = path.join(dir, "key.pem"),
    cert = path.join(dir, "cert.pem");
  // Ephemeral test identity only; no real device or application configuration.
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      key,
      "-out",
      cert,
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
    ],
    { stdio: "ignore" },
  );
  await chmod(key, 0o600);
  const ca = await readFile(cert);
  const app = createHostedAppServer({
    cwd: dir,
    dataDirectory: path.join(dir, "data"),
    model: "fake",
    provider: { type: "fake" },
    journal: new InMemoryThreadJournal(),
    approvalPolicy: "never",
  });
  const service = new FleetHostService(app, {
    request: async () => ({ rooms: [] }),
    subscribe: () => () => {},
  });
  t.after(async () => {
    await service.close();
    await app.closeHostResources();
  });
  const config: FleetHostConfig = {
    enabled: true,
    hostId: "fixture-host",
    bindAddress: "127.0.0.1",
    port: 0,
    tlsCertificateFile: cert,
    tlsKeyFile: key,
    grantFile: path.join(dir, "grants.json"),
    access: "read",
    workspaces: [{ id: "work", label: "Work", cwd: dir }],
  };
  await service.control("configure", config);
  const endpoint = service.status().url!;
  const peer: NativeFleetDevice = {
    transport: "https",
    id: "fixture-client",
    label: "Fixture client",
    endpoint,
    hostId: config.hostId,
    access: "read",
    workspace: "work",
  };
  let credential: NativeFleetCredential | null = null;
  const client = new NativeFleetClient({
    ca,
    credentials: {
      get: async () => credential,
      set: async (_id, value) => {
        credential = value;
      },
      delete: async () => {
        credential = null;
      },
    },
  });
  const pair = async () => {
    const { code } = (await service.control("pair")) as { code: string };
    await client.pair(peer, code);
  };
  await pair();
  const open = async (origin?: string) =>
    await new Promise<WebSocket>((resolve, reject) => {
      const auth = credential!;
      const socket = new WebSocket(
        `${endpoint.replace(/^https:/u, "wss:")}/remote`,
        {
          ca,
          rejectUnauthorized: true,
          handshakeTimeout: 3000,
          headers: {
            authorization: `Bearer ${auth.token}`,
            "x-zen-device-id": auth.deviceId,
          },
          ...(origin ? { origin } : {}),
        },
      );
      const fail = (reason: Error) => {
        socket.terminate();
        reject(reason);
      };
      socket.once("error", fail);
      socket.once("unexpected-response", (_request, response) => {
        response.resume();
        fail(new Error(`upgrade rejected ${response.statusCode}`));
      });
      socket.once("open", () => {
        socket.off("error", fail);
        socket.on("error", () => {});
        resolve(socket);
      });
    });
  // The blank policy remains native-only for Origin-bearing WebSocket clients.
  await assert.rejects(open(endpoint), /upgrade rejected 403/u);
  config.port = Number(new URL(endpoint).port);
  config.originEndpoint = endpoint;
  await service.control("configure", config);
  const accepted = await open(endpoint);
  t.after(() => accepted.terminate());
  const reply = new Promise<unknown>((resolve) =>
    accepted.once("message", (value) => resolve(JSON.parse(value.toString()))),
  );
  accepted.send(
    JSON.stringify({
      id: "hello",
      method: REMOTE_METHODS.hello,
      params: { version: REMOTE_HOST_VERSION, hostId: config.hostId },
    }),
  );
  assert.equal(
    ((await reply) as { result: { hostId: string } }).result.hostId,
    config.hostId,
  );
  accepted.terminate();
  await assert.rejects(
    open(`https://wrong.example:${config.port}`),
    /upgrade rejected 403/u,
  );
  await assert.rejects(
    open(
      `https://127.0.0.1:${config.port === 65535 ? config.port - 1 : config.port + 1}`,
    ),
    /upgrade rejected 403/u,
  );
  // Origin-absent native clients still work with the narrow Android exception.
  assert.equal((await client.test(peer)).status, "connected");
  const pairing = (await service.control("pair")) as { code: string };
  const status = await new Promise<number | undefined>((resolve, reject) => {
    const body = JSON.stringify({
      hostId: config.hostId,
      deviceId: "origin-pair-client",
      code: pairing.code,
    });
    const request = httpsRequest(
      `${endpoint}/pair`,
      {
        method: "POST",
        ca,
        rejectUnauthorized: true,
        headers: {
          origin: endpoint,
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        },
      },
      (response) => {
        response.resume();
        response.once("end", () => resolve(response.statusCode));
      },
    );
    request.once("error", reject);
    request.end(body);
  });
  assert.equal(status, 403);
  await client.pair(peer, pairing.code);
  assert.equal((await client.test(peer)).status, "connected");
  // Server still checks the real TLS SAN after UI/parser validation.
  await assert.rejects(
    service.control("configure", {
      ...config,
      originEndpoint: `https://wrong.example:${config.port}`,
    }),
    /certificate SAN/u,
  );
  await assert.rejects(
    service.control("configure", {
      ...config,
      originEndpoint: `https://127.0.0.1:${config.port === 65535 ? config.port - 1 : config.port + 1}`,
    }),
    /port must equal/u,
  );
});
