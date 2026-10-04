import assert from "node:assert/strict";
import test from "node:test";
import { PassThrough } from "node:stream";
import { attachPawPipe } from "../dist/paw-pipe.js";
const settle = () => new Promise((resolve) => setImmediate(resolve));
function child() {
  const result = {
    stdout: new PassThrough(),
    stdin: new PassThrough(),
    kill() {
      result.killed = true;
    },
  };
  result.responses = [];
  result.stdin.on("data", (data) => result.responses.push(JSON.parse(data)));
  return result;
}
test("private PAW pipe validates requests, separates diagnostics, and returns service results", async () => {
  const c = child();
  const calls = [];
  const dispose = attachPawPipe(
    c,
    async (op, params) => {
      calls.push([op, params]);
      return { rooms: [] };
    },
    () => true,
  );
  c.stdout.write('sdk diagnostic\n{"type":"ready"}\n');
  c.stdout.write(
    JSON.stringify({
      type: "paw-request",
      id: "1",
      operation: "list",
      params: {},
    }) + "\n",
  );
  await settle();
  assert.deepEqual(calls, [["list", {}]]);
  assert.deepEqual(c.responses, [
    { type: "paw-response", id: "1", result: { rooms: [] } },
  ]);
  c.stdout.write(
    '{"type":"paw-request","id":"2","operation":"execute","params":{}}\n',
  );
  await settle();
  assert.match(c.responses[1].error, /Invalid/);
  assert.equal(calls.length, 1);
  dispose();
});
test("retired child cannot publish delayed response or admit another mutation", async () => {
  const c = child();
  let resolve;
  let current = true;
  let calls = 0;
  const dispose = attachPawPipe(
    c,
    () => {
      calls++;
      return new Promise((r) => (resolve = r));
    },
    () => current,
  );
  c.stdout.write(
    '{"type":"paw-request","id":"1","operation":"post","params":{}}\n',
  );
  current = false;
  c.stdout.write(
    '{"type":"paw-request","id":"2","operation":"post","params":{}}\n',
  );
  resolve({ messageId: "m" });
  await settle();
  assert.equal(calls, 1);
  assert.deepEqual(c.responses, []);
  dispose();
});

test("PAW pipe preserves split UTF-8 messages and bounds parallel admission", async () => {
  const c = child();
  const calls = [];
  const resolvers = [];
  const dispose = attachPawPipe(
    c,
    (op, params) => {
      calls.push(params);
      return new Promise((resolve) => resolvers.push(resolve));
    },
    () => true,
  );
  const bytes = Buffer.from(
    JSON.stringify({
      type: "paw-request",
      id: "u",
      operation: "post",
      params: { text: "你好" },
    }) + "\n",
  );
  const split = bytes.indexOf(Buffer.from("你")) + 1;
  c.stdout.write(bytes.subarray(0, split));
  c.stdout.write(bytes.subarray(split));
  assert.equal(calls[0].text, "你好");
  for (let i = 0; i < 16; i++)
    c.stdout.write(
      JSON.stringify({
        type: "paw-request",
        id: String(i),
        operation: "list",
        params: {},
      }) + "\n",
    );
  assert.equal(calls.length, 16);
  assert.match(c.responses[0].error, /busy/);
  resolvers.forEach((resolve) => resolve({}));
  await settle();
  dispose();
});
