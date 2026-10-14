import { test } from "node:test";
import assert from "node:assert/strict";
import { RemoteHostTransport } from "../src/remote-core";
import { REMOTE_METHODS } from "../../../src/protocol/native/remote-wire";

// Node-only Host projection integration. Keep real Host imports out of the
// Expo app/unit-test type graph; test:host runs this file with the TLS test.
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

for (const kind of ["host_message", "thread_message"] as const) {
  test(`actual canonical ${kind} stays connected and retains provenance live and after recovery`, async () => {
    const { projectRemoteItem } =
      await import("../../../src/protocol/native/remote-host.js");
    const canonical =
      kind === "host_message"
        ? {
            id: "incoming",
            threadId: "t",
            turnId: "turn1",
            createdAt: new Date().toISOString(),
            type: kind,
            sender: "host",
            clientId: "incoming-id",
            source: "room",
            sourceId: "private-room-id",
            mode: "steer",
            text: "Room context",
          }
        : {
            id: "incoming",
            threadId: "t",
            turnId: "turn1",
            createdAt: new Date().toISOString(),
            type: kind,
            clientId: "incoming-id",
            mode: "steer",
            messageType: "guidance",
            sender: {
              threadId: "private-agent-thread",
              turnId: "source-turn",
              toolCallId: "tool",
              callId: "call",
              threadName: "Research worker",
            },
            content: [{ type: "text", text: "Agent context" }],
          };
    const item = projectRemoteItem(canonical as any)!;
    let recovering = false;
    const s = setup((request) =>
      request.method === REMOTE_METHODS.resume && recovering
        ? {
            ...response(request),
            watermark: 3,
            entries: [{ kind: "item", item }],
          }
        : response(request),
    );
    await s.transport.pair(host.id, "code");
    await s.transport.snapshot(host.id, "w");
    const events: any[] = [];
    s.transport.subscribe(host.id, "w", (event) => events.push(event));
    await s.transport.read(host.id, "w", "t");
    s.socket().notify({
      threadId: "t",
      processEpoch: "e1",
      watermark: 3,
      event: { type: "item_completed", item },
    });
    assert.equal(s.socket().readyState, 1);
    const live = events.at(-1)?.items.t.find((i: any) => i.id === item.id);
    assert.equal(live.role, kind);
    assert.equal(live.text, item.text);
    assert.match(
      live.sourceLabel,
      kind === "host_message" ? /Room/ : /Remote agent.*Research worker/,
    );
    assert.doesNotMatch(live.sourceLabel, /private-|source-turn|call/);
    assert.ok(live.sourceDetails);
    recovering = true;
    const restored = await s.transport.read(host.id, "w", "t");
    assert.deepEqual(restored, [live]);
    s.transport.disconnect();
  });
}
