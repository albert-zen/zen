import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { EventEmitter, once } from "node:events";
import WebSocket, { WebSocketServer } from "ws";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
const source = readFileSync(
  new URL("../src/main/browser-parallel-input-smoke.ts", import.meta.url),
  "utf8",
);
const ast = ts.createSourceFile(
  "fixture.ts",
  source,
  ts.ScriptTarget.Latest,
  true,
);
const rpc = ast.statements.find(
  (n) => ts.isClassDeclaration(n) && n.name.text === "Rpc",
);
function fixture({ failSink = false } = {}) {
  let timer,
    now = 10;
  const sends = [];
  const callbacks = [];
  const logs = [];
  class Socket extends EventEmitter {
    constructor() {
      super();
      this.readyState = 1;
      this.bufferedAmount = 0;
      queueMicrotask(() => this.emit("open"));
    }
    send(value, callback) {
      sends.push(JSON.parse(value));
      callbacks.push(callback);
      this.bufferedAmount = 42;
    }
    close() {
      this.readyState = 3;
      this.emit("close");
    }
  }
  const Rpc = runInNewContext(
    ts.transpileModule(`${rpc.getText(ast)}; Rpc`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText,
    {
      WebSocket: Socket,
      assert,
      console: {
        error: (...args) => {
          logs.push(args);
          if (failSink) throw new Error("private-sink-error");
        },
      },
      Date: { now: () => now },
      setTimeout: (fn, ms) => {
        assert.equal(ms, 10000);
        timer = fn;
        return 1;
      },
      clearTimeout: () => {},
    },
  );
  return {
    Rpc,
    sends,
    callbacks,
    logs,
    advance: (ms) => {
      now += ms;
    },
    expire: () => {
      now = 10015;
      timer();
    },
  };
}
test("fixture screenshot timeout reports transport acceptance without claiming input dispatch", async () => {
  const f = fixture();
  const rpc = await f.Rpc.connect("ws://owned");
  const pending = rpc.send("Page.captureScreenshot", {
    format: "png",
    secret: "must not be logged",
  });
  f.expire();
  await assert.rejects(pending, (error) => {
    assert.match(
      error.message,
      /Page.captureScreenshot fixture timeout; never replay an input/,
    );
    assert.equal(error.fixtureCdp.method, "Page.captureScreenshot");
    assert.equal(error.fixtureCdp.transportAccepted, true);
    assert.equal(error.fixtureCdp.elapsedMs, 10005);
    assert.equal(error.fixtureCdp.timeoutMs, 10000);
    assert.equal(error.fixtureCdp.sessionScoped, false);
    assert.equal(JSON.stringify(error.fixtureCdp).includes("secret"), false);
    return true;
  });
  rpc.socket.emit(
    "message",
    JSON.stringify({ id: 1, result: { data: "late" } }),
  );
  assert.equal(f.sends.length, 1);
});
test("fixture input timeout never retries or promotes a late reply", async () => {
  const f = fixture();
  const rpc = await f.Rpc.connect("ws://owned");
  const pending = rpc.send(
    "Input.dispatchKeyEvent",
    { type: "keyDown" },
    "owned-session",
  );
  f.expire();
  await assert.rejects(
    pending,
    (error) =>
      error.fixtureCdp.transportAccepted === true &&
      error.fixtureCdp.sessionScoped === true,
  );
  rpc.socket.emit("message", JSON.stringify({ id: 1, result: {} }));
  assert.equal(f.sends.length, 1);
});

test("fixture preserves successful responses without recording request contents", async () => {
  const f = fixture();
  const rpc = await f.Rpc.connect("ws://owned");
  const pending = rpc.send("Page.captureScreenshot", { format: "png" });
  rpc.socket.emit(
    "message",
    JSON.stringify({ id: 1, result: { data: "pixels" } }),
  );
  assert.equal((await pending).data, "pixels");
  assert.equal(f.sends.length, 1);
});
test("fixture preserves synchronous send failure without retry", async () => {
  const f = fixture();
  const rpc = await f.Rpc.connect("ws://owned");
  const failure = new Error("send failed");
  rpc.socket.send = () => {
    throw failure;
  };
  await assert.rejects(
    rpc.send("Input.dispatchKeyEvent"),
    (e) => e === failure,
  );
  assert.equal(f.sends.length, 0);
});

test("screenshot callback error is diagnostic only and response still resolves", async () => {
  const f = fixture();
  const rpc = await f.Rpc.connect("ws://private-url");
  const pending = rpc.send(
    "Page.captureScreenshot",
    { secret: "private-param" },
    "private-session",
  );
  f.callbacks[0](new Error("private-callback-error"));
  await Promise.resolve();
  let record = rpc.screenshotTransport().records[0];
  assert.equal(record.sendCallback, "error");
  assert.equal(record.outcome, "pending");
  assert.equal(record.sent.readyState, 1);
  assert.equal(record.returned.bufferedAmount, 42);
  assert.equal(record.sendCallbackState.pendingCount, 1);
  rpc.socket.emit(
    "message",
    JSON.stringify({ id: 1, result: { data: "private-pixels" } }),
  );
  assert.equal((await pending).data, "private-pixels");
  record = rpc.screenshotTransport().records[0];
  assert.equal(record.outcome, "success");
  assert.equal(record.settled.pendingCount, 0);
  record.returned.bufferedAmount = -1;
  assert.equal(
    rpc.screenshotTransport().records[0].returned.bufferedAmount,
    42,
  );
  rpc.close();
  assert.equal(f.logs.length, 2);
  assert.equal(
    JSON.stringify([rpc.screenshotTransport(), f.logs]).includes("private-"),
    false,
  );
});

test("timeout receipt is detached; late reply and callback cannot repair failed promise", async () => {
  const f = fixture();
  const rpc = await f.Rpc.connect("ws://private-url");
  const pending = rpc.send("Page.captureScreenshot");
  f.expire();
  let failure;
  await assert.rejects(pending, (error) => {
    failure = error;
    return true;
  });
  assert.equal(
    failure.fixtureCdp.screenshotTransport.records[0].sendCallback,
    "pending",
  );
  f.callbacks[0]();
  rpc.socket.emit(
    "message",
    JSON.stringify({ id: 1, error: { message: "private-late-error" } }),
  );
  rpc.socket.emit(
    "message",
    JSON.stringify({ id: 1, result: { data: "private-second-reply" } }),
  );
  await assert.rejects(pending, (error) => error === failure);
  const record = rpc.screenshotTransport().records[0];
  assert.equal(record.outcome, "timeout");
  assert.equal(record.sendCallback, "ok");
  assert.equal(record.lateReply.outcome, "protocol-error");
  assert.equal(record.lateReply.pendingCount, 0);
  assert.equal(
    failure.fixtureCdp.screenshotTransport.records[0].lateReply,
    undefined,
  );
  rpc.close();
  assert.equal(JSON.stringify(f.logs).includes("private-"), false);
  assert.equal(f.sends.length, 1);
});

test("screenshot close rejects pending and cleanup sink cannot change settlement", async () => {
  const f = fixture({ failSink: true });
  const rpc = await f.Rpc.connect("ws://owned");
  const pending = rpc.send("Page.captureScreenshot");
  rpc.close();
  await assert.rejects(pending, /Fixture CDP socket closed/);
  assert.equal(rpc.screenshotTransport().records[0].outcome, "socket-closed");
  assert.equal(rpc.screenshotTransport().records[0].settled.readyState, 3);
  rpc.socket.emit("error", new Error("private-socket-error"));
  assert.equal(f.logs.length, 2);
  assert.equal(JSON.stringify(f.logs).includes("private-"), false);
});

test("screenshot protocol and synchronous send errors preserve original rejection", async () => {
  const f = fixture();
  const rpc = await f.Rpc.connect("ws://owned");
  const pending = rpc.send("Page.captureScreenshot");
  rpc.socket.emit(
    "message",
    JSON.stringify({ id: 1, error: { message: "private-protocol-error" } }),
  );
  await assert.rejects(pending, /private-protocol-error/);
  assert.equal(rpc.screenshotTransport().records[0].outcome, "protocol-error");
  const error = new Error("private-send-error");
  rpc.socket.send = () => {
    throw error;
  };
  await assert.rejects(rpc.send("Page.captureScreenshot"), (e) => e === error);
  assert.equal(rpc.screenshotTransport().records[1].outcome, "send-threw");
  assert.equal(rpc.screenshotTransport().records[1].transportAccepted, false);
  assert.equal(
    JSON.stringify(rpc.screenshotTransport()).includes("private-"),
    false,
  );
});

test("screenshot tombstones are bounded; evicted replies and non-screenshot calls add no receipts", async () => {
  const f = fixture();
  const rpc = await f.Rpc.connect("ws://owned");
  for (let i = 0; i < 40; i++) {
    const pending = rpc.send("Page.captureScreenshot");
    f.expire();
    await assert.rejects(pending);
  }
  const before = JSON.stringify(rpc.screenshotTransport());
  f.callbacks[0](new Error("private-evicted-error"));
  rpc.socket.emit(
    "message",
    JSON.stringify({ id: 1, result: { data: "private-evicted-reply" } }),
  );
  assert.equal(JSON.stringify(rpc.screenshotTransport()), before);
  assert.equal(rpc.screenshotTransport().records.length, 16);
  assert.equal(rpc.screenshotTransport().records[0].id, 25);
  assert.equal(rpc.screenshotTransport().dropped, 24);
  const input = rpc.send("Input.dispatchKeyEvent");
  assert.equal(f.callbacks[40], undefined);
  rpc.socket.emit("message", JSON.stringify({ id: 41, result: {} }));
  await input;
  assert.equal(JSON.stringify(rpc.screenshotTransport()), before);
});

test("duplicate reply after success or protocol error is not a late timeout reply", async () => {
  for (const failed of [false, true]) {
    const f = fixture();
    const client = await f.Rpc.connect("ws://owned");
    const pending = client.send("Page.captureScreenshot");
    const message = JSON.stringify({
      id: 1,
      ...(failed
        ? { error: { message: "private-protocol-error" } }
        : { result: { data: "private-pixels" } }),
    });
    client.socket.emit("message", message);
    if (failed) await assert.rejects(pending);
    else await pending;
    client.socket.emit("message", message);
    assert.equal(client.screenshotTransport().records[0].lateReply, undefined);
  }
});

for (const silent of [false, true]) {
  test(
    `real loopback WebSocket screenshot ${silent ? "silence preserves timeout" : "callback and response succeed"}`,
    { timeout: 5000 },
    async (t) => {
      const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
      t.after(async () => {
        for (const socket of server.clients) socket.terminate();
        await new Promise((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      });
      await once(server, "listening");
      let received;
      const request = new Promise((resolve) => {
        server.once("connection", (socket) =>
          socket.once("message", (raw) => {
            received = JSON.parse(String(raw));
            if (!silent)
              socket.send(
                JSON.stringify({
                  id: received.id,
                  result: { data: "private-loopback-pixels" },
                }),
              );
            resolve();
          }),
        );
      });
      let expire;
      const logs = [];
      const Rpc = runInNewContext(
        ts.transpileModule(`${rpc.getText(ast)}; Rpc`, {
          compilerOptions: { target: ts.ScriptTarget.ES2022 },
        }).outputText,
        {
          WebSocket,
          assert,
          Date,
          console: { error: (...args) => logs.push(args) },
          setTimeout: (fn, ms) => {
            assert.equal(ms, 10000);
            if (silent) {
              expire = fn;
              return undefined;
            }
            return setTimeout(fn, ms);
          },
          clearTimeout,
        },
      );
      const client = await Rpc.connect(
        `ws://127.0.0.1:${server.address().port}`,
      );
      t.after(() => client.socket.terminate());
      const pending = client.send("Page.captureScreenshot", {
        secret: "private-loopback-param",
      });
      await request;
      assert.equal(received.method, "Page.captureScreenshot");
      if (silent) {
        expire();
        await assert.rejects(pending, (error) => {
          assert.equal(error.fixtureCdp.timeoutMs, 10000);
          assert.equal(error.fixtureCdp.transportAccepted, true);
          return true;
        });
        assert.equal(
          client.screenshotTransport().records[0].outcome,
          "timeout",
        );
      } else {
        assert.equal((await pending).data, "private-loopback-pixels");
        const record = client.screenshotTransport().records[0];
        assert.equal(record.sendCallback, "ok");
        assert.equal(record.outcome, "success");
        assert.equal(record.transportAccepted, true);
        assert.equal(record.settled.pendingCount, 0);
      }
      const closed = once(client.socket, "close");
      client.close();
      await closed;
      assert.equal(client.socket.readyState, WebSocket.CLOSED);
      assert.equal(logs.length, 2);
      assert.equal(JSON.stringify(logs).includes("private-loopback"), false);
      assert.equal(JSON.stringify(logs).includes("127.0.0.1"), false);
    },
  );
}

for (const sessionId of [undefined, "private-session"]) {
  test(`context receipts are passive and session matched (${sessionId ? "scoped" : "root"})`, async () => {
    const f = fixture();
    const client = await f.Rpc.connect("ws://private-url");
    let listenerCalls = 0;
    const remove = client.onEvent(() => listenerCalls++);
    const event = (method, session = sessionId) =>
      client.socket.emit(
        "message",
        JSON.stringify({
          method,
          ...(session === undefined ? {} : { sessionId: session }),
          params: {
            executionContextId: "private-context",
            executionContextUniqueId: "private-unique",
            url: "private-event-url",
          },
        }),
      );
    event("Runtime.executionContextsCleared");
    assert.equal(client.screenshotTransport().records.length, 0);
    const pending = client.send(
      "Page.captureScreenshot",
      { secret: "private-param" },
      sessionId,
    );
    event("Runtime.executionContextsCleared", "private-unrelated");
    event("Runtime.executionContextCreated");
    assert.equal(
      client.screenshotTransport().records[0].contextsClearedCount,
      0,
    );
    f.advance(7);
    event("Runtime.executionContextsCleared");
    remove(); // Original setup listeners can disappear; diagnostics remain passive.
    f.advance(4);
    event("Runtime.executionContextDestroyed");
    event("Runtime.executionContextDestroyed");
    const record = client.screenshotTransport().records[0];
    assert.equal(record.contextsClearedCount, 1);
    assert.equal(record.contextDestroyedCount, 2);
    assert.equal(record.contextFirstElapsedMs, 7);
    assert.equal(record.contextLastElapsedMs, 11);
    assert.equal(record.outcome, "pending");
    assert.equal(listenerCalls, 4);
    record.contextDestroyedCount = -1;
    assert.equal(
      client.screenshotTransport().records[0].contextDestroyedCount,
      2,
    );
    client.socket.emit(
      "message",
      JSON.stringify({ id: 1, result: { data: "private-pixels" } }),
    );
    assert.equal((await pending).data, "private-pixels");
    const settled = JSON.stringify(client.screenshotTransport());
    event("Runtime.executionContextsCleared");
    event("Runtime.executionContextDestroyed");
    assert.equal(JSON.stringify(client.screenshotTransport()), settled);
    client.close();
    assert.equal(
      JSON.stringify([client.screenshotTransport(), f.logs]).includes(
        "private-",
      ),
      false,
    );
    assert.deepEqual(
      f.sends.map((send) => send.method),
      ["Page.captureScreenshot"],
    );
  });
}

test("context receipt counts cap without event history and stop at timeout", async () => {
  const f = fixture();
  const client = await f.Rpc.connect("ws://private-url");
  const pending = client.send("Page.captureScreenshot");
  const event = (method) =>
    client.socket.emit(
      "message",
      JSON.stringify({
        method,
        params: { executionContextId: "private-context" },
      }),
    );
  for (let i = 0; i < 65540; i++) {
    event("Runtime.executionContextsCleared");
    event("Runtime.executionContextDestroyed");
  }
  const record = client.screenshotTransport().records[0];
  assert.equal(record.contextsClearedCount, 65535);
  assert.equal(record.contextDestroyedCount, 65535);
  assert.equal(record.contextFirstElapsedMs, 0);
  assert.equal(record.contextLastElapsedMs, 0);
  assert.ok(JSON.stringify(record).length < 700);
  f.expire();
  let failure;
  await assert.rejects(pending, (error) => {
    failure = error;
    return true;
  });
  const before = JSON.stringify(client.screenshotTransport());
  event("Runtime.executionContextsCleared");
  event("Runtime.executionContextDestroyed");
  assert.equal(JSON.stringify(client.screenshotTransport()), before);
  assert.equal(JSON.stringify(failure.fixtureCdp.screenshotTransport), before);
  client.socket.emit(
    "message",
    JSON.stringify({ id: 1, result: { data: "private-late-pixels" } }),
  );
  await assert.rejects(pending, (error) => error === failure);
  assert.equal(client.screenshotTransport().records[0].outcome, "timeout");
  assert.equal(client.screenshotTransport().records[0].contextLastElapsedMs, 0);
  client.close();
  assert.equal(
    JSON.stringify([failure.fixtureCdp, f.logs]).includes("private-"),
    false,
  );
  assert.deepEqual(
    f.sends.map((send) => send.method),
    ["Page.captureScreenshot"],
  );
});
