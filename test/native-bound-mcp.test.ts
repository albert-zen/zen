import assert from "node:assert/strict";
import test from "node:test";
import { NativeConnection } from "../src/protocol/native/connection.js";
import type { NativeRecoveryProjection } from "../src/protocol/native/recovery.js";
import type { JsonRpcMessage } from "../src/protocol/codex/wire.js";

test("native MCP owner is fixed once, requires initialized Host support and closes its exact lifetime", async () => {
  const sent: JsonRpcMessage[] = [];
  let initialized = false;
  let opens = 0,
    receives = 0,
    closes = 0;
  let signal: AbortSignal | undefined;
  const connection = new NativeConnection({
    projection: {
      subscribe: () => () => {},
    } as unknown as NativeRecoveryProjection,
    isInitialized: () => initialized,
    send: (message) => sent.push(message),
    openBoundMcp: async (options) => {
      opens++;
      signal = options.signal;
      assert.deepEqual(options.owner, { kind: "thread", threadId: "first" });
      return {
        receive: async () => {
          receives++;
          options.send({ jsonrpc: "2.0", id: 7, result: {} });
        },
        close: async () => {
          closes++;
        },
      };
    },
  });
  const bind = (id: number, threadId: string) =>
    connection.receive({
      id,
      method: "zen/mcp/bind",
      params: { owner: { kind: "thread", threadId } },
    });
  await bind(1, "first");
  assert.equal(opens, 0);
  assert.match(
    "error" in sent[0]! ? sent[0].error.message : "",
    /Not initialized/,
  );
  initialized = true;
  await bind(2, "first");
  await bind(3, "second");
  assert.equal(opens, 1);
  assert.match("error" in sent[2]! ? sent[2].error.message : "", /fixed once/);
  await connection.receive({
    id: 4,
    method: "zen/mcp/message",
    params: { message: { jsonrpc: "2.0", id: 7, method: "tools/list" } },
  });
  assert.equal(receives, 1);
  assert(
    sent.some(
      (message) => "method" in message && message.method === "zen/mcp/message",
    ),
  );
  connection.close();
  connection.close();
  assert.equal(signal?.aborted, true);
  await Promise.resolve();
  assert.equal(closes, 1);
});

test("native core does not manufacture an MCP Host when no product callback is injected", async () => {
  const sent: JsonRpcMessage[] = [];
  const connection = new NativeConnection({
    projection: {
      subscribe: () => () => {},
    } as unknown as NativeRecoveryProjection,
    isInitialized: () => true,
    send: (message) => sent.push(message),
  });
  await connection.receive({
    id: 1,
    method: "zen/mcp/bind",
    params: { owner: { kind: "thread", threadId: "first" } },
  });
  assert.match(
    "error" in sent[0]! ? sent[0].error.message : "",
    /unavailable on this Host/,
  );
  connection.close();
});

test("native MCP observes a transport close rejection without replay or an unhandled rejection", async (t) => {
  const report = t.mock.method(console, "error", () => {});
  let closes = 0;
  const connection = new NativeConnection({
    projection: {
      subscribe: () => () => {},
    } as unknown as NativeRecoveryProjection,
    isInitialized: () => true,
    send: () => {},
    openBoundMcp: async () => ({
      receive: async () => {},
      close: async () => {
        closes++;
        throw new Error("fixture close failure");
      },
    }),
  });
  await connection.receive({
    id: 1,
    method: "zen/mcp/bind",
    params: { owner: { kind: "thread", threadId: "first" } },
  });
  connection.close();
  connection.close();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(closes, 1);
  assert.equal(report.mock.calls.length, 1);
  assert.equal(
    report.mock.calls[0]!.arguments[0],
    "Bound MCP connection close failed",
  );
});
