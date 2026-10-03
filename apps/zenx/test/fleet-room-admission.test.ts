import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ZenXTriggerService } from "../src/main/trigger-service.js";
import { ZenXTriggerStore } from "../src/main/trigger-store.js";
import { createFleetRoomsHandler } from "../src/main/fleet-rooms.js";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WebSocket } from "ws";
import { createHostedAppServer } from "../../cli/src/host.js";
import { InMemoryThreadJournal } from "../../../src/journal.js";
import type { AppServerManager } from "../src/main/app-server-manager.js";
import { FleetHostService } from "../src/main/fleet-host.js";
import { FleetSettingsService } from "../src/main/fleet-settings.js";
import type { NativeFleetDevice } from "../src/main/fleet.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}

async function fixture(t: test.TestContext) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "fleet-workspace-"));
  const a = path.join(directory, "a"),
    b = path.join(directory, "b");
  await mkdir(a);
  await mkdir(b);
  const key = path.join(directory, "key.pem"),
    cert = path.join(directory, "cert.pem");
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
  const host = createHostedAppServer({
    cwd: a,
    dataDirectory: path.join(directory, "data"),
    model: "fake",
    provider: { type: "fake" },
    journal: new InMemoryThreadJournal(),
    approvalPolicy: "never",
    toolPresentation: "direct",
  });
  let committedPosts = 0;
  let roomRequest: any;
  const gateway = new FleetHostService(host, {
    request: async (operation, params) => {
      if (roomRequest) return await roomRequest(operation, params);
      if (operation === "post") {
        ++committedPosts;
        return { messageId: "accepted-message", threadId: "assistant" };
      }
      return { rooms: [] };
    },
    subscribe: () => () => {},
  });
  const sockets = new Set<WebSocket>();
  t.after(async () => {
    for (const socket of sockets) socket.terminate();
    await gateway.close();
    await host.closeHostResources();
    await rm(directory, { recursive: true, force: true });
  });
  let configured = [
    { cwd: a, label: "A" },
    { cwd: b, label: "B" },
  ];
  let resolver: (() => Promise<void>) | undefined;
  let epoch = "one";
  let rpcFailure: ((action: string, input: unknown) => boolean) | undefined;
  let stopped = false;
  const calls: Array<{ action: string; input: unknown }> = [];
  const manager = {
    get processEpoch() {
      return stopped ? undefined : epoch;
    },
    currentConfiguration: async () => ({ processEpoch: epoch }),
    fleetControl: async (action: string, input?: unknown) => {
      calls.push({ action, input });
      if (rpcFailure?.(action, input))
        throw new Error("fixture control RPC unavailable");
      return await gateway.control(action, input);
    },
    stop: async () => {
      stopped = true;
      await gateway.close();
    },
  };
  let selectedManager = manager;
  const service = new FleetSettingsService({
    directory,
    nativeCa: await readFile(cert),
    encryption: {
      isEncryptionAvailable: () => true,
      encryptString: (s) => Buffer.from(s),
      decryptString: (b) => b.toString(),
    },
    manager: () => selectedManager as unknown as AppServerManager,
    workspaces: async () => {
      const captured = structuredClone(configured);
      await resolver?.();
      return captured;
    },
  });
  const reservation = createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  await service.save({
    version: 1,
    devices: [],
    hosting: {
      enabled: true,
      bindAddress: "127.0.0.1",
      port,
      tlsCertificateFile: cert,
      tlsKeyFile: key,
      access: "control",
    },
  });
  const peer: NativeFleetDevice = {
    id: "remote",
    label: "Remote",
    transport: "https",
    endpoint: gateway.status().url!,
    hostId: gateway.status().hostId,
    access: "control",
  };
  const pairing = (await service.hostPair()) as { code: string };
  await service.pair({ ...peer, code: pairing.code });
  async function connect() {
    const credential = (await service.native.options.credentials.get(peer.id))!;
    const url = new URL("/remote", peer.endpoint);
    url.protocol = "wss:";
    const socket = new WebSocket(url, {
      ca: await readFile(cert),
      rejectUnauthorized: true,
      headers: {
        authorization: `Bearer ${credential.token}`,
        "x-zen-device-id": credential.deviceId,
        "x-zen-host-id": peer.hostId,
      },
    });
    sockets.add(socket);
    await once(socket, "open");
    let next = 0;
    const pending = new Map<
      number,
      {
        resolve: (value: any) => void;
        reject: (error: Error) => void;
        timer: NodeJS.Timeout;
      }
    >();
    socket.on("message", (raw) => {
      const value = JSON.parse(raw.toString());
      const request = pending.get(value.id);
      if (!request) return;
      pending.delete(value.id);
      clearTimeout(request.timer);
      if (value.error) request.reject(new Error(value.error.message));
      else request.resolve(value.result);
    });
    socket.on("close", () => {
      for (const request of pending.values()) {
        clearTimeout(request.timer);
        request.reject(new Error("fixture socket closed"));
      }
      pending.clear();
    });
    function rpc(method: string, params: unknown = {}): Promise<any> {
      const id = ++next;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error("fixture RPC timed out"));
        }, 3000);
        pending.set(id, { resolve, reject, timer });
        socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
      });
    }
    const hello = await rpc("zen/remote/hello", {
      version: 1,
      hostId: peer.hostId,
    });
    return { rpc, hello, socket };
  }
  const remote = await connect();
  const workspaces = (await remote.rpc("zen/remote/workspaces"))
    .workspaces as Array<{ id: string; label: string }>;
  return {
    committedPosts: () => committedPosts,
    setRoomRequest: (request: any) => (roomRequest = request),
    service,
    host,
    gateway,
    manager,
    directory,
    a,
    b,
    peer,
    remote,
    connect,
    calls,
    aId: workspaces.find((w) => w.label === "A")!.id,
    bId: workspaces.find((w) => w.label === "B")!.id,
    configure: (value: typeof configured) => {
      configured = value;
    },
    resolveWith: (value: typeof resolver) => {
      resolver = value;
    },
    epoch: (value: string) => {
      epoch = value;
    },
    failRpc: (value: typeof rpcFailure) => {
      rpcFailure = value;
    },
    replaceManager: () => {
      selectedManager = { ...manager };
    },
    stopped: () => stopped,
  };
}

test(
  "Room scope replacement prunes obsolete subscriptions before a real canonical Room post",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t);
    const trigger = new ZenXTriggerService(
      {
        request: async () => {
          throw new Error("unexpected request");
        },
        sendAssistant: async () => ({ turnId: "assistant-turn" }),
        onNotification: () => () => {},
      } as any,
      new ZenXTriggerStore(path.join(f.directory, "rooms.json")),
    );
    await trigger.start();
    t.after(() => trigger.stop());
    const thread = await f.host.startThread({ cwd: f.a });
    const room = await trigger.createAssistantRoom({
      name: "Assistant",
      members: [{ name: "Assistant", threadId: thread.id }],
    });
    const automation = {
      roomsAvailable: () => true,
      snapshot: () => trigger.snapshot(),
      prepareRoomMessage: trigger.prepareRoomMessage.bind(trigger),
      postPreparedRoomMessage: trigger.postPreparedRoomMessage.bind(trigger),
      acknowledgeRoomOperation: trigger.acknowledgeRoomOperation.bind(trigger),
    };
    f.setRoomRequest(
      createFleetRoomsHandler(
        {
          request: async (_: any, p: any) => ({
            thread: await f.host.readThread(p.threadId),
          }),
        } as any,
        () => automation as any,
      ),
    );
    const workspaces = [];
    for (let i = 0; i < 32; i++) {
      const cwd = path.join(f.directory, "work" + i);
      await mkdir(cwd);
      workspaces.push({ id: "w" + i, label: "Work " + i, cwd });
    }
    await f.gateway.control("workspaces", workspaces);
    for (const w of workspaces)
      await f.remote.rpc("zen/remote/rooms", { workspaceId: w.id });
    await f.gateway.control("workspaces", [
      { id: f.aId, label: "A", cwd: f.a },
    ]);
    const result = await f.remote.rpc("zen/remote/rooms/post", {
      workspaceId: f.aId,
      roomId: room.id,
      clientId: `${room.operationEpoch}:${randomUUID()}`,
      text: "Post once",
    });
    assert.equal(
      result.messageId,
      trigger.snapshot().rooms[0]!.messages[0]!.id,
    );
    assert.deepEqual(
      trigger.snapshot().rooms[0]!.messages.map((m) => m.text),
      ["Post once"],
    );
  },
);
