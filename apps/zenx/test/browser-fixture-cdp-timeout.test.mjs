import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
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
function fixture() {
  let timer,
    now = 10;
  const sends = [];
  class Socket extends EventEmitter {
    constructor() {
      super();
      queueMicrotask(() => this.emit("open"));
    }
    send(value) {
      sends.push(JSON.parse(value));
    }
    close() {
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
