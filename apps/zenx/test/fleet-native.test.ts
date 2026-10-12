import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:https";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { WebSocket, WebSocketServer } from "ws";
import { createHostedAppServer } from "../../cli/src/host.js";
import { InMemoryThreadJournal } from "../../../src/journal.js";
import { RemoteHostAccess } from "../../../src/protocol/native/remote-host.js";
import { serveRemoteHost } from "../../../src/protocol/native/remote-transport.js";
import {
  FleetRouter,
  parseFleetConfig,
  type FleetRequest,
  type NativeFleetDevice,
} from "../src/main/fleet.js";
import {
  NativeFleetClient,
  NativeFleetRejectedError,
  type NativeFleetCredential,
  type NativeFleetCredentialStore,
} from "../src/main/fleet-native.js";

let directory: string, cert: Buffer, key: Buffer;
before(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "zen-fleet-native-"));
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
const signal = () => new AbortController().signal;
const request = (
  name: string,
  args: Record<string, unknown> = {},
): FleetRequest => ({
  version: 1,
  name,
  arguments: args,
  callId: "call",
  canonicalToolCallId: "canonical-call",
  threadId: "caller",
});
const started = {
  id: "start",
  threadId: "thread-full",
  turnId: "turn-one",
  createdAt: "2026-10-01T00:00:00Z",
  type: "turn_started",
};
const message = {
  id: "reply",
  threadId: "thread-full",
  turnId: "turn-one",
  createdAt: "2026-10-01T00:00:01Z",
  type: "agent_message",
  text: "remote reply",
};
const completed = {
  id: "complete",
  threadId: "thread-full",
  turnId: "turn-one",
  createdAt: "2026-10-01T00:00:02Z",
  type: "turn_completed",
};
const recovery = (status = "completed", watermark = 2) => ({
  processEpoch: "epoch-one",
  threadId: "thread-full",
  watermark,
  thread: { id: "thread-full", name: "Remote task", archived: false },
  entries: [
    { kind: "item", item: started, turn: { id: "turn-one", status } },
    ...(status === "inProgress"
      ? []
      : [
          { kind: "item", item: message },
          { kind: "item", item: completed },
        ]),
  ],
  nextCursor: null,
});
interface Rpc {
  id: string;
  method: string;
  params: Record<string, unknown>;
}
async function fixture(
  handler?: (request: Rpc, ws: WebSocket) => unknown,
  holdHandshake?: () => void,
) {
  const requests: Rpc[] = [];
  const headers: Record<string, unknown>[] = [];
  const vault = new Map<string, NativeFleetCredential>();
  const credentials: NativeFleetCredentialStore = {
    get: async (id) => vault.get(id) ?? null,
    set: async (id, value) => {
      vault.set(id, value);
    },
    delete: async (id) => {
      vault.delete(id);
    },
  };
  let pairCalls = 0,
    upgradeCalls = 0;
  const server = createServer({ cert, key }, (req, res) => {
    headers.push({ url: req.url, ...req.headers });
    if (req.method !== "POST" || req.url !== "/pair") {
      res.writeHead(404);
      res.end();
      return;
    }
    pairCalls++;
    let body = "";
    req.on("data", (part) => {
      body += part.toString();
    });
    req.on("end", () => {
      const parsed = JSON.parse(body);
      if (
        parsed.code !== "fresh-code" ||
        parsed.hostId !== "host-one" ||
        pairCalls > 1
      ) {
        res.writeHead(401);
        res.end("{}");
        return;
      }
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          hostId: parsed.hostId,
          deviceId: parsed.deviceId,
          token: "opaque-grant",
        }),
      );
    });
  });
  const wss = new WebSocketServer({ noServer: true });
  const heldHandshakes = new Set<import("node:stream").Duplex>();
  server.on("upgrade", (req, socket, head) => {
    upgradeCalls++;
    headers.push({ url: req.url, ...req.headers });
    if (
      req.url !== "/remote" ||
      req.headers.authorization !== "Bearer opaque-grant" ||
      !req.headers["x-zen-device-id"]
    ) {
      socket.destroy();
      return;
    }
    if (holdHandshake) {
      heldHandshakes.add(socket);
      socket.once("close", () => heldHandshakes.delete(socket));
      holdHandshake();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws));
  });
  wss.on("connection", (ws) => {
    ws.on("message", (data) => {
      const rpc = JSON.parse(data.toString()) as Rpc;
      requests.push(rpc);
      let result = handler?.(rpc, ws);
      if (result === null) return;
      if (result === undefined)
        switch (rpc.method) {
          case "zen/remote/hello":
            result = {
              version: 1,
              hostId: rpc.params.hostId,
              processEpoch: "epoch-one",
              capabilities: [
                "workspaces",
                "threads",
                "create",
                "resume",
                "resumePage",
                "send",
                "send-unarchived",
                "models",
              ],
            };
            break;
          case "zen/remote/workspaces":
            result = { workspaces: [{ id: "workspace-one", label: "Work" }] };
            break;
          case "zen/remote/models":
            result = {
              models: [{ id: "p::m", model: "m", displayName: "Model" }],
            };
            break;
          case "zen/remote/threads":
            result = {
              threads: [
                {
                  threadId: "thread-full",
                  name: "Remote task",
                  status: "idle",
                },
              ],
            };
            break;
          case "zen/remote/create":
            result = {
              id: "created-thread",
              archived: false,
              items: [],
              turns: [],
            };
            break;
          case "zen/remote/resume":
            result = recovery();
            break;
          case "zen/remote/send":
            result = { turnId: "new-turn" };
            break;
          default:
            throw new Error(`Unexpected method ${rpc.method}`);
        }
      if (ws.readyState === WebSocket.OPEN)
        ws.send(JSON.stringify({ id: rpc.id, result }));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const endpoint = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const peer: NativeFleetDevice = {
    transport: "https",
    id: "remote",
    label: "Remote",
    hostId: "host-one",
    endpoint,
    workspace: "workspace-one",
    access: "control",
  };
  const client = new NativeFleetClient({ credentials, ca: cert });
  return {
    peer,
    client,
    credentials,
    vault,
    requests,
    headers,
    get pairCalls() {
      return pairCalls;
    },
    get upgradeCalls() {
      return upgradeCalls;
    },
    async enrolled() {
      await client.pair(peer, "fresh-code");
    },
    async close() {
      for (const socket of heldHandshakes) socket.destroy();
      for (const ws of wss.clients) ws.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

test("strict Fleet config accepts HTTPS and explicit hosting, retains legacy SSH, rejects secrets and unsafe authorities", () => {
  const ssh = {
    id: "legacy",
    label: "SSH",
    sshHost: "work",
    command: ["node", "bridge"],
    access: "read",
  };
  const https = {
    id: "native",
    label: "Native",
    transport: "https",
    endpoint: "https://HOST.example:443/",
    hostId: "host",
    access: "control",
    workspace: "work",
  };
  const config = parseFleetConfig({
    version: 1,
    revision: 3,
    devices: [ssh, https],
    hosting: {
      enabled: true,
      bindAddress: "127.0.0.1",
      port: 443,
      tlsCertificateFile: "/cert.pem",
      tlsKeyFile: "/key.pem",
      access: "read",
    },
  });
  assert.equal(
    (config.devices[1] as NativeFleetDevice).endpoint,
    "https://host.example",
  );
  assert.equal(config.revision, 3);
  for (const endpoint of [
    "http://host",
    "https://user:secret@host",
    "https://host/?token=secret",
    "https://host?",
    "https://host/#secret",
    "https://host/path",
    "https://host\\evil",
    "https://host\n",
    "https://host:99999",
  ])
    assert.throws(() =>
      parseFleetConfig({ version: 1, devices: [{ ...https, endpoint }] }),
    );
  for (const extra of [
    { token: "secret" },
    { password: "secret" },
    { sshHost: "work" },
    { access: "owner" },
    { hostId: "\u0000" },
  ])
    assert.throws(() =>
      parseFleetConfig({ version: 1, devices: [{ ...https, ...extra }] }),
    );
  assert.throws(() =>
    parseFleetConfig({ version: 1, devices: [], token: "secret" }),
  );
  assert.throws(() =>
    parseFleetConfig({ version: 1, devices: [], revision: -1 }),
  );
  assert.throws(() =>
    parseFleetConfig({
      version: 1,
      devices: [],
      hosting: { ...config.hosting, port: 0 },
    }),
  );
});

test("TLS pair is one-time and secrets remain vault-only; restart reconnects and endpoints cannot reuse a grant", async () => {
  const f = await fixture();
  try {
    const paired = await f.client.pair(f.peer, "fresh-code");
    assert.equal(paired.paired, true);
    assert.equal((paired as any).token, undefined);
    const restarted = new NativeFleetClient({
      credentials: f.credentials,
      ca: cert,
    });
    assert.equal((await restarted.test(f.peer)).status, "connected");
    assert.equal(f.pairCalls, 1);
    for (const headers of f.headers) {
      assert.ok(!String(headers.url).includes("opaque-grant"));
      assert.equal(headers["x-zen-host-id"], "host-one");
      if (headers.url === "/remote")
        assert.equal(headers.authorization, "Bearer opaque-grant");
    }
    const before = f.upgradeCalls;
    await assert.rejects(
      restarted.test({ ...f.peer, endpoint: "https://other.example" }),
      /re-pair/,
    );
    await assert.rejects(
      restarted.test({ ...f.peer, hostId: "different-host" }),
      /re-pair/,
    );
    assert.equal(f.upgradeCalls, before);
    await assert.rejects(
      f.client.pair(f.peer, "fresh-code"),
      /pairing rejected/,
    );
    assert.equal(f.pairCalls, 2);
    await f.client.forget(f.peer);
    await assert.rejects(f.client.test(f.peer), /unpaired/);
  } finally {
    await f.close();
  }
});

test("old HTTPS Hosts reject exact-ID sends before mutation while fuzzy sends retain their existing behavior", async () => {
  const f = await fixture((rpc) => {
    if (rpc.method === "zen/remote/hello")
      return {
        version: 1,
        hostId: rpc.params.hostId,
        processEpoch: "epoch-one",
        capabilities: [
          "workspaces",
          "threads",
          "create",
          "resume",
          "resumePage",
          "send",
          "models",
        ],
      };
  });
  try {
    await f.enrolled();
    for (const messageType of ["guidance", "follow_up", "replacement"]) {
      await assert.rejects(
        f.client.invoke(
          f.peer,
          request("zenx_threads_send", {
            threadId: "thread-full",
            text: "must not execute",
            messageType,
          }),
          signal(),
        ),
        /does not support archive-fenced.*Update the target Host/u,
      );
    }
    assert.equal(
      f.requests.filter((rpc) => rpc.method === "zen/remote/send").length,
      0,
    );
    await f.client.invoke(
      f.peer,
      request("zenx_threads_send", {
        target: "Remote task",
        text: "legacy fuzzy send",
      }),
      signal(),
    );
    assert.equal(
      f.requests.filter((rpc) => rpc.method === "zen/remote/send").length,
      1,
    );
  } finally {
    await f.close();
  }
});

test("TLS trust cannot be bypassed and self-signed Host fails without explicit fixture CA", async () => {
  const f = await fixture();
  try {
    const untrusted = new NativeFleetClient({ credentials: f.credentials });
    await assert.rejects(untrusted.pair(f.peer, "fresh-code"), /TLS/);
    assert.equal(f.pairCalls, 0);
    await f.enrolled();
    await assert.rejects(untrusted.test(f.peer), /TLS/);
    assert.equal(f.upgradeCalls, 0);
  } finally {
    await f.close();
  }
});

test("Fleet native routes projects/models/create/send and resolves only scoped unique targets", async () => {
  const f = await fixture();
  try {
    await f.enrolled();
    const router = new FleetRouter(
      async () => parseFleetConfig({ version: 1, devices: [f.peer] }),
      async () => {
        throw new Error("SSH used for HTTPS");
      },
      f.client,
    );
    assert.equal((await router.devices())[1]!.transport, "https");
    const projects: any = await f.client.invoke(
      f.peer,
      request("zenx_projects_list"),
      signal(),
    );
    assert.equal(projects.projects[0].project, "workspace-one");
    assert.equal(projects.projects[0].cwd, "workspace-one");
    const models: any = await f.client.invoke(
      f.peer,
      request("zenx_models_list"),
      signal(),
    );
    assert.equal(models.models[0].id, "p::m");
    const created: any = await f.client.invoke(
      f.peer,
      request("zenx_threads_create", {
        project: "Work",
        model: "p::m",
        effort: "high",
      }),
      signal(),
    );
    assert.equal(created.threadId, "created-thread");
    const sent: any = await f.client.invoke(
      f.peer,
      request("zenx_threads_send", { target: "Remote task", text: "hello" }),
      signal(),
    );
    assert.equal(sent.turnId, "new-turn");
    const rpc = f.requests.find((v) => v.method === "zen/remote/send")!;
    assert.equal(rpc.params.threadId, "thread-full");
    assert.equal(rpc.params.messageType, "guidance");
    assert.match(String(rpc.params.clientId), /^fleet:/);
    const missing: any = await f.client.invoke(
      f.peer,
      request("zenx_threads_send", { target: "no such", text: "hello" }),
      signal(),
    );
    assert.equal(missing.status, "not_found");
    assert.equal(
      f.requests.filter((v) => v.method === "zen/remote/send").length,
      1,
    );
    await assert.rejects(
      f.client.invoke(
        f.peer,
        request("zenx_threads_create", {
          cwd: "workspace-one",
          sandbox: "danger-full-access",
        }),
        signal(),
      ),
      /does not support option: sandbox/,
    );
    await assert.rejects(
      f.client.invoke(
        { ...f.peer, access: "read" },
        request("zenx_threads_send", { target: "thread-full", text: "hello" }),
        signal(),
      ),
      /read-only/,
    );
  } finally {
    await f.close();
  }
});

test("recovery assembles validated fragments and bounded history cursors are target-bound", async () => {
  const large = "large reply ".repeat(2000);
  const metadata = { ...message };
  delete (metadata as any).text;
  const f = await fixture((rpc) => {
    if (rpc.method === "zen/remote/resume")
      return {
        ...recovery(),
        entries: [
          {
            kind: "item",
            item: started,
            turn: { id: "turn-one", status: "completed" },
          },
          {
            kind: "text_fragment",
            item: metadata,
            offset: 0,
            text: large.slice(0, 12000),
            complete: false,
          },
        ],
        nextCursor: "page-two",
      };
    if (rpc.method === "zen/remote/resume/page") {
      assert.equal(rpc.params.cursor, "page-two");
      return {
        ...recovery(),
        entries: [
          {
            kind: "text_fragment",
            item: metadata,
            offset: 12000,
            text: large.slice(12000),
            complete: true,
          },
          { kind: "item", item: completed },
        ],
        nextCursor: null,
      };
    }
  });
  try {
    await f.enrolled();
    const first: any = await f.client.invoke(
      f.peer,
      request("zenx_threads_read", {
        target: "thread",
        granularity: "item",
        itemId: "reply",
      }),
      signal(),
    );
    let output = first.content,
      cursor = first.nextCursor;
    while (cursor) {
      const page: any = await f.client.invoke(
        f.peer,
        request("zenx_threads_read", {
          target: "thread-full",
          granularity: "item",
          itemId: "reply",
          cursor,
        }),
        signal(),
      );
      output += page.content;
      cursor = page.nextCursor;
    }
    assert.equal(JSON.parse(output).text, large);
    await assert.rejects(
      f.client.invoke(
        f.peer,
        request("zenx_threads_read", {
          target: "thread",
          granularity: "agent_messages",
          cursor: first.nextCursor,
        }),
        signal(),
      ),
      /Invalid Fleet cursor/,
    );
    const status: any = await f.client.invoke(
      f.peer,
      request("zenx_threads_status", { target: "thread-full" }),
      signal(),
    );
    assert.equal(status.lastTurn.status, "completed");
  } finally {
    await f.close();
  }
});

test("malformed fragment offsets and changed process epochs fail before exposing a partial snapshot", async () => {
  for (const changedEpoch of [false, true]) {
    const metadata = { ...message };
    delete (metadata as any).text;
    const f = await fixture((rpc) => {
      if (rpc.method === "zen/remote/resume")
        return {
          ...recovery(),
          entries: [
            {
              kind: "text_fragment",
              item: metadata,
              offset: 0,
              text: "abc",
              complete: false,
            },
          ],
          nextCursor: "second",
        };
      if (rpc.method === "zen/remote/resume/page")
        return {
          ...recovery(),
          processEpoch: changedEpoch ? "wrong-epoch" : "epoch-one",
          entries: [
            {
              kind: "text_fragment",
              item: metadata,
              offset: changedEpoch ? 3 : 2,
              text: "def",
              complete: true,
            },
          ],
          nextCursor: null,
        };
    });
    try {
      await f.enrolled();
      await assert.rejects(
        f.client.invoke(
          f.peer,
          request("zenx_threads_read", { target: "thread-full" }),
          signal(),
        ),
        /Invalid Fleet (fragment|recovery)/,
      );
    } finally {
      await f.close();
    }
  }
});

test("event-driven wait resyncs a watermark gap and confirms terminal state via canonical recovery", async () => {
  let resumes = 0;
  const f = await fixture((rpc, ws) => {
    if (rpc.method === "zen/remote/resume") {
      resumes++;
      if (resumes === 1) {
        setTimeout(() => {
          if (ws.readyState === WebSocket.OPEN)
            ws.send(
              JSON.stringify({
                method: "zen/remote/thread/event",
                params: {
                  processEpoch: "epoch-one",
                  threadId: "thread-full",
                  watermark: 2,
                  event: {
                    type: "turn_completed",
                    turnId: "turn-one",
                    status: "completed",
                  },
                },
              }),
            );
        }, 25);
        return recovery("inProgress", 0);
      }
      return recovery("completed", 2);
    }
  });
  try {
    await f.enrolled();
    const result = await f.client.watchTurn(
      f.peer,
      "workspace-one",
      "thread-full",
      "turn-one",
      signal(),
      undefined,
      1,
    );
    assert.equal(result.status, "completed");
    assert.equal(result.timedOut, false);
    assert.equal(resumes, 2);
  } finally {
    await f.close();
  }
});

test("wait never invents completion from another turn, times out honestly, and abort stays an abort", async () => {
  let resumes = 0;
  const f = await fixture((rpc, ws) => {
    if (rpc.method === "zen/remote/resume") {
      resumes++;
      if (resumes === 1)
        setTimeout(() => {
          if (ws.readyState === WebSocket.OPEN)
            ws.send(
              JSON.stringify({
                method: "zen/remote/thread/event",
                params: {
                  processEpoch: "epoch-one",
                  threadId: "thread-full",
                  watermark: 1,
                  event: {
                    type: "turn_completed",
                    turnId: "other-turn",
                    status: "completed",
                  },
                },
              }),
            );
        }, 20);
      return recovery("inProgress", resumes > 1 ? 1 : 0);
    }
  });
  try {
    await f.enrolled();
    const result = await f.client.watchTurn(
      f.peer,
      "workspace-one",
      "thread-full",
      "turn-one",
      signal(),
      () => assert.fail("Unrelated turn event leaked"),
      1,
    );
    assert.equal(result.status, "inProgress");
    assert.equal(result.timedOut, true);
    // An unrelated contiguous event advances only the fence; it does not poll.
    assert.equal(resumes, 1);
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error("user cancelled")), 30);
    await assert.rejects(
      f.client.watchTurn(
        f.peer,
        "workspace-one",
        "thread-full",
        "turn-one",
        controller.signal,
        undefined,
        1,
      ),
      /user cancelled/,
    );
  } finally {
    await f.close();
  }
});

test("unknown mutation admission is not retried and a confirmed remote rejection remains explicit", async () => {
  for (const rejected of [false, "operation_forbidden", "scope_refreshing"]) {
    const f = await fixture((rpc, ws) => {
      if (rpc.method === "zen/remote/send") {
        if (rejected)
          ws.send(
            JSON.stringify({
              id: rpc.id,
              error: {
                code: -32000,
                message: rejected,
                data: { code: rejected },
              },
            }),
          );
        else ws.terminate();
        return null;
      }
    });
    try {
      await f.enrolled();
      await assert.rejects(
        f.client.invoke(
          f.peer,
          request("zenx_threads_send", {
            target: "thread-full",
            text: "hello",
          }),
          signal(),
        ),
        (error: unknown) =>
          rejected
            ? error instanceof NativeFleetRejectedError &&
              error.code === rejected
            : error instanceof Error &&
              /admission may be unknown/.test(error.message),
      );
      assert.equal(
        f.requests.filter((rpc) => rpc.method === "zen/remote/send").length,
        1,
      );
    } finally {
      await f.close();
    }
  }
});

test("cancellation during a delayed TLS WebSocket handshake preserves the caller reason before any mutation", async () => {
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const f = await fixture(undefined, entered);
  const controller = new AbortController();
  const reason = new Error("user cancelled delayed handshake");
  try {
    await f.enrolled();
    const pending = f.client.invoke(
      f.peer,
      request("zenx_threads_send", {
        target: "thread-full",
        text: "must not admit",
      }),
      controller.signal,
    );
    const rejected = assert.rejects(pending, (error) => error === reason);
    await started;
    controller.abort(reason);
    await rejected;
    assert.equal(f.upgradeCalls, 1);
    assert.deepEqual(f.requests, []);
  } finally {
    controller.abort(reason);
    await f.close();
  }
});

test("ambiguous title cannot mutate and cancellation during vault read prevents admission", async () => {
  const f = await fixture((rpc) => {
    if (rpc.method === "zen/remote/threads")
      return {
        threads: [
          { threadId: "one", name: "Duplicate", status: "idle" },
          { threadId: "two", name: "Duplicate", status: "idle" },
        ],
      };
  });
  try {
    await f.enrolled();
    const result: any = await f.client.invoke(
      f.peer,
      request("zenx_threads_send", { target: "Duplicate", text: "hello" }),
      signal(),
    );
    assert.equal(result.status, "ambiguous");
    assert.equal(result.candidates.length, 2);
    assert.ok(!f.requests.some((rpc) => rpc.method === "zen/remote/send"));
    const controller = new AbortController();
    const client = new NativeFleetClient({
      ca: cert,
      credentials: {
        ...f.credentials,
        get: async (id) => {
          controller.abort();
          return await f.credentials.get(id);
        },
      },
    });
    const connections = f.upgradeCalls;
    await assert.rejects(
      client.invoke(
        f.peer,
        request("zenx_threads_send", { target: "one", text: "hello" }),
        controller.signal,
      ),
    );
    assert.equal(f.upgradeCalls, connections);
  } finally {
    await f.close();
  }
});

test("stream subscription suppresses old terminals, canonical-confirms new completion, and stops without reconnect", async () => {
  let resumes = 0;
  const nextStart = { ...started, id: "start-two", turnId: "turn-two" };
  const nextComplete = { ...completed, id: "complete-two", turnId: "turn-two" };
  const f = await fixture((rpc, ws) => {
    if (rpc.method === "zen/remote/resume") {
      resumes++;
      if (resumes === 1) {
        setTimeout(() => {
          if (ws.readyState !== WebSocket.OPEN) return;
          ws.send(
            JSON.stringify({
              method: "zen/remote/thread/event",
              params: {
                processEpoch: "epoch-one",
                threadId: "thread-full",
                watermark: 3,
                event: { type: "turn_started", turnId: "turn-two" },
              },
            }),
          );
          ws.send(
            JSON.stringify({
              method: "zen/remote/thread/event",
              params: {
                processEpoch: "epoch-one",
                threadId: "thread-full",
                watermark: 4,
                event: {
                  type: "turn_completed",
                  turnId: "turn-two",
                  status: "completed",
                },
              },
            }),
          );
        }, 20);
        return recovery("completed", 2);
      }
      return {
        ...recovery("completed", 4),
        entries: [
          ...recovery().entries,
          {
            kind: "item",
            item: nextStart,
            turn: { id: "turn-two", status: "completed" },
          },
          { kind: "item", item: nextComplete },
        ],
      };
    }
  });
  let stop: (() => void) | undefined;
  try {
    await f.enrolled();
    const emitted: unknown[] = [];
    let resolve!: () => void;
    const done = new Promise<void>((r) => {
      resolve = r;
    });
    const guard = setTimeout(() => resolve(), 1000);
    stop = await f.client.subscribeThread(
      f.peer,
      undefined,
      "Remote task",
      {
        onTurn: (turn) => {
          emitted.push(turn);
          resolve();
        },
        onError: (error) => assert.fail(error.message),
      },
      signal(),
    );
    await done;
    clearTimeout(guard);
    assert.deepEqual(emitted, [
      { threadId: "thread-full", turnId: "turn-two", status: "completed" },
    ]);
    assert.equal(resumes, 2);
    stop();
    stop = undefined;
    const connected = f.upgradeCalls;
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(f.upgradeCalls, connected);
  } finally {
    stop?.();
    await f.close();
  }
});

test("stream reconnect recovers a previously observed active Turn without replaying other history", async () => {
  let resumes = 0;
  const f = await fixture((rpc, ws) => {
    if (rpc.method === "zen/remote/resume") {
      resumes++;
      if (resumes === 1) {
        setTimeout(() => ws.terminate(), 20);
        return recovery("inProgress", 0);
      }
      return { ...recovery("completed", 2), processEpoch: "epoch-two" };
    }
    if (rpc.method === "zen/remote/hello")
      return {
        version: 1,
        hostId: "host-one",
        processEpoch: resumes ? "epoch-two" : "epoch-one",
        capabilities: ["workspaces", "threads", "resume"],
      };
  });
  let stop: (() => void) | undefined;
  try {
    await f.enrolled();
    const emitted: unknown[] = [],
      errors: string[] = [];
    let resolve!: () => void;
    const done = new Promise<void>((r) => {
      resolve = r;
    });
    const guard = setTimeout(() => resolve(), 4000);
    stop = await f.client.subscribeThread(
      f.peer,
      undefined,
      "thread-full",
      {
        onTurn: (turn) => {
          emitted.push(turn);
          resolve();
        },
        onError: (error) => errors.push(error.message),
      },
      signal(),
    );
    await done;
    clearTimeout(guard);
    assert.deepEqual(emitted, [
      { threadId: "thread-full", turnId: "turn-one", status: "completed" },
    ]);
    assert.equal(resumes, 2);
    assert.equal(errors.length, 1);
    assert.match(errors[0]!, /disconnected/);
    assert.equal(f.upgradeCalls, 2);
  } finally {
    stop?.();
    await f.close();
  }
});

test("stream current-terminal opt-in emits one snapshot completion and revocation never reconnects", async () => {
  const f = await fixture((rpc, ws) => {
    if (rpc.method === "zen/remote/resume") {
      setTimeout(() => ws.close(4003, "revoked"), 20);
      return recovery();
    }
  });
  let stop: (() => void) | undefined;
  try {
    await f.enrolled();
    const emitted: unknown[] = [],
      errors: string[] = [];
    let resolve!: () => void;
    const done = new Promise<void>((r) => {
      resolve = r;
    });
    const guard = setTimeout(() => resolve(), 1000);
    stop = await f.client.subscribeThread(
      f.peer,
      "Work",
      "thread-full",
      {
        includeCurrentTerminal: true,
        onTurn: (turn) => emitted.push(turn),
        onError: (error) => {
          errors.push(error.message);
          resolve();
        },
      },
      signal(),
    );
    await done;
    clearTimeout(guard);
    assert.deepEqual(emitted, [
      { threadId: "thread-full", turnId: "turn-one", status: "completed" },
    ]);
    assert.equal(errors.length, 1);
    assert.match(errors[0]!, /revoked/);
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(f.upgradeCalls, 1);
  } finally {
    stop?.();
    await f.close();
  }
});

test("disabled hosting allows empty bounded TLS paths and normalizes a non-secret relay authority", () => {
  const hosting = {
    enabled: false,
    bindAddress: "127.0.0.1",
    port: 9433,
    tlsCertificateFile: "",
    tlsKeyFile: "",
    relayEndpoint: "https://Relay.example:443/",
    access: "read",
  };
  const config = parseFleetConfig({ version: 1, devices: [], hosting });
  assert.equal(config.hosting!.relayEndpoint, "https://relay.example");
  assert.throws(() =>
    parseFleetConfig({
      version: 1,
      devices: [],
      hosting: { ...hosting, enabled: true },
    }),
  );
  assert.throws(() =>
    parseFleetConfig({
      version: 1,
      devices: [],
      hosting: { ...hosting, tlsKeyFile: "\u0000" },
    }),
  );
  assert.throws(() =>
    parseFleetConfig({
      version: 1,
      devices: [],
      hosting: {
        ...hosting,
        relayEndpoint: "https://relay.example/?token=secret",
      },
    }),
  );
  assert.throws(() =>
    parseFleetConfig({
      version: 1,
      devices: [],
      hosting: { ...hosting, relayRegistrationToken: "secret" },
    }),
  );
});

test("real native Host create/send/wait/read shares canonical history and durable grants survive Host restart", async () => {
  const dir = await mkdtemp(path.join(directory, "host-"));
  const host = createHostedAppServer({
    cwd: dir,
    dataDirectory: path.join(dir, "data"),
    model: "fake",
    provider: { type: "fake" },
    journal: new InMemoryThreadJournal(),
    approvalPolicy: "never",
  });
  const grantFile = path.join(dir, "grants.json");
  const workspaces = () => [{ id: "work", cwd: dir, label: "Work" }];
  let access = new RemoteHostAccess({
    appServer: host,
    hostId: "durable-host",
    grantFile,
    access: "control",
    workspaces,
  });
  let server = await serveRemoteHost({
    enabled: true,
    listen: "127.0.0.1",
    port: 0,
    tls: { cert, key },
    access,
  });
  const endpointUrl = new URL(server.url);
  endpointUrl.protocol = "https:";
  const endpoint = endpointUrl.origin;
  const vault = new Map<string, NativeFleetCredential>();
  const credentials: NativeFleetCredentialStore = {
    get: async (id) => vault.get(id) ?? null,
    set: async (id, value) => {
      vault.set(id, value);
    },
    delete: async (id) => {
      vault.delete(id);
    },
  };
  const peer: NativeFleetDevice = {
    id: "durable",
    label: "Durable",
    transport: "https",
    endpoint,
    hostId: "durable-host",
    access: "control",
    workspace: "work",
  };
  const client = new NativeFleetClient({ credentials, ca: cert });
  try {
    await client.pair(peer, access.createPairingCode());
    const created: any = await client.invoke(
      peer,
      request("zenx_threads_create", { project: "work" }),
      signal(),
    );
    const sent: any = await client.invoke(
      peer,
      request("zenx_threads_send", {
        target: created.threadId,
        text: "Say hello to native Fleet",
      }),
      signal(),
    );
    assert.ok(sent.turnId);
    const terminal = await client.watchTurn(
      peer,
      "work",
      created.threadId,
      sent.turnId,
      signal(),
      undefined,
      1,
    );
    assert.equal(terminal.timedOut, false);
    assert.equal(terminal.status, "completed");
    const read: any = await client.invoke(
      peer,
      request("zenx_threads_read", {
        target: created.threadId,
        granularity: "agent_messages",
      }),
      signal(),
    );
    const canonical = await host.readThread(created.threadId);
    const canonicalReplies = canonical.items.filter(
      (item) => item.type === "agent_message",
    );
    assert.equal(read.items.length, canonicalReplies.length);
    assert.ok(read.items.length > 0);
    assert.equal(read.items[0].id, canonicalReplies[0]!.id);
    const grantText = await readFile(grantFile, "utf8");
    assert.ok(!grantText.includes(vault.get(peer.id)!.token));
    const firstEpoch = (await client.test(peer)).processEpoch;
    await server.close();
    access.close();
    access = new RemoteHostAccess({
      appServer: host,
      hostId: "durable-host",
      grantFile,
      access: "control",
      workspaces,
    });
    server = await serveRemoteHost({
      enabled: true,
      listen: "127.0.0.1",
      port: Number(endpointUrl.port),
      tls: { cert, key },
      access,
    });
    const restarted = new NativeFleetClient({ credentials, ca: cert });
    const connected = await restarted.test(peer);
    assert.equal(connected.status, "connected");
    assert.notEqual(connected.processEpoch, firstEpoch);
    const status: any = await restarted.invoke(
      peer,
      request("zenx_threads_status", { target: created.threadId }),
      signal(),
    );
    assert.equal(status.lastTurn.turnId, sent.turnId);
    assert.equal(status.lastTurn.status, "completed");
  } finally {
    await server.close();
    access.close();
    await host.closeHostResources();
  }
});

test("an initially offline stream remains registered and onReady clears the transient state after recovery", async () => {
  let hellos = 0;
  const f = await fixture((rpc, ws) => {
    if (rpc.method === "zen/remote/hello" && ++hellos === 1) {
      ws.terminate();
      return null;
    }
    if (rpc.method === "zen/remote/resume") return recovery("inProgress", 0);
  });
  let stop: (() => void) | undefined;
  try {
    await f.enrolled();
    const errors: string[] = [];
    let ready = 0;
    let resolve!: () => void;
    const done = new Promise<void>((r) => {
      resolve = r;
    });
    const guard = setTimeout(resolve, 4000);
    stop = await f.client.subscribeThread(
      f.peer,
      undefined,
      "thread-full",
      {
        onTurn: () => assert.fail("Historic turn emitted"),
        onError: (error) => errors.push(error.message),
        onReady: () => {
          ready++;
          resolve();
        },
      },
      signal(),
    );
    assert.equal(ready, 0);
    assert.equal(errors.length, 1);
    assert.equal(typeof stop, "function");
    await done;
    clearTimeout(guard);
    assert.equal(ready, 1);
    assert.equal(f.upgradeCalls, 2);
    assert.equal(errors.length, 1);
  } finally {
    stop?.();
    await f.close();
  }
});
