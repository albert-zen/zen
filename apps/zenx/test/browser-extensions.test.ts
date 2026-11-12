import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import path from "node:path";
import { BrowserEventBuffer } from "../src/main/capabilities/browser-extensions.js";
import { connectUserBrowserCdp } from "../src/main/capabilities/user-browser-provider.js";
import { createFakeCdpServer, nextTurn } from "./fixtures/user-browser-cdp.js";

test("event pages retain raw bytes, bound model output and reject foreign/evicted cursors", async () => {
  const buffer = new BrowserEventBuffer();
  try {
    buffer.push("Network.responseReceived", {
      requestId: "r",
      body: "x".repeat(30000),
    });
    const first = (await buffer.read(undefined, 1)) as any;
    assert.equal(first.events[0].rawOnly, true);
    assert.equal(
      JSON.parse(await readFile(first.rawPath, "utf8"))[0].params.body.length,
      30000,
    );
    assert.ok(JSON.stringify(first.events).length < 2000);
    assert.equal(first.rawEvents[0].params.body.length, 30000);
    await assert.rejects(buffer.read("foreign:1"), /another attachment/);
    for (let i = 0; i < 2001; i++) buffer.push("event", { i });
    await assert.rejects(buffer.read(first.eventCursor), /evicted/);
    const latest = (await buffer.read()) as any;
    assert.equal(latest.retainedEvents, 2000);
    assert.ok(latest.droppedThrough > 0);
    assert.equal(
      JSON.parse(await readFile(first.rawPath, "utf8"))[0].params.body.length,
      30000,
    );
  } finally {
    await buffer.close();
  }
  await assert.rejects(buffer.read(), /closed/);
});

test("connected CDP events are opt-in, persist across calls and stay on exact attachment", async () => {
  const cdp = await createFakeCdpServer();
  const connection = await connectUserBrowserCdp(cdp.endpoint);
  try {
    await connection.backend.listTabs("one");
    const extension = connection.backend.extension!.bind(connection.backend);
    await assert.rejects(
      extension("one", "target-1", "network_read", {}),
      /start collection explicitly/,
    );
    assert.equal(cdp.count("Network.enable"), 0);
    await extension("one", "target-1", "network_start", {});
    assert.equal(cdp.count("Network.enable"), 1);
    cdp.emitSessionEvent("Network.responseReceived", {
      requestId: "owned",
      response: { url: "https://synthetic.test/", status: 200 },
    });
    cdp.emitSessionEvent(
      "Network.responseReceived",
      { requestId: "foreign" },
      "foreign-session",
    );
    await nextTurn();
    const read = (await extension(
      "one",
      "target-1",
      "network_read",
      {},
    )) as any;
    assert.equal(read.events.length, 1);
    assert.equal(read.events[0].params.requestId, "owned");
    await extension("one", "target-1", "network_start", {});
    assert.equal(cdp.count("Network.enable"), 1);
    await assert.rejects(
      extension("one", "target-1", "network_response", {
        requestId: "foreign",
      }),
      /not observed/,
    );
    await extension("one", "target-1", "network_response", {
      requestId: "owned",
    });
    assert.equal(cdp.count("Network.getResponseBody"), 1);
    await extension("one", "target-1", "console_start", {});
    cdp.emitSessionEvent("Runtime.consoleAPICalled", {
      type: "log",
      args: [{ value: "synthetic" }],
    });
    await nextTurn();
    const logged = (await extension(
      "one",
      "target-1",
      "console_read",
      {},
    )) as any;
    assert.equal(logged.events.length, 1);
    await assert.rejects(
      extension("two", "target-1", "network_read", {}),
      /session|owned|tab/i,
    );
    await connection.backend.closeSession("one");
    await assert.rejects(
      extension("one", "target-1", "network_read", {}),
      /session|closed|tab/i,
    );
  } finally {
    await Promise.resolve(connection.backend.close()).catch(() => undefined);
    await cdp.close();
  }
});

test("connected evaluate uses separate world and consumes latest action observation", async () => {
  const cdp = await createFakeCdpServer();
  const connection = await connectUserBrowserCdp(cdp.endpoint);
  try {
    await connection.backend.listTabs("one");
    const observation = await connection.backend.inspect("one", "target-1");
    cdp.interceptRequests(async (request, send) => {
      if (
        request.method === "Runtime.evaluate" &&
        String(request.params.expression).includes("ok:true,value:await")
      )
        send({
          id: request.id,
          result: { result: { value: { ok: true, value: 42 } } },
        });
    });
    const result = await connection.backend.extension!(
      "one",
      "target-1",
      "evaluate",
      { observationId: observation.observationId, expression: "21*2" },
    );
    assert.deepEqual(result, { value: 42 });
    assert.ok(
      cdp
        .requests("Page.createIsolatedWorld")
        .some((r) => r.worldName === "zenx-browser-programmable-v1"),
    );
    await assert.rejects(
      connection.backend.extension!("one", "target-1", "evaluate", {
        observationId: observation.observationId,
        expression: "21*2",
      }),
      /observation|inspect/i,
    );
  } finally {
    await Promise.resolve(connection.backend.close()).catch(() => undefined);
    await cdp.close();
  }
});

for (const invalidated of [false, true])
  test(`connected main-world evaluation pins exact unique context (invalidated=${invalidated})`, async () => {
    const cdp = await createFakeCdpServer();
    const connection = await connectUserBrowserCdp(cdp.endpoint);
    try {
      await connection.backend.listTabs("one");
      const observed = await connection.backend.inspect("one", "target-1");
      cdp.emitSessionEvent("Runtime.executionContextCreated", {
        context: {
          id: 21,
          uniqueId: "synthetic-main-unique",
          name: "",
          auxData: { isDefault: true, frameId: "main" },
        },
      });
      await nextTurn();
      let evaluations = 0;
      cdp.interceptRequests(async (request, send) => {
        if (invalidated && request.method === "Page.getFrameTree")
          send({
            method: "Runtime.executionContextDestroyed",
            sessionId: request.sessionId,
            params: { executionContextId: 21 },
          });
        if (
          request.method === "Runtime.evaluate" &&
          String(request.params.expression).includes("ok:true,value:await")
        ) {
          evaluations++;
          assert.equal(request.params.uniqueContextId, "synthetic-main-unique");
          assert.equal(request.params.contextId, undefined);
          send({
            id: request.id,
            result: { result: { value: { ok: true, value: 42 } } },
          });
        }
      });
      const call = connection.backend.extension!(
        "one",
        "target-1",
        "evaluate",
        {
          observationId: observed.observationId,
          expression: "window.applicationGlobal",
          world: "main",
        },
      );
      if (invalidated) {
        await assert.rejects(call, /main-world.*unavailable|document changed/i);
        assert.equal(evaluations, 0);
      } else {
        assert.deepEqual(await call, { value: 42 });
        assert.equal(evaluations, 1);
      }
    } finally {
      await Promise.resolve(connection.backend.close()).catch(() => undefined);
      await cdp.close();
    }
  });

test("parallel first event reads share raw directory and close removes every capture", async () => {
  const buffer = new BrowserEventBuffer();
  buffer.push("event", { synthetic: true });
  const results = (await Promise.all([buffer.read(), buffer.read()])) as Array<{
    rawPath: string;
  }>;
  assert.equal(
    path.dirname(results[0]!.rawPath),
    path.dirname(results[1]!.rawPath),
  );
  assert.notEqual(results[0]!.rawPath, results[1]!.rawPath);
  await buffer.close();
  for (const value of results)
    await assert.rejects(readFile(value.rawPath), /ENOENT/);
  const closing = new BrowserEventBuffer();
  closing.push("event", {});
  const read = closing.read();
  const close = closing.close();
  await assert.rejects(read, /closed|ENOENT/);
  await close;
});

for (const scenario of [
  "old-after-start",
  "replacement-before-commit",
  "commit-without-start",
  "same-document",
  "frame-detached",
] as const)
  test(`Connected main context lifecycle: ${scenario}`, async () => {
    const cdp = await createFakeCdpServer();
    const connection = await connectUserBrowserCdp(cdp.endpoint);
    try {
      await connection.backend.listTabs("one");
      await connection.backend.inspect("one", "target-1");
      const created = (id: number) =>
        cdp.emitSessionEvent("Runtime.executionContextCreated", {
          context: {
            id,
            uniqueId: `main-unique-${id}`,
            name: "",
            auxData: { isDefault: true, frameId: "main" },
          },
        });
      created(20);
      await nextTurn();
      const start = () =>
        cdp.emitSessionEvent("Page.frameStartedNavigating", {
          frameId: "main",
          navigationType: "differentDocument",
          url: "https://example.test/next",
        });
      const commit = () =>
        cdp.emitSessionEvent("Page.frameNavigated", {
          frame: {
            id: "main",
            loaderId: "next-loader",
            url: "https://example.test/next",
          },
        });
      if (scenario === "old-after-start") {
        start();
        commit();
      }
      if (scenario === "replacement-before-commit") {
        start();
        created(21);
        commit();
      }
      if (scenario === "commit-without-start") commit();
      if (scenario === "same-document") {
        cdp.emitSessionEvent("Page.frameStartedNavigating", {
          frameId: "main",
          navigationType: "sameDocument",
        });
        cdp.emitSessionEvent("Page.navigatedWithinDocument", {
          frameId: "main",
          url: "https://example.test/account#hash",
        });
      }
      if (scenario === "frame-detached")
        cdp.emitSessionEvent("Page.frameDetached", {
          frameId: "main",
          reason: "swap",
        });
      await nextTurn();
      const dispatched: string[] = [];
      cdp.interceptRequests(async (request, send) => {
        if (
          request.method === "Runtime.evaluate" &&
          String(request.params.expression).includes("ok:true,value:await")
        ) {
          dispatched.push(String(request.params.uniqueContextId));
          send({
            id: request.id,
            result: { result: { value: { ok: true, value: 42 } } },
          });
        }
      });
      const evaluate = async () => {
        const view = await connection.backend.inspect("one", "target-1");
        return connection.backend.extension!("one", "target-1", "evaluate", {
          observationId: view.observationId,
          expression: "window.applicationGlobal",
          world: "main",
        });
      };
      if (
        scenario === "replacement-before-commit" ||
        scenario === "same-document"
      ) {
        assert.deepEqual(await evaluate(), { value: 42 });
        assert.deepEqual(dispatched, [
          scenario === "same-document" ? "main-unique-20" : "main-unique-21",
        ]);
      } else {
        await assert.rejects(
          evaluate(),
          /main-world execution context unavailable/,
        );
        assert.equal(dispatched.length, 0);
        // A genuinely new context observed after the commit restores explicit main evaluation.
        created(22);
        await nextTurn();
        assert.deepEqual(await evaluate(), { value: 42 });
        assert.deepEqual(dispatched, ["main-unique-22"]);
      }
    } finally {
      await Promise.resolve(connection.backend.close()).catch(() => undefined);
      await cdp.close();
    }
  });
