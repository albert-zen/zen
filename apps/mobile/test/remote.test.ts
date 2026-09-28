import { test } from "node:test";
import assert from "node:assert/strict";
import { RemoteHostTransport } from "../src/remote-core";
import { REMOTE_METHODS } from "../../../src/protocol/native/remote-wire";
class Socket {
  static OPEN = 1;
  readyState = 1;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  requests: any[] = [];
  constructor(private readonly reply: (request: any, socket: Socket) => any) {
    queueMicrotask(() => this.onopen?.());
  }
  send(raw: string) {
    const request = JSON.parse(raw);
    this.requests.push(request);
    queueMicrotask(() => {
      const answer = this.reply(request, this);
      if (answer !== undefined)
        this.onmessage?.({
          data: JSON.stringify({ id: request.id, result: answer }),
        });
    });
  }
  notify(event: any) {
    this.onmessage?.({
      data: JSON.stringify({ method: REMOTE_METHODS.event, params: event }),
    });
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
}
const host = {
  id: "host-test123",
  name: "Demo",
  endpoint: "https://localhost:4321",
};
function setup(reply: (request: any, socket: Socket) => any) {
  const secrets = new Map<string, string>();
  let socket: Socket;
  let uuid = 0;
  const urls: string[] = [];
  const headers: Record<string, string>[] = [];
  const transport = new RemoteHostTransport(() => [host], {
    getSecret: async (key) => secrets.get(key) ?? null,
    setSecret: async (key, value) => {
      secrets.set(key, value);
    },
    deleteSecret: async (key) => {
      secrets.delete(key);
    },
    uuid: () => `uuid-${++uuid}`,
    fetch: (async (url: string) => {
      urls.push(url);
      return {
        ok: true,
        json: async () => ({
          hostId: host.id,
          deviceId: `uuid-${uuid}`,
          token: "secret-token",
        }),
      };
    }) as typeof fetch,
    openSocket: (_url, h) => {
      headers.push(h);
      socket = new Socket(reply);
      return socket as unknown as WebSocket;
    },
  });
  return { transport, secrets, urls, headers, socket: () => socket! };
}
const response = (request: any) => {
  switch (request.method) {
    case REMOTE_METHODS.hello:
      return { hostId: host.id, version: 0, processEpoch: "e1" };
    case REMOTE_METHODS.workspaces:
      return { workspaces: [{ id: "w", label: "Workspace" }] };
    case REMOTE_METHODS.threads:
      return { threads: [{ threadId: "t", status: "active" }] };
    case REMOTE_METHODS.resume:
      return {
        processEpoch: "e1",
        watermark: 2,
        threadId: "t",
        events: [],
        thread: {
          id: "t",
          archived: false,
          items: [
            {
              id: "i1",
              threadId: "t",
              createdAt: "now",
              type: "agent_message",
              text: "hello",
            },
          ],
          turns: [{ id: "turn1", status: "inProgress" }],
        },
      };
    case REMOTE_METHODS.send:
      return { turnId: "turn2" };
    case REMOTE_METHODS.interrupt:
      return {};
  }
};
test("pair requires Host match, stores credential only in secure store, hello verifies identity and sends fenced commands", async () => {
  const s = setup(response);
  await s.transport.pair(host.id, "one-use-code");
  assert.deepEqual(s.urls, ["https://localhost:4321/pair"]);
  const value = [...s.secrets.values()][0]!;
  assert.equal(JSON.parse(value).token, "secret-token");
  assert.equal(
    (await s.transport.snapshot(host.id, null)).workspaces[0]?.name,
    "Workspace",
  );
  assert.equal(s.headers[0]?.Authorization, "Bearer secret-token");
  await s.transport.snapshot(host.id, "w");
  assert.equal((await s.transport.read(host.id, "w", "t"))[0]?.text, "hello");
  assert.deepEqual(
    await s.transport.command(host.id, "w", "send", {
      threadId: "t",
      text: "hello",
    }),
    { accepted: true },
  );
  assert.deepEqual(
    await s.transport.command(host.id, "w", "stop", { threadId: "t" }),
    { accepted: true },
  );
  const requests = s.socket().requests;
  assert.deepEqual(
    requests.find((r) => r.method === REMOTE_METHODS.send)?.params,
    { workspaceId: "w", threadId: "t", clientId: "uuid-2", text: "hello" },
  );
  assert.equal(
    requests.find((r) => r.method === REMOTE_METHODS.interrupt)?.params
      .expectedTurnId,
    "turn1",
  );
  s.transport.disconnect();
  assert.equal(s.headers[0]?.Authorization, "Bearer secret-token");
});
test("wrong Host hello and stale identity cannot show threads", async () => {
  const s = setup((request) =>
    request.method === REMOTE_METHODS.hello
      ? { hostId: "imposter", version: 0, processEpoch: "e1" }
      : response(request),
  );
  await s.transport.pair(host.id, "code");
  await assert.rejects(s.transport.snapshot(host.id, null), /Wrong Host/);
});
test("event watermark gap and epoch change re-resume without copying tool content", async () => {
  let epoch = "e1",
    watermark = 2;
  const s = setup((request) =>
    request.method === REMOTE_METHODS.resume
      ? { ...response(request), processEpoch: epoch, watermark }
      : response(request),
  );
  await s.transport.pair(host.id, "code");
  await s.transport.snapshot(host.id, "w");
  const notifications: any[] = [];
  s.transport.subscribe(host.id, "w", (event) => notifications.push(event));
  await s.transport.read(host.id, "w", "t");
  watermark = 5;
  s.socket().notify({
    processEpoch: "e1",
    watermark: 5,
    threadId: "t",
    event: { type: "redacted" },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    s.socket().requests.filter((r) => r.method === REMOTE_METHODS.resume)
      .length,
    2,
  );
  epoch = "e2";
  watermark = 1;
  s.socket().notify({
    processEpoch: "e2",
    watermark: 1,
    threadId: "t",
    event: { type: "redacted" },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    s.socket().requests.filter((r) => r.method === REMOTE_METHODS.resume)
      .length,
    3,
  );
  assert.equal(notifications.at(-1)?.items.t[0]?.text, "hello");
});

test("pairing interrupted by a device switch never persists an obsolete grant", async () => {
  let finish!: (result: any) => void;
  const secrets = new Map<string, string>();
  const transport = new RemoteHostTransport(() => [host], {
    getSecret: async (key) => secrets.get(key) ?? null,
    setSecret: async (key, value) => {
      secrets.set(key, value);
    },
    deleteSecret: async (key) => {
      secrets.delete(key);
    },
    uuid: () => "phone-1",
    fetch: (() =>
      new Promise((resolve) => {
        finish = resolve;
      })) as typeof fetch,
    openSocket: () => {
      throw Error("not expected");
    },
  });
  const pending = transport.pair(host.id, "code");
  await new Promise((resolve) => setImmediate(resolve));
  transport.disconnect();
  finish({
    ok: true,
    json: async () => ({
      hostId: host.id,
      deviceId: "phone-1",
      token: "do-not-save",
    }),
  });
  await assert.rejects(pending, /Selection changed/);
  assert.equal(secrets.size, 0);
});
