import { test } from "node:test";
import assert from "node:assert/strict";
import { RemoteHostTransport } from "../src/remote-core";
import { REMOTE_METHODS } from "../../../src/protocol/native/remote-wire";
class Socket {
  static OPEN = 1;
  readyState = 1;
  onopen: (() => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
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
  close(code = 1000) {
    this.readyState = 3;
    this.onclose?.({ code });
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
    { accepted: true, turnId: "turn2" },
  );
  assert.deepEqual(
    await s.transport.command(host.id, "w", "stop", { threadId: "t" }),
    { accepted: true, turnId: "turn1" },
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
    { accepted: true, turnId: "turn2" },
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

test("close 4003 clears live projection and grant use; ordinary close clears projection but allows reconnect", async () => {
  const s = setup(response);
  await s.transport.pair(host.id, "code");
  await s.transport.snapshot(host.id, "w");
  const events: any[] = [];
  s.transport.subscribe(host.id, "w", (event) => events.push(event));
  await s.transport.read(host.id, "w", "t");
  assert.ok(events.at(-1)?.items.t.length);
  s.socket().close();
  assert.deepEqual(events.at(-1), { type: "offline", revoked: false });
  await s.transport.snapshot(host.id, "w");
  s.transport.subscribe(host.id, "w", (event) => events.push(event));
  await s.transport.read(host.id, "w", "t");
  s.socket().close(4003);
  assert.deepEqual(events.at(-1), { type: "offline", revoked: true });
  await assert.rejects(
    s.transport.snapshot(host.id, "w"),
    /revoked.*Pair again/,
  );
  await s.transport.pair(host.id, "new code");
  await s.transport.snapshot(host.id, "w");
  assert.equal((await s.transport.read(host.id, "w", "t"))[1]?.text, "hello");
});
test("Turn failed/completed/interrupted canonical status survives resume and live events; ack is only admission", async () => {
  const s = setup((request) =>
    request.method === REMOTE_METHODS.resume
      ? {
          processEpoch: "e1",
          threadId: "t",
          watermark: 1,
          thread: { id: "t", archived: false },
          nextCursor: null,
          entries: [
            {
              kind: "item",
              item: {
                id: "u",
                type: "user_message",
                threadId: "t",
                createdAt: "now",
                text: "prompt",
              },
              turn: { id: "turn-f", status: "failed" },
            },
            {
              kind: "item",
              item: {
                id: "ended",
                type: "turn_completed",
                threadId: "t",
                createdAt: "now",
                turnId: "turn-f",
              },
              turn: { id: "turn-f", status: "failed" },
            },
            {
              kind: "item",
              item: {
                id: "done",
                type: "agent_message",
                threadId: "t",
                createdAt: "now",
                text: "done",
              },
              turn: { id: "turn-c", status: "completed" },
            },
            {
              kind: "item",
              item: {
                id: "halted",
                type: "turn_aborted",
                threadId: "t",
                createdAt: "now",
                turnId: "turn-i",
              },
              turn: { id: "turn-i", status: "interrupted" },
            },
            {
              kind: "item",
              item: {
                id: "active",
                type: "user_message",
                threadId: "t",
                createdAt: "now",
                text: "active",
              },
              turn: { id: "turn1", status: "inProgress" },
            },
          ],
        }
      : response(request),
  );
  await s.transport.pair(host.id, "code");
  await s.transport.snapshot(host.id, "w");
  const seen: any[] = [];
  s.transport.subscribe(host.id, "w", (e) => seen.push(e));
  await s.transport.read(host.id, "w", "t");
  assert.deepEqual(seen.at(-1).turns.t, [
    { id: "turn-f", status: "failed" },
    { id: "turn-c", status: "completed" },
    { id: "turn-i", status: "interrupted" },
    { id: "turn1", status: "inProgress" },
  ]);
  assert.equal(
    seen.at(-1).items.t.find((i: any) => i.id === "ended").status,
    "recorded",
  );
  assert.deepEqual(
    await s.transport.command(host.id, "w", "stop", { threadId: "t" }),
    { accepted: true, turnId: "turn1" },
  );
  assert.equal(
    seen.at(-1).turns.t.at(-1).status,
    "inProgress",
    "stop ack is not terminal",
  );
  s.socket().notify({
    threadId: "t",
    processEpoch: "e1",
    watermark: 2,
    event: { type: "turn_completed", turnId: "turn1", status: "interrupted" },
  });
  assert.equal(seen.at(-1).turns.t.at(-1).status, "interrupted");
  s.socket().notify({
    threadId: "t",
    processEpoch: "e1",
    watermark: 3,
    event: { type: "turn_started", turnId: "turn2" },
  });
  s.socket().notify({
    threadId: "t",
    processEpoch: "e1",
    watermark: 4,
    event: { type: "turn_completed", turnId: "turn2", status: "failed" },
  });
  assert.equal(seen.at(-1).turns.t.at(-1).status, "failed");
});
test("socket error without close event invalidates projected body and reports offline", async () => {
  const s = setup(response);
  await s.transport.pair(host.id, "code");
  await s.transport.snapshot(host.id, "w");
  const events: any[] = [];
  s.transport.subscribe(host.id, "w", (e) => events.push(e));
  await s.transport.read(host.id, "w", "t");
  s.socket().onerror?.();
  assert.deepEqual(events.at(-1), { type: "offline", revoked: false });
  assert.deepEqual(
    await s.transport.command(host.id, "w", "send", {
      threadId: "t",
      text: "x",
    }),
    {
      accepted: false,
      error: "Open a Thread and verify its current Turn first.",
    },
  );
  await s.transport.snapshot(host.id, "w"); // ordinary error does not revoke device grant
});

test("Fleet connection fencing rejects another device/workspace without dispatching and keeps unselected forget isolated", async () => {
  const other = {
    ...host,
    id: "host-other123",
    endpoint: "https://other:4321",
  };
  const secrets = new Map<string, string>();
  const sockets: Socket[] = [];
  let device = 0;
  const transport = new RemoteHostTransport(() => [host, other], {
    getSecret: async (key) => secrets.get(key) ?? null,
    setSecret: async (key, value) => {
      secrets.set(key, value);
    },
    deleteSecret: async (key) => {
      secrets.delete(key);
    },
    uuid: () => `device-${++device}`,
    fetch: (async (_url: string, options: RequestInit) => {
      const request = JSON.parse(String(options.body));
      return {
        ok: true,
        json: async () => ({
          hostId: request.hostId,
          deviceId: request.deviceId,
          token: `token-${request.hostId}`,
        }),
      };
    }) as typeof fetch,
    openSocket: (url, headers) => {
      assert.equal(url.includes("token-"), false);
      const id = url.includes("other") ? other.id : host.id;
      assert.equal(headers.Authorization, `Bearer token-${id}`);
      const socket = new Socket((request) =>
        request.method === REMOTE_METHODS.hello
          ? { hostId: id, version: 1, processEpoch: `epoch-${id}` }
          : response(request),
      );
      sockets.push(socket);
      return socket as unknown as WebSocket;
    },
  });
  await transport.pair(host.id, "code-a");
  await transport.pair(other.id, "code-b");
  assert.equal(await transport.pairingStatus(host.id), "paired");
  await transport.snapshot(host.id, "w");
  await transport.read(host.id, "w", "t");
  const count = sockets[0]!.requests.length;
  await assert.rejects(transport.read(other.id, "w", "t"), /wrong_host/);
  await assert.rejects(
    transport.command(other.id, "w", "send", {
      threadId: "t",
      text: "wrong target",
    }),
    /wrong_host/,
  );
  await assert.rejects(
    transport.command(host.id, "other-workspace", "create", {}),
    /wrong_workspace/,
  );
  assert.equal(sockets[0]!.requests.length, count);
  await transport.forget(other.id);
  assert.equal(await transport.pairingStatus(other.id), "unpaired");
  assert.equal(
    sockets[0]!.readyState,
    Socket.OPEN,
    "unselected forget does not disconnect A",
  );
  await transport.command(host.id, "w", "send", {
    threadId: "t",
    text: "still A",
  });
  transport.disconnect();
});

test("forget wins a pairing SecureStore write already in flight", async () => {
  let release!: () => void;
  let saving!: () => void;
  const saveStarted = new Promise<void>((resolve) => {
    saving = resolve;
  });
  const saveGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const secrets = new Map<string, string>();
  const transport = new RemoteHostTransport(() => [host], {
    getSecret: async (key) => secrets.get(key) ?? null,
    setSecret: async (key, value) => {
      saving();
      await saveGate;
      secrets.set(key, value);
    },
    deleteSecret: async (key) => {
      secrets.delete(key);
    },
    uuid: () => "device",
    fetch: (async () => ({
      ok: true,
      json: async () => ({
        hostId: host.id,
        deviceId: "device",
        token: "secret",
      }),
    })) as unknown as typeof fetch,
    openSocket: () => {
      throw Error("pairing must not open a socket");
    },
  });
  const paired = transport.pair(host.id, "code");
  const rejected = assert.rejects(paired, /Selection changed/);
  await saveStarted;
  const forgotten = transport.forget(host.id);
  release();
  await Promise.all([rejected, forgotten]);
  assert.equal(secrets.size, 0);
  assert.equal(await transport.pairingStatus(host.id), "unpaired");
});

test("RPC deadline bounds hung recovery and unknown send without replay", async () => {
  let hangSend = true;
  const s = setup((request) => {
    if (request.method === REMOTE_METHODS.send && hangSend) return undefined;
    return response(request);
  });
  // The dependency is test-local, with no credentials or real network.
  (s.transport as any).deps.timeoutMs = 10;
  await s.transport.pair(host.id, "code");
  await s.transport.snapshot(host.id, "w");
  await s.transport.read(host.id, "w", "t");
  await assert.rejects(
    s.transport.command(host.id, "w", "send", {
      threadId: "t",
      text: "possibly admitted",
    }),
    /timed out.*delivery unconfirmed/,
  );
  assert.equal(
    s
      .socket()
      .requests.filter((request) => request.method === REMOTE_METHODS.send)
      .length,
    1,
  );
  hangSend = false;
  s.transport.disconnect();
  await s.transport.snapshot(host.id, "w");
  await s.transport.read(host.id, "w", "t");
  assert.equal(
    s
      .socket()
      .requests.some((request) => request.method === REMOTE_METHODS.send),
    false,
    "reconnect only reads; no resend",
  );
  s.transport.disconnect();

  let resume = 0;
  const hung = setup((request) => {
    if (request.method === REMOTE_METHODS.resume && ++resume === 1)
      return undefined;
    return response(request);
  });
  (hung.transport as any).deps.timeoutMs = 10;
  await hung.transport.pair(host.id, "code");
  await hung.transport.snapshot(host.id, "w");
  await assert.rejects(hung.transport.read(host.id, "w", "t"), /timed out/);
  assert.equal(
    (await hung.transport.read(host.id, "w", "t"))[1]?.text,
    "hello",
    "a timed-out old page cannot block a fresh read forever",
  );
  hung.transport.disconnect();
});

test("shared-wire Rooms/models use verified scope, safe posts and queued send receipts", async () => {
  const room = { id: "room-a", name: "Assistant", threadId: "t" };
  const s = setup((request) => {
    if (request.method === REMOTE_METHODS.hello)
      return { ...response(request), capabilities: ["rooms", "models"] };
    if (request.method === REMOTE_METHODS.models)
      return {
        models: [
          {
            id: "provider-qualified/model",
            model: "model",
            displayName: "Model",
            isDefault: true,
            supportedReasoningEfforts: [
              { reasoningEffort: "high", description: "High" },
            ],
            defaultReasoningEffort: "high",
          },
        ],
      };
    if (request.method === REMOTE_METHODS.rooms) return { rooms: [room] };
    if (request.method === REMOTE_METHODS.roomsRead)
      return {
        room: { ...room, operationEpoch: "room-epoch" },
        messages: [
          {
            id: "message-a",
            kind: "agent",
            author: "Assistant",
            text: "Deliberate public post",
            createdAt: 1,
          },
        ],
      };
    if (request.method === REMOTE_METHODS.roomsPost)
      return { messageId: "posted-a", threadId: "t" };
    if (request.method === REMOTE_METHODS.create)
      return { id: "created", items: [], turns: [], archived: false };
    if (request.method === REMOTE_METHODS.send) return { queued: true };
    return response(request);
  });
  await s.transport.pair(host.id, "code");
  const snapshot = await s.transport.snapshot(host.id, "w");
  assert.equal(snapshot.supportsRooms, true);
  assert.deepEqual(snapshot.rooms, [room]);
  assert.equal(snapshot.models[0]?.id, "provider-qualified/model");
  await s.transport.command(host.id, "w", "create", {
    model: snapshot.models[0]!.id,
    effort: "high",
  });
  assert.deepEqual(
    s
      .socket()
      .requests.find((request) => request.method === REMOTE_METHODS.create)
      .params,
    { workspaceId: "w", model: "provider-qualified/model", effort: "high" },
  );
  const events: any[] = [];
  s.transport.subscribe(host.id, "w", (event) => events.push(event));
  const view = await s.transport.readRoom(host.id, "w", room.id);
  assert.equal(view.messages[0]?.text, "Deliberate public post");
  assert.deepEqual(
    await s.transport.postRoom(host.id, "w", room.id, "hello room"),
    { messageId: "posted-a", threadId: "t", clientId: "room-epoch:uuid-2" },
  );
  assert.deepEqual(
    s
      .socket()
      .requests.find((request) => request.method === REMOTE_METHODS.roomsPost)
      .params,
    {
      workspaceId: "w",
      roomId: "room-a",
      text: "hello room",
      clientId: "room-epoch:uuid-2",
    },
  );
  s.socket().onmessage?.({
    data: JSON.stringify({
      method: REMOTE_METHODS.roomEvent,
      params: { roomId: "room-a", workspaceId: "other" },
    }),
  });
  assert.equal(events.length, 0);
  s.socket().onmessage?.({
    data: JSON.stringify({
      method: REMOTE_METHODS.roomEvent,
      params: { roomId: "room-a", workspaceId: "w" },
    }),
  });
  assert.deepEqual(events, [{ type: "room", roomId: "room-a" }]);
  await s.transport.read(host.id, "w", "t");
  assert.deepEqual(
    await s.transport.command(host.id, "w", "send", {
      threadId: "t",
      text: "continue",
    }),
    { accepted: true, queued: true },
  );
  s.transport.disconnect();
});

test("a late old Host recovery cannot clear or publish into the new Host connection", async () => {
  const other = {
    ...host,
    id: "host-other123",
    endpoint: "https://other:4321",
  };
  const secrets = new Map<string, string>();
  const sockets: Socket[] = [];
  let device = 0;
  const transport = new RemoteHostTransport(() => [host, other], {
    getSecret: async (key) => secrets.get(key) ?? null,
    setSecret: async (key, value) => {
      secrets.set(key, value);
    },
    deleteSecret: async (key) => {
      secrets.delete(key);
    },
    uuid: () => `device-${++device}`,
    fetch: (async (_url: string, options: RequestInit) => {
      const request = JSON.parse(String(options.body));
      return {
        ok: true,
        json: async () => ({
          hostId: request.hostId,
          deviceId: request.deviceId,
          token: `token-${request.hostId}`,
        }),
      };
    }) as typeof fetch,
    openSocket: (url) => {
      const id = url.includes("other") ? other.id : host.id;
      const socket = new Socket((request) => {
        if (request.method === REMOTE_METHODS.hello)
          return { hostId: id, version: 1, processEpoch: `epoch-${id}` };
        if (request.method === REMOTE_METHODS.resume && id === host.id)
          return undefined;
        if (request.method === REMOTE_METHODS.resume)
          return {
            ...response(request),
            processEpoch: `epoch-${id}`,
            entries: [
              {
                kind: "item",
                item: {
                  id: "b-message",
                  threadId: "t",
                  type: "agent_message",
                  createdAt: "now",
                  text: "Only Host B",
                },
              },
            ],
          };
        return response(request);
      });
      sockets.push(socket);
      return socket as unknown as WebSocket;
    },
  });
  await transport.pair(host.id, "code-a");
  await transport.pair(other.id, "code-b");
  await transport.snapshot(host.id, "w");
  const oldRead = transport.read(host.id, "w", "t");
  const oldRejected = assert.rejects(oldRead, /closed|wrong_host/);
  await transport.snapshot(other.id, "w");
  const events: any[] = [];
  transport.subscribe(other.id, "w", (event) => events.push(event));
  assert.equal(
    (await transport.read(other.id, "w", "t"))[0]?.text,
    "Only Host B",
  );
  await oldRejected;
  sockets[0]!.notify({
    processEpoch: "old",
    threadId: "t",
    watermark: 3,
    event: {
      type: "item_completed",
      item: {
        id: "old-secret",
        threadId: "t",
        type: "agent_message",
        text: "Old Host A",
      },
    },
  });
  sockets[0]!.onerror?.();
  assert.equal(
    events.some((event) => event.type === "offline"),
    false,
  );
  assert.equal(events.at(-1).items.t[0].text, "Only Host B");
  assert.equal(await transport.pairingStatus(host.id), "paired");
  sockets[1]!.close(4003);
  assert.equal(await transport.pairingStatus(other.id), "revoked");
  assert.equal(
    await transport.pairingStatus(host.id),
    "paired",
    "revocation is device-scoped",
  );
  transport.disconnect();
});

test("Room polls retain last complete epoch for posts, and late reads cannot overwrite a newer epoch", async () => {
  let reads = 0;
  const held: any[] = [];
  const view = (epoch: string) => ({
    room: {
      id: "room",
      name: "Assistant",
      threadId: "t",
      operationEpoch: epoch,
    },
    messages: [],
  });
  const s = setup((request) => {
    if (request.method === REMOTE_METHODS.hello)
      return { ...response(request), capabilities: ["rooms"] };
    if (request.method === REMOTE_METHODS.rooms)
      return { rooms: [{ id: "room", name: "Assistant", threadId: "t" }] };
    if (request.method === REMOTE_METHODS.roomsRead) {
      reads++;
      if (reads === 2 || reads === 3) {
        held.push(request);
        return undefined;
      }
      return view(reads === 1 ? "epoch-initial" : "epoch-latest");
    }
    if (request.method === REMOTE_METHODS.roomsPost)
      return { messageId: "message", threadId: "t" };
    return response(request);
  });
  await s.transport.pair(host.id, "code");
  await s.transport.snapshot(host.id, "w");
  await s.transport.readRoom(host.id, "w", "room");
  const poll = s.transport.readRoom(host.id, "w", "room");
  await new Promise<void>((resolve) => setImmediate(resolve));
  const posted = await s.transport.postRoom(
    host.id,
    "w",
    "room",
    "during poll",
  );
  assert.equal(posted.clientId, "epoch-initial:uuid-2");
  s.socket().onmessage?.({
    data: JSON.stringify({ id: held[0].id, result: view("epoch-refreshed") }),
  });
  await poll;
  const old = s.transport.readRoom(host.id, "w", "room");
  const rejected = assert.rejects(old, /newer Room read/);
  await s.transport.readRoom(host.id, "w", "room");
  s.socket().onmessage?.({
    data: JSON.stringify({ id: held[1].id, result: view("epoch-old") }),
  });
  await rejected;
  assert.equal(
    (await s.transport.postRoom(host.id, "w", "room", "latest view")).clientId,
    "epoch-latest:uuid-3",
  );
  s.transport.disconnect();
});

test("bounded pairing covers a hung response body and late response cannot save a credential", async () => {
  let answer!: (value: any) => void;
  const body = new Promise((resolve) => {
    answer = resolve;
  });
  const secrets = new Map<string, string>();
  const transport = new RemoteHostTransport(() => [host], {
    getSecret: async (key) => secrets.get(key) ?? null,
    setSecret: async (key, value) => {
      secrets.set(key, value);
    },
    deleteSecret: async (key) => {
      secrets.delete(key);
    },
    uuid: () => "device",
    timeoutMs: 10,
    fetch: (async (_url: string, options: RequestInit) => {
      assert.equal(
        (options.headers as Record<string, string>)["x-zen-host-id"],
        host.id,
      );
      return { ok: true, json: () => body };
    }) as typeof fetch,
    openSocket: () => {
      throw Error("No socket expected");
    },
  });
  await assert.rejects(
    transport.pair(host.id, "one-use-code"),
    /Pairing timed out/,
  );
  answer({ hostId: host.id, deviceId: "device", token: "late-secret" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(secrets.size, 0);
});

test("malformed native frames clear Thread and Room session views while preserving unknown delivery", async () => {
  const { createSession } = await import("../src/session.mjs");
  const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
  for (const room of [false, true]) {
    const s = setup((request) => {
      if (request.method === REMOTE_METHODS.hello)
        return { ...response(request), capabilities: ["rooms"] };
      if (request.method === REMOTE_METHODS.rooms)
        return { rooms: [{ id: "room", name: "Assistant", threadId: "t" }] };
      if (request.method === REMOTE_METHODS.roomsRead)
        return {
          room: {
            id: "room",
            name: "Assistant",
            threadId: "t",
            operationEpoch: "epoch",
          },
          messages: [
            {
              id: "public-room",
              kind: "agent",
              author: "Assistant",
              text: "public Room post",
              createdAt: 1,
            },
          ],
        };
      if (
        request.method === REMOTE_METHODS.send ||
        request.method === REMOTE_METHODS.roomsPost
      )
        return undefined;
      return response(request);
    });
    (s.transport as any).deps.timeoutMs = 10;
    await s.transport.pair(host.id, "code");
    const session = createSession(s.transport, () => {});
    session.selectHost(host.id);
    await tick();
    session.selectWorkspace("w");
    await tick();
    if (room) session.openRoom("room");
    else session.openThread("t");
    await tick();
    assert.equal(session.get().status, "connected");
    assert.ok(
      room ? session.get().roomMessages.length : session.get().items.length,
    );
    if (room) await session.postRoom("possibly admitted");
    else
      await session.command("send", {
        threadId: "t",
        text: "possibly admitted",
      });
    assert.equal(session.get().command, "uncertain");
    s.socket().onmessage?.({ data: "not-json-from-relay" });
    assert.equal(s.socket().readyState, 3);
    assert.equal(session.get().status, "offline");
    assert.deepEqual(session.get().items, []);
    assert.deepEqual(session.get().turns, []);
    assert.deepEqual(session.get().roomMessages, []);
    assert.equal(session.get().roomReady, false);
    assert.equal(session.get().command, "uncertain");
    assert.equal(
      await s.transport.pairingStatus(host.id),
      "paired",
      "wire failure is not grant revocation",
    );
    const sends = s
      .socket()
      .requests.filter(
        (request) =>
          request.method === REMOTE_METHODS.send ||
          request.method === REMOTE_METHODS.roomsPost,
      ).length;
    await session.reconnect();
    await tick();
    assert.equal(session.get().status, "connected");
    assert.equal(session.get().command, null);
    assert.equal(sends, 1);
    assert.equal(
      s
        .socket()
        .requests.some(
          (request) =>
            request.method === REMOTE_METHODS.send ||
            request.method === REMOTE_METHODS.roomsPost,
        ),
      false,
      "recovery never replays either kind of mutation",
    );
    session.dispose();
  }
});

test("valid JSON with an invalid native envelope or malformed event also disconnects explicitly", async () => {
  for (const raw of [
    "null",
    "[]",
    "0",
    JSON.stringify({ method: REMOTE_METHODS.event, params: null }),
  ]) {
    const s = setup(response);
    await s.transport.pair(host.id, "code");
    await s.transport.snapshot(host.id, "w");
    const events: any[] = [];
    s.transport.subscribe(host.id, "w", (event) => events.push(event));
    await s.transport.read(host.id, "w", "t");
    s.socket().onmessage?.({ data: raw });
    assert.deepEqual(events.at(-1), { type: "offline", revoked: false });
    assert.equal(s.socket().readyState, 3);
  }
});

test("malformed events are rejected before recovery buffering and cannot publish or admit a send", async () => {
  const { createSession } = await import("../src/session.mjs");
  const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
  const malformed = [
    null,
    { type: "turn_started" },
    { type: "turn_completed", turnId: "turn", status: "made-up-status" },
    { type: "item_completed", item: null },
    {
      type: "item_completed",
      item: {
        id: "tool",
        threadId: "t",
        type: "tool_output",
        text: "fake nonpublic content",
      },
    },
    {
      type: "item_completed",
      item: {
        id: "other",
        threadId: "other-thread",
        type: "agent_message",
        text: "wrong Thread",
      },
    },
  ];
  for (const event of malformed) {
    let held: any;
    const s = setup((request) => {
      if (request.method === REMOTE_METHODS.resume) {
        held = request;
        return undefined;
      }
      return response(request);
    });
    await s.transport.pair(host.id, "code");
    const session = createSession(s.transport, () => {});
    session.selectHost(host.id);
    await tick();
    session.selectWorkspace("w");
    await tick();
    session.openThread("t");
    await tick();
    assert.ok(held);
    s.socket().notify({
      threadId: "t",
      processEpoch: "e1",
      watermark: 1,
      event,
    });
    assert.equal(s.socket().readyState, 3);
    // Late terminal recovery is discarded after the failure fenced the socket.
    s.socket().onmessage?.({
      data: JSON.stringify({
        id: held.id,
        result: { ...response(held), watermark: 0 },
      }),
    });
    await tick();
    assert.equal(session.get().status, "offline");
    assert.deepEqual(session.get().items, []);
    assert.deepEqual(session.get().turns, []);
    await session.command("send", { threadId: "t", text: "must not dispatch" });
    assert.equal(
      s
        .socket()
        .requests.some((request) => request.method === REMOTE_METHODS.send),
      false,
    );
    assert.equal(await s.transport.pairingStatus(host.id), "paired");
    session.dispose();
  }
});

test("structured unknown backend errors never claim confirmed mobile send rejection", async () => {
  for (const code of [
    "operation_unknown",
    "future_unknown_code",
    "operation_forbidden",
    "scope_refreshing",
  ]) {
    const f = setup((request, socket) => {
      if (request.method === REMOTE_METHODS.send) {
        queueMicrotask(() =>
          socket.onmessage?.({
            data: JSON.stringify({
              id: request.id,
              error: { code: -32000, message: code, data: { code } },
            }),
          }),
        );
        return undefined;
      }
      return response(request);
    });
    await f.transport.pair(host.id, "code");
    await f.transport.snapshot(host.id, "w");
    await f.transport.read(host.id, "w", "t");
    await assert.rejects(
      f.transport.command(host.id, "w", "send", {
        threadId: "t",
        text: "message",
      }),
      (error: any) => {
        assert.equal(
          error.confirmedRejection === true,
          code === "operation_forbidden" || code === "scope_refreshing",
        );
        return true;
      },
    );
    f.transport.disconnect();
  }
});
