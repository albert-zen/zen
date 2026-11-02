import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";
import { createFixtureSession, createFrameReader } from "./fixture.mjs";

const request = (id, method, params) => ({
  jsonrpc: "2.0",
  id,
  method,
  ...(params === undefined ? {} : { params }),
});
const ready = () => {
  const session = createFixtureSession();
  session.handle(
    request(1, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "fixture-client", version: "0" },
    }),
  );
  session.handle({ jsonrpc: "2.0", method: "notifications/initialized" });
  return session;
};

test("no tools before initialization; only explicit read tools advertised", () => {
  assert.equal(
    createFixtureSession().handle(request(1, "tools/list")).error.code,
    -32002,
  );
  const s = ready();
  const list = s.handle(request(2, "tools/list")).result.tools;
  assert.deepEqual(
    list.map((t) => t.name),
    ["zenx_fixture_thread_summary", "zenx_fixture_board_read"],
  );
  assert.ok(
    list.every(
      (t) => t.annotations.readOnlyHint && !t.annotations.destructiveHint,
    ),
  );
  assert.ok(list.every((t) => t.inputSchema.additionalProperties === false));
});

test("bound thread summary is a fresh allowlisted projection, not a native snapshot", () => {
  const s = ready();
  const result = s.handle(
    request(2, "tools/call", {
      name: "zenx_fixture_thread_summary",
      arguments: {},
    }),
  ).result;
  assert.deepEqual(result.structuredContent, {
    threadId: "fixture-thread-a",
    title: "Synthetic fixture only",
    status: "idle",
  });
  result.structuredContent.title = "tampered";
  assert.equal(
    s.handle(request(3, "tools/call", { name: "zenx_fixture_thread_summary" }))
      .result.structuredContent.title,
    "Synthetic fixture only",
  );
  assert.equal(result.content[0].type, "text");
  assert.equal(JSON.stringify(result).includes("providerKey"), false);
});

test("model cannot choose another thread, grant itself access, or invoke a writer", () => {
  const s = ready();
  for (const args of [
    { threadId: "fixture-thread-b" },
    { scope: "full-access" },
    { requestId: "other-thread-question" },
  ]) {
    assert.equal(
      s.handle(
        request(2, "tools/call", {
          name: "zenx_fixture_thread_summary",
          arguments: args,
        }),
      ).error.code,
      -32602,
    );
  }
  assert.equal(
    s.handle(
      request(3, "tools/call", { name: "zenx_board_put", arguments: {} }),
    ).error.code,
    -32602,
  );
  assert.equal(s.handle(request(4, "turn/start", {})).error.code, -32601);
});

test("board read contains semantic data only, no executable events, drafts or HTML", () => {
  const s = ready();
  const value = s.handle(
    request(2, "tools/call", { name: "zenx_fixture_board_read" }),
  ).result.structuredContent;
  assert.equal(value.owner.threadId, "fixture-thread-a");
  assert.deepEqual(Object.keys(value).sort(), ["owner", "summary", "title"]);
});

test("initialization state is process-session local; repeat init and invalid envelope reject", () => {
  const first = ready();
  assert.equal(
    createFixtureSession().handle(request(2, "tools/list")).error.code,
    -32002,
  );
  assert.equal(first.handle(request(3, "initialize", {})).error.code, -32600);
  assert.equal(
    first.handle({ id: 3, method: "tools/list" }).error.code,
    -32600,
  );
  assert.equal(
    first.handle({ jsonrpc: "2.0", method: "notifications/initialized" }),
    undefined,
  );
});

test("newline framing accepts chunk boundaries and rejects bounded oversized input", () => {
  const lines = [];
  const errors = [];
  const reader = createFrameReader(
    (line) => lines.push(line),
    (error) => errors.push(error),
  );
  reader.push('{"a":');
  reader.push('1}\n{"b":2}\n');
  assert.deepEqual(lines, ['{"a":1}', '{"b":2}']);
  reader.push("x".repeat(16_385));
  reader.push('\n{"not":"executed after overflow"}\n');
  assert.equal(errors.length, 1);
  assert.equal(lines.length, 2);
});

test("real stdio round-trip stays fixture-only and produces JSON-RPC stdout", async () => {
  const child = spawn(
    process.execPath,
    [new URL("./fixture.mjs", import.meta.url).pathname],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (text) => {
    stdout += text;
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (text) => {
    stderr += text;
  });
  child.stdin.end(
    [
      request(1, "initialize", {}),
      { jsonrpc: "2.0", method: "notifications/initialized" },
      request(2, "tools/list"),
      request(3, "tools/call", { name: "zenx_fixture_board_read" }),
    ]
      .map(JSON.stringify)
      .join("\n") + "\n",
  );
  const [code] = await once(child, "exit");
  assert.equal(code, 0);
  assert.equal(stderr, "");
  const results = stdout.trim().split("\n").map(JSON.parse);
  assert.deepEqual(
    results.map((x) => x.id),
    [1, 2, 3],
  );
  assert.equal(
    results[2].result.structuredContent.owner.threadId,
    "fixture-thread-a",
  );
});
