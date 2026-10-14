import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import WebSocket, { WebSocketServer } from "ws";
import {
  boundedCdpRecords,
  traceOwnedCdpTransport,
} from "../src/main/browser-cdp-diagnostics.js";

async function fixture(
  run: (socket: WebSocket, peer: WebSocket, url: string) => Promise<void>,
) {
  const server = new WebSocketServer({ port: 0 });
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = `ws://127.0.0.1:${address.port}`;
  const connected = once(server, "connection");
  const socket = new WebSocket(url);
  await once(socket, "open");
  const [peer] = await connected;
  try {
    await run(socket, peer, socket.url);
  } finally {
    socket.terminate();
    peer.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("original reply has monotonic timing and anonymous route, with no payload capture", async () => {
  await fixture(async (socket, peer, url) => {
    const records: Record<string, unknown>[] = [];
    let now = 100;
    const original = WebSocket.prototype.send;
    const initialListeners = socket.listenerCount("message");
    const stop = traceOwnedCdpTransport(
      url,
      (record) => records.push(record),
      () => now,
    );
    try {
      const body = JSON.stringify({
        id: 7,
        method: "Runtime.evaluate",
        sessionId: "SECRET_SESSION",
        params: { expression: "SECRET_CONTENT", cookie: "SECRET_COOKIE" },
      });
      const received = once(peer, "message");
      socket.send(body);
      assert.equal(String((await received)[0]), body);
      now = 2700;
      const response = once(socket, "message");
      peer.send(
        JSON.stringify({
          id: 7,
          sessionId: "SECRET_SESSION",
          result: { value: "SECRET_VALUE" },
        }),
      );
      await response;
      const reply = records.find((record) => record.kind === "reply")!;
      assert.equal(reply.elapsedMs, 2600);
      assert.equal(reply.originalRequest, true);
      assert.equal(reply.routeMatches, true);
      assert.equal(typeof reply.requestRoute, "number");
      assert.ok(!JSON.stringify(records).includes("SECRET"));
      assert.equal(
        records.filter((record) => record.kind === "send").length,
        1,
      );
    } finally {
      stop();
      stop();
    }
    assert.equal(WebSocket.prototype.send, original);
    assert.equal(socket.listenerCount("message"), initialListeners);
  });
});

test("wrong-route reply stays distinguishable from later original response and lifecycle is redacted", async () => {
  await fixture(async (socket, peer, url) => {
    const records: Record<string, unknown>[] = [];
    const stop = traceOwnedCdpTransport(url, (record) => records.push(record));
    try {
      const request = once(peer, "message");
      socket.send(
        JSON.stringify({
          id: 1,
          method: "Page.createIsolatedWorld",
          sessionId: "SECRET_ROUTE",
        }),
      );
      await request;
      for (const message of [
        { id: 1, sessionId: "SECRET_WRONG", result: {} },
        {
          method: "Target.attachedToTarget",
          params: {
            sessionId: "SECRET_ROUTE",
            waitingForDebugger: true,
            targetInfo: {
              targetId: "SECRET_TARGET",
              url: "SECRET_URL",
              title: "SECRET_TITLE",
            },
          },
        },
        {
          id: 1,
          sessionId: "SECRET_ROUTE",
          error: { code: -32000, message: "SECRET_ERROR" },
        },
      ]) {
        const reply = once(socket, "message");
        peer.send(JSON.stringify(message));
        await reply;
      }
      const replies = records.filter((record) => record.kind === "reply");
      assert.deepEqual(
        replies.map((record) => record.routeMatches),
        [false, true],
      );
      assert.equal(replies[1]!.outcome, "protocol-error");
      assert.equal(replies[1]!.errorCode, -32000);
      assert.equal(
        records.find((record) => record.kind === "event")!.waitingForDebugger,
        true,
      );
      assert.ok(!JSON.stringify(records).includes("SECRET"));
    } finally {
      stop();
    }
  });
});

test("recorder exceptions do not change forwarding or returned data", async () => {
  await fixture(async (socket, peer, url) => {
    const stop = traceOwnedCdpTransport(url, () => {
      throw Error("diagnostic failure");
    });
    try {
      const request = once(peer, "message");
      socket.send('{"id":1,"method":"Target.getTargets"}');
      await request;
      const reply = once(socket, "message");
      peer.send('{"id":1,"result":{"targets":[]}}');
      assert.equal(
        String((await reply)[0]),
        '{"id":1,"result":{"targets":[]}}',
      );
    } finally {
      stop();
    }
  });
});

test("bounded records preserve startup and final tail with explicit omission", () => {
  const records = boundedCdpRecords(2);
  for (let value = 1; value <= 7; value++) records.push(value);
  assert.deepEqual(records.snapshot(), { records: [1, 2, 6, 7], dropped: 3 });
  records.push(8);
  assert.deepEqual(records.snapshot(), { records: [1, 2, 7, 8], dropped: 4 });
  assert.throws(() => boundedCdpRecords(0));
});

test("only exact owned fixture socket is observed and original send remains unchanged", async () => {
  await fixture(async (socket, peer, url) => {
    const records: Record<string, unknown>[] = [];
    const allowed = new Set<string>();
    const stop = traceOwnedCdpTransport(
      "ws://unrelated.invalid",
      (value) => records.push(value),
      () => 0,
      allowed,
    );
    try {
      let received = once(peer, "message");
      socket.send('{"id":1,"method":"Runtime.evaluate"}');
      await received;
      assert.equal(records.length, 0);
      allowed.add(url);
      received = once(peer, "message");
      socket.send('{"id":2,"method":"Runtime.evaluate"}');
      await received;
      assert.equal(records[0]?.endpoint, "fixture");
      const reply = once(socket, "message");
      peer.send('{"id":2,"result":{"value":"SECRET_CONTENT"}}');
      await reply;
      assert.equal(records[1]?.kind, "reply");
      assert.ok(!JSON.stringify(records).includes("SECRET_CONTENT"));
    } finally {
      stop();
    }
  });
});
