import assert from "node:assert/strict";
import test from "node:test";
import {
  PlaywrightTargetTransport,
  type PlaywrightCdpMessage,
  type PlaywrightTargetCdp,
} from "../experiments/playwright/target-transport.js";
function fixture(sendOverride?: PlaywrightTargetCdp["send"]) {
  const messages: PlaywrightCdpMessage[] = [];
  const calls: Array<{
    method: string;
    params: Record<string, unknown>;
    sessionId?: string;
  }> = [];
  let listener: Parameters<PlaywrightTargetCdp["subscribe"]>[0] = () => {};
  let unsubscribed = false;
  const transport = new PlaywrightTargetTransport({
    version: {
      product: "Chrome/152.0",
      userAgent: "Chrome/152.0",
      protocolVersion: "1.3",
      revision: "",
      jsVersion: "test",
    },
    target: {
      targetId: "owned",
      url: "https://fixture.test",
      title: "Fixture",
    },
    emit: (message) => messages.push(message),
    cdp: {
      async send(method, params, sessionId) {
        calls.push({ method, params, sessionId });
        if (sendOverride) return await sendOverride(method, params, sessionId);
        return method === "Browser.getVersion"
          ? { product: "Chrome/152.0", userAgent: "Chrome/152.0" }
          : {};
      },
      subscribe(next) {
        listener = next;
        return () => {
          unsubscribed = true;
        };
      },
    },
  });
  return {
    transport,
    messages,
    calls,
    event: (...args: Parameters<typeof listener>) => listener(...args),
    unsubscribed: () => unsubscribed,
  };
}
const attach = {
  id: 1,
  method: "Target.setAutoAttach",
  params: { autoAttach: true, waitForDebuggerOnStart: true, flatten: true },
};
test("public Playwright browser handshake exposes only the admitted page", async () => {
  const f = fixture();
  await f.transport.receive({ id: 1, method: "Browser.getVersion" });
  await f.transport.receive(attach);
  await f.transport.receive({ id: 3, method: "Target.getTargets" });
  assert.equal(f.calls.length, 0);
  assert.equal(
    f.messages.filter((m) => m.method === "Target.attachedToTarget").length,
    1,
  );
  const result = f.messages.at(-1)?.result as {
    targetInfos: Array<{ targetId: string }>;
  };
  assert.deepEqual(
    result.targetInfos.map((t) => t.targetId),
    ["owned"],
  );
  await f.transport.receive(attach);
  assert.equal(
    f.messages.filter((m) => m.method === "Target.attachedToTarget").length,
    1,
  );
});
test("browser-wide operations and foreign identities never reach the native debugger", async () => {
  const f = fixture();
  await f.transport.receive({
    id: 1,
    method: "Target.getTargetInfo",
    params: { targetId: "foreign" },
  });
  await f.transport.receive({
    id: 2,
    method: "Target.createTarget",
    params: { url: "about:blank" },
  });
  await f.transport.receive({ id: 3, method: "Browser.close" });
  await f.transport.receive({
    id: 4,
    method: "Runtime.evaluate",
    params: { expression: "1" },
    sessionId: "foreign",
  });
  assert.equal(f.calls.length, 0);
  assert.equal(f.messages.filter((m) => m.error).length, 4);
});
test("page commands and nested frame events keep exact session routing", async () => {
  const f = fixture();
  await f.transport.receive(attach);
  await f.transport.receive({
    id: 2,
    method: "Page.enable",
    sessionId: "zenx-page",
  });
  f.event("Runtime.executionContextCreated", { context: { id: 1 } });
  f.event("Target.attachedToTarget", {
    sessionId: "frame",
    targetInfo: { type: "iframe", targetId: "frame-target" },
  });
  await f.transport.receive({
    id: 3,
    method: "Runtime.enable",
    sessionId: "frame",
  });
  f.event("Runtime.executionContextCreated", { context: { id: 2 } }, "frame");
  f.event("Runtime.executionContextCreated", { context: { id: 3 } }, "foreign");
  assert.equal(f.calls[0]?.sessionId, undefined);
  assert.equal(f.calls[1]?.sessionId, "frame");
  assert.equal(
    f.messages.filter((m) => m.method === "Runtime.executionContextCreated")
      .length,
    2,
  );
  f.event("Target.detachedFromTarget", { sessionId: "frame" });
  await f.transport.receive({
    id: 4,
    method: "Runtime.enable",
    sessionId: "frame",
  });
  assert.ok(f.messages.at(-1)?.error);
});
test("closing releases listeners and drops late messages without closing the page", async () => {
  const f = fixture();
  f.transport.close();
  f.transport.close();
  await f.transport.receive({ id: 1, method: "Browser.close" });
  f.event("Runtime.consoleAPICalled", {});
  assert.equal(f.unsubscribed(), true);
  assert.deepEqual(f.messages, []);
  assert.deepEqual(f.calls, []);
});

test("retiring a frame also retires its descendant sessions", async () => {
  const f = fixture();
  await f.transport.receive(attach);
  f.event("Target.attachedToTarget", {
    sessionId: "parent",
    targetInfo: { type: "iframe" },
  });
  f.event(
    "Target.attachedToTarget",
    { sessionId: "child", targetInfo: { type: "worker" } },
    "parent",
  );
  f.event("Target.detachedFromTarget", { sessionId: "parent" });
  await f.transport.receive({
    id: 9,
    method: "Runtime.enable",
    sessionId: "child",
  });
  assert.ok(f.messages.at(-1)?.error);
  assert.equal(f.calls.length, 0);
});

test("disconnect disables only its page autoattach and never addresses already detached children", async () => {
  const f = fixture();
  await f.transport.receive(attach);
  await f.transport.receive({
    id: 2,
    method: "Target.setAutoAttach",
    sessionId: "zenx-page",
    params: { autoAttach: true, flatten: true, waitForDebuggerOnStart: true },
  });
  const params = f.calls[0]?.params;
  assert.deepEqual(params?.filter, [
    { type: "iframe", exclude: false },
    { type: "worker", exclude: false },
    { exclude: true },
  ]);
  f.event("Target.attachedToTarget", {
    sessionId: "child",
    targetInfo: { type: "iframe" },
  });
  await f.transport.close();
  assert.deepEqual(f.calls.at(-1), {
    method: "Target.setAutoAttach",
    params: { autoAttach: false, waitForDebuggerOnStart: false, flatten: true },
    sessionId: undefined,
  });
  assert.equal(f.calls.length, 2);
});

test("disconnect drains an accepted autoattach before disabling it and drops its late reply", async () => {
  let release!: () => void;
  const delayed = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = fixture(async (method, params) => {
    if (method === "Target.setAutoAttach" && params.autoAttach === true)
      await delayed;
    return {};
  });
  await f.transport.receive(attach);
  const inFlight = f.transport.receive({
    id: 7,
    method: "Target.setAutoAttach",
    sessionId: "zenx-page",
    params: { autoAttach: true, flatten: true, waitForDebuggerOnStart: true },
  });
  const closing = f.transport.close();
  assert.equal(f.calls.length, 1);
  release();
  await inFlight;
  await closing;
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1]?.params.autoAttach, false);
  assert.equal(
    f.messages.some((message) => message.id === 7),
    false,
  );
});
