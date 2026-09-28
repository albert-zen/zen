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
      return { hostId: host.id, version: 1, processEpoch: "e1" };
    case REMOTE_METHODS.workspaces:
      return { workspaces: [{ id: "w", label: "Workspace" }] };
    case REMOTE_METHODS.threads:
      return { threads: [{ threadId: "t", status: "active" }] };
    case REMOTE_METHODS.resume:
      return {
        processEpoch: "e1",
        watermark: 2,
        threadId: "t",
        thread: { id: "t", archived: false },
        nextCursor: null,
        entries: [
          {
            kind: "item",
            item: {
              id: "start",
              threadId: "t",
              createdAt: "now",
              type: "turn_started",
            },
            turn: { id: "turn1", status: "inProgress" },
          },
          {
            kind: "item",
            item: {
              id: "i1",
              threadId: "t",
              createdAt: "now",
              type: "agent_message",
              text: "hello",
            },
          },
        ],
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
  assert.equal((await s.transport.read(host.id, "w", "t"))[1]?.text, "hello");
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
      ? { hostId: "imposter", version: 1, processEpoch: "e1" }
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
  assert.equal(notifications.at(-1)?.items.t[1]?.text, "hello");
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

test("v1 recovery concatenates >2 MiB text across pages, no partial success or duplicate Item", async () => {
  const text = "ab🙂".repeat(550000); // 2.2M UTF-16 code units, larger than old frame cap.
  const parts = Array.from({ length: Math.ceil(text.length / 80000) }, (_, i) =>
    text.slice(i * 80000, (i + 1) * 80000),
  );
  let position = 0;
  const s = setup((request) => {
    if (
      request.method === REMOTE_METHODS.resume ||
      request.method === REMOTE_METHODS.resumePage
    ) {
      const n = position++;
      const item = {
        id: "huge",
        threadId: "t",
        createdAt: "now",
        type: "agent_message",
      };
      return {
        processEpoch: "e1",
        threadId: "t",
        watermark: 0,
        thread: { id: "t", archived: false },
        entries: [
          {
            kind: "text_fragment",
            item,
            offset: n * 80000,
            text: parts[n],
            complete: n === parts.length - 1,
          },
        ],
        nextCursor: n === parts.length - 1 ? null : `cursor-${n}`,
      };
    }
    return response(request);
  });
  await s.transport.pair(host.id, "code");
  await s.transport.snapshot(host.id, "w");
  const items = await s.transport.read(host.id, "w", "t");
  assert.equal(items.length, 1);
  assert.equal(items[0]?.text, text);
  assert.equal(position, parts.length);
  assert.deepEqual(
    await s.transport.command(host.id, "w", "send", {
      threadId: "t",
      text: "next",
    }),
    { accepted: true },
  );
});
test("v1 reset during pagination discards partial pages and starts a fresh resume", async () => {
  let attempt = 0;
  const s = setup((request, socket) => {
    if (request.method === REMOTE_METHODS.resume) {
      attempt++;
      return {
        processEpoch: attempt === 1 ? "e1" : "e2",
        threadId: "t",
        watermark: 0,
        thread: { id: "t", archived: false },
        entries: [],
        nextCursor: attempt === 1 ? "first" : null,
      };
    }
    if (request.method === REMOTE_METHODS.resumePage) {
      socket.onmessage?.({
        data: JSON.stringify({
          method: REMOTE_METHODS.reset,
          params: { threadId: "t", reason: "resync_required" },
        }),
      });
      return {
        processEpoch: "e1",
        threadId: "t",
        watermark: 0,
        thread: { id: "t", archived: false },
        entries: [],
        nextCursor: null,
      };
    }
    return response(request);
  });
  await s.transport.pair(host.id, "code");
  await s.transport.snapshot(host.id, "w");
  await assert.rejects(s.transport.read(host.id, "w", "t"), /incomplete/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(attempt, 2);
});

test("live event arriving between recovery pages is replayed once after terminal cursor", async () => {
  let pageCount = 0;
  const s = setup((request, socket) => {
    if (request.method === REMOTE_METHODS.resume)
      return {
        processEpoch: "e1",
        threadId: "t",
        watermark: 0,
        thread: { id: "t", archived: false },
        entries: [
          {
            kind: "item",
            item: {
              id: "old",
              threadId: "t",
              createdAt: "now",
              type: "agent_message",
              text: "before",
            },
          },
        ],
        nextCursor: "page2",
      };
    if (request.method === REMOTE_METHODS.resumePage) {
      pageCount++;
      socket.notify({
        processEpoch: "e1",
        watermark: 1,
        threadId: "t",
        event: {
          type: "item_completed",
          item: {
            id: "new",
            threadId: "t",
            createdAt: "later",
            type: "agent_message",
            text: "after",
          },
        },
      });
      return {
        processEpoch: "e1",
        threadId: "t",
        watermark: 0,
        thread: { id: "t", archived: false },
        entries: [],
        nextCursor: null,
      };
    }
    return response(request);
  });
  await s.transport.pair(host.id, "code");
  await s.transport.snapshot(host.id, "w");
  const events: any[] = [];
  s.transport.subscribe(host.id, "w", (e) => events.push(e));
  const result = await s.transport.read(host.id, "w", "t");
  assert.equal(pageCount, 1);
  assert.deepEqual(
    result.map((item) => item.text),
    ["before", "after"],
  );
  assert.deepEqual(
    events.at(-1)?.items.t.map((item: any) => item.id),
    ["old", "new"],
  );
});

test("stale page cursor discards partial text and issues one fresh v1 resume", async () => {
  let attempts = 0;
  const s = setup((request, socket) => {
    if (request.method === REMOTE_METHODS.resume) {
      attempts++;
      return {
        processEpoch: "e1",
        threadId: "t",
        watermark: attempts,
        thread: { id: "t", archived: false },
        entries: [
          {
            kind: "item",
            item: {
              id: attempts === 1 ? "partial" : "fresh",
              threadId: "t",
              createdAt: "now",
              type: "agent_message",
              text: attempts === 1 ? "discard" : "authoritative",
            },
          },
        ],
        nextCursor: attempts === 1 ? "lost" : null,
      };
    }
    if (request.method === REMOTE_METHODS.resumePage) {
      socket.onmessage?.({
        data: JSON.stringify({
          id: request.id,
          error: { message: "stale cursor", data: { code: "stale_cursor" } },
        }),
      });
      return undefined;
    }
    return response(request);
  });
  await s.transport.pair(host.id, "code");
  await s.transport.snapshot(host.id, "w");
  const events: any[] = [];
  s.transport.subscribe(host.id, "w", (event) => events.push(event));
  await assert.rejects(s.transport.read(host.id, "w", "t"), /stale_cursor/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(attempts, 2);
  assert.deepEqual(
    events.at(-1)?.items.t.map((item: any) => item.text),
    ["authoritative"],
  );
  assert.equal(
    s
      .socket()
      .requests.filter((request) => request.method === REMOTE_METHODS.resume)
      .length,
    2,
  );
});

test("scope reset while paging never exposes partial page; regrant requires new resume", async () => {
  let granted = true,
    resumes = 0;
  const s = setup((request, socket) => {
    if (request.method === REMOTE_METHODS.resume) {
      resumes++;
      if (!granted) {
        socket.onmessage?.({
          data: JSON.stringify({
            id: request.id,
            error: {
              message: "workspace revoked",
              data: { code: "wrong_workspace" },
            },
          }),
        });
        return undefined;
      }
      return {
        processEpoch: "e1",
        threadId: "t",
        watermark: 0,
        thread: { id: "t", archived: false },
        entries: [
          {
            kind: "item",
            item: {
              id: "visible",
              threadId: "t",
              createdAt: "now",
              type: "agent_message",
              text: "permitted",
            },
          },
        ],
        nextCursor: resumes === 1 ? "pending" : null,
      };
    }
    if (request.method === REMOTE_METHODS.resumePage) {
      granted = false;
      socket.onmessage?.({
        data: JSON.stringify({
          method: REMOTE_METHODS.reset,
          params: { threadId: "t", reason: "resync_required" },
        }),
      });
      socket.onmessage?.({
        data: JSON.stringify({
          id: request.id,
          error: {
            message: "cursor invalidated",
            data: { code: "stale_cursor" },
          },
        }),
      });
      return undefined;
    }
    return response(request);
  });
  await s.transport.pair(host.id, "code");
  await s.transport.snapshot(host.id, "w");
  const events: any[] = [];
  s.transport.subscribe(host.id, "w", (event) => events.push(event));
  await assert.rejects(s.transport.read(host.id, "w", "t"), /stale_cursor/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(events.some((e) => e.type === "resync"));
  assert.ok(
    !events.some(
      (e) =>
        e.type === "snapshot" &&
        e.items.t?.some((item: any) => item.text === "permitted"),
    ),
  );
  assert.deepEqual(
    await s.transport.command(host.id, "w", "send", {
      threadId: "t",
      text: "forbidden",
    }),
    {
      accepted: false,
      error: "Open a Thread and verify its current Turn first.",
    },
  );
  granted = true;
  assert.equal(
    (await s.transport.read(host.id, "w", "t"))[0]?.text,
    "permitted",
  );
  assert.equal(resumes, 3);
});

test("old in-flight page and old subscription callback cannot overwrite newer Thread resume", async () => {
  let oldPageId: number | null = null;
  const s = setup((request) => {
    if (request.method === REMOTE_METHODS.resume) {
      const threadId = request.params.threadId;
      return {
        processEpoch: "e1",
        threadId,
        watermark: 0,
        thread: { id: threadId, archived: false },
        entries: [
          {
            kind: "item",
            item: {
              id: threadId + "-item",
              threadId,
              createdAt: "now",
              type: "agent_message",
              text: threadId,
            },
          },
        ],
        nextCursor: threadId === "t" ? "old" : null,
      };
    }
    if (request.method === REMOTE_METHODS.resumePage) {
      oldPageId = request.id;
      return undefined;
    }
    return response(request);
  });
  await s.transport.pair(host.id, "code");
  await s.transport.snapshot(host.id, "w");
  const events: any[] = [];
  s.transport.subscribe(host.id, "w", (event) => events.push(event));
  const oldRead = s.transport.read(host.id, "w", "t");
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(oldPageId !== null);
  await assert.rejects(s.transport.read(host.id, "w", "t2"), /incomplete/);
  s.socket().onmessage?.({
    data: JSON.stringify({
      id: oldPageId,
      error: { message: "old cursor", data: { code: "stale_cursor" } },
    }),
  });
  await oldRead.catch(() => {});
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(events.at(-1)?.items.t2[0]?.text, "t2");
  s.socket().onmessage?.({
    data: JSON.stringify({
      method: REMOTE_METHODS.reset,
      params: { threadId: "t", reason: "resync_required" },
    }),
  });
  s.socket().notify({
    processEpoch: "e1",
    watermark: 1,
    threadId: "t",
    event: {
      type: "item_completed",
      item: {
        id: "old",
        threadId: "t",
        createdAt: "now",
        type: "agent_message",
        text: "old",
      },
    },
  });
  assert.equal(events.at(-1)?.items.t2[0]?.text, "t2");
  assert.equal(
    s
      .socket()
      .requests.filter((request) => request.method === REMOTE_METHODS.resume)
      .length,
    2,
  );
});

test("repeated stale cursor retry is bounded, never marked synchronized", async () => {
  let resumes = 0;
  const s = setup((request, socket) => {
    if (request.method === REMOTE_METHODS.resume) {
      resumes++;
      return {
        processEpoch: "e1",
        threadId: "t",
        watermark: 0,
        thread: { id: "t", archived: false },
        entries: [],
        nextCursor: `lost-${resumes}`,
      };
    }
    if (request.method === REMOTE_METHODS.resumePage) {
      socket.onmessage?.({
        data: JSON.stringify({
          id: request.id,
          error: { message: "stale", data: { code: "stale_cursor" } },
        }),
      });
      return undefined;
    }
    return response(request);
  });
  await s.transport.pair(host.id, "code");
  await s.transport.snapshot(host.id, "w");
  await assert.rejects(s.transport.read(host.id, "w", "t"), /stale_cursor/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(resumes, 2);
  assert.deepEqual(
    await s.transport.command(host.id, "w", "send", {
      threadId: "t",
      text: "must not send",
    }),
    {
      accepted: false,
      error: "Open a Thread and verify its current Turn first.",
    },
  );
});
