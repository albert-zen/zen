import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { connectUserBrowserCdp } from "../src/main/capabilities/user-browser-provider.js";
import {
  createFakeCdpServer,
  deferred,
  waitUntil,
} from "./fixtures/user-browser-cdp.js";

for (const method of ["Page.enable", "Runtime.enable"] as const) {
  test(`${method} awaits its single original response beyond the mutation deadline`, async () => {
    const cdp = await createFakeCdpServer();
    const gate = deferred<void>();
    const connection = await connectUserBrowserCdp(cdp.endpoint);
    let settled = false;
    try {
      await connection.backend.listTabs("work");
      cdp.interceptRequests(async (request) => {
        if (request.method === method) await gate.promise;
      });
      const navigation = connection.backend.navigate(
        "work",
        "target-1",
        "https://example.test/ready",
      );
      const result = navigation.then(
        () => {
          settled = true;
          return undefined;
        },
        (error: unknown) => {
          settled = true;
          return error;
        },
      );
      await waitUntil(() => cdp.count(method) === 1);
      await delay(2_150);
      assert.equal(settled, false, "session setup must have its own deadline");
      assert.equal(cdp.count("Page.navigate"), 0);
      assert.equal(cdp.count("Runtime.evaluate"), 0);
      assert.equal(cdp.count("Input.dispatchKeyEvent"), 0);
      assert.equal(cdp.count("Target.detachFromTarget"), 0);
      gate.resolve();
      assert.equal(await result, undefined);
      assert.equal(cdp.count("Target.attachToTarget"), 1);
      assert.equal(cdp.count("Page.enable"), 1);
      assert.equal(cdp.count("Runtime.enable"), 1);
      assert.equal(cdp.count("Page.navigate"), 1);
      await connection.backend.closeSession("work");
    } finally {
      gate.resolve();
      await Promise.resolve(connection.backend.close()).catch(() => undefined);
      await cdp.close();
    }
  });
}

test("live observation cannot bypass an in-flight attachment initialization", async () => {
  const cdp = await createFakeCdpServer();
  const gate = deferred<void>();
  const connection = await connectUserBrowserCdp(cdp.endpoint);
  let stop: (() => void) | undefined;
  try {
    await connection.backend.listTabs("work");
    cdp.interceptRequests(async (request) => {
      if (request.method === "Page.enable") await gate.promise;
    });
    const inspection = connection.backend.inspect("work", "target-1");
    const result = inspection.catch((error: unknown) => error);
    await waitUntil(() => cdp.count("Page.enable") === 1);
    stop = connection.backend.observeTab!("work", "target-1", () => undefined);
    await delay(50);
    assert.equal(
      cdp.count("Page.getFrameTree"),
      0,
      "all callers must await setup",
    );
    assert.equal(cdp.count("Page.createIsolatedWorld"), 0);
    assert.equal(cdp.count("Runtime.evaluate"), 0);
    gate.resolve();
    assert.ok(!((await result) instanceof Error));
    assert.equal(cdp.count("Target.attachToTarget"), 1);
    assert.equal(cdp.count("Page.enable"), 1);
    assert.equal(cdp.count("Runtime.enable"), 1);
  } finally {
    gate.resolve();
    stop?.();
    await Promise.resolve(connection.backend.close()).catch(() => undefined);
    await cdp.close();
  }
});

for (const method of ["Page.enable", "Runtime.enable"] as const) {
  for (const route of ["wrong", "missing"] as const) {
    test(`${method} rejects a ${route} response session without releasing setup`, async () => {
      const cdp = await createFakeCdpServer();
      const connection = await connectUserBrowserCdp(cdp.endpoint);
      try {
        await connection.backend.listTabs("work");
        if (method === "Page.enable") cdp.dropNextEnableReply();
        else cdp.dropNextRuntimeEnableReply();
        cdp.interceptRequests((request, emit) => {
          if (request.method === method)
            emit({
              id: request.id,
              result: {},
              sessionId: route === "wrong" ? "stale-session" : undefined,
            });
        });
        await assert.rejects(
          connection.backend.navigate(
            "work",
            "target-1",
            "https://example.test/ready",
          ),
          /session did not match|outcome is unknown/u,
        );
        assert.equal(cdp.count("Page.navigate"), 0);
        assert.equal(cdp.count("Runtime.evaluate"), 0);
        assert.equal(cdp.count(method), 1);
        assert.equal(cdp.count("Target.detachFromTarget"), 1);
        assert.deepEqual(cdp.detachedSessionIds(), [cdp.latestSessionId()]);
        await assert.rejects(
          Promise.resolve(connection.backend.close()),
          /unknown|tainted/u,
        );
      } finally {
        await Promise.resolve(connection.backend.close()).catch(
          () => undefined,
        );
        await cdp.close();
      }
    });
  }

  test(`${method} abort preserves the unknown outcome and never navigates`, async () => {
    const cdp = await createFakeCdpServer();
    const connection = await connectUserBrowserCdp(cdp.endpoint);
    const controller = new AbortController();
    try {
      await connection.backend.listTabs("work");
      if (method === "Page.enable") cdp.dropNextEnableReply();
      else cdp.dropNextRuntimeEnableReply();
      const result = connection.backend
        .navigate(
          "work",
          "target-1",
          "https://example.test/ready",
          controller.signal,
        )
        .catch((error: unknown) => error);
      await waitUntil(() => cdp.count(method) === 1);
      controller.abort(new Error("cancel setup"));
      assert.match(String(await result), /cancel setup|unknown/u);
      await waitUntil(() => cdp.count("Target.detachFromTarget") === 1);
      assert.equal(cdp.count("Page.navigate"), 0);
      assert.equal(cdp.count(method), 1);
      await assert.rejects(
        Promise.resolve(connection.backend.closeSession("work")),
        /unknown|tainted/u,
      );
    } finally {
      await Promise.resolve(connection.backend.close()).catch(() => undefined);
      await cdp.close();
    }
  });

  for (const termination of ["detach", "destroy", "disconnect"] as const) {
    test(`${method} ${termination} settles pending setup promptly without page code`, async () => {
      const cdp = await createFakeCdpServer();
      const connection = await connectUserBrowserCdp(cdp.endpoint);
      try {
        await connection.backend.listTabs("work");
        if (method === "Page.enable") cdp.dropNextEnableReply();
        else cdp.dropNextRuntimeEnableReply();
        const result = connection.backend
          .inspect("work", "target-1")
          .catch((error: unknown) => error);
        await waitUntil(() => cdp.count(method) === 1);
        if (termination === "detach")
          cdp.emitDetached(cdp.latestSessionId(), "target-1");
        else if (termination === "destroy") cdp.destroyTarget("target-1");
        else cdp.disconnect();
        const outcome = await Promise.race([
          result,
          delay(500).then(() => "still pending"),
        ]);
        assert.ok(outcome instanceof Error, String(outcome));
        assert.equal(cdp.count("Runtime.evaluate"), 0);
        assert.equal(cdp.count("Page.getFrameTree"), 0);
        assert.equal(cdp.count(method), 1);
        await assert.rejects(
          Promise.resolve(connection.backend.close()),
          /unknown|tainted/u,
        );
      } finally {
        await Promise.resolve(connection.backend.close()).catch(
          () => undefined,
        );
        await cdp.close();
      }
    });
  }
}

test("Page and Runtime setup share one total deadline and late success cannot navigate", async () => {
  const cdp = await createFakeCdpServer();
  const connection = await connectUserBrowserCdp(cdp.endpoint);
  const gate = deferred<void>();
  try {
    await connection.backend.listTabs("work");
    cdp.interceptRequests(async (request) => {
      if (request.method === "Page.enable") await delay(6_000);
      if (request.method === "Runtime.enable") await gate.promise;
    });
    const started = performance.now();
    await assert.rejects(
      connection.backend.navigate(
        "work",
        "target-1",
        "https://example.test/ready",
      ),
      /Runtime.enable outcome is unknown/u,
    );
    const elapsed = performance.now() - started;
    assert.ok(
      elapsed >= 9_500 && elapsed < 11_500,
      `shared setup budget elapsed ${elapsed}ms`,
    );
    assert.equal(cdp.count("Page.enable"), 1);
    assert.equal(cdp.count("Runtime.enable"), 1);
    assert.equal(cdp.count("Target.detachFromTarget"), 1);
    gate.resolve();
    await delay(20);
    assert.equal(cdp.count("Page.navigate"), 0);
    await assert.rejects(
      Promise.resolve(connection.backend.close()),
      /unknown|tainted/u,
    );
  } finally {
    gate.resolve();
    await Promise.resolve(connection.backend.close()).catch(() => undefined);
    await cdp.close();
  }
});

test("navigation retains its two-second mutation deadline after successful setup", async () => {
  const cdp = await createFakeCdpServer();
  const connection = await connectUserBrowserCdp(cdp.endpoint);
  const gate = deferred<void>();
  try {
    await connection.backend.listTabs("work");
    cdp.interceptRequests(async (request) => {
      if (request.method === "Page.navigate") await gate.promise;
    });
    const started = performance.now();
    await assert.rejects(
      connection.backend.navigate(
        "work",
        "target-1",
        "https://example.test/ready",
      ),
      /outcome is unknown/u,
    );
    const elapsed = performance.now() - started;
    assert.ok(
      elapsed >= 1_900 && elapsed < 3_500,
      `mutation deadline elapsed ${elapsed}ms`,
    );
    gate.resolve();
    await delay(20);
    assert.equal(cdp.count("Page.navigate"), 1);
    await assert.rejects(
      Promise.resolve(connection.backend.close()),
      /unknown|tainted/u,
    );
  } finally {
    gate.resolve();
    await Promise.resolve(connection.backend.close()).catch(() => undefined);
    await cdp.close();
  }
});

test("backend close joins active setup and preserves a failed setup outcome", async () => {
  const cdp = await createFakeCdpServer();
  const connection = await connectUserBrowserCdp(cdp.endpoint);
  const controller = new AbortController();
  try {
    await connection.backend.listTabs("work");
    cdp.dropNextRuntimeEnableReply();
    const operation = connection.backend
      .inspect("work", "target-1", controller.signal)
      .catch((error: unknown) => error);
    await waitUntil(() => cdp.count("Runtime.enable") === 1);
    let closeSettled = false;
    const close = Promise.resolve(connection.backend.close()).then(
      () => {
        closeSettled = true;
        return undefined;
      },
      (error: unknown) => {
        closeSettled = true;
        return error;
      },
    );
    await delay(20);
    assert.equal(closeSettled, false);
    controller.abort(new Error("cancel setup during close"));
    assert.ok((await operation) instanceof Error);
    assert.ok((await close) instanceof Error);
    assert.equal(cdp.count("Runtime.evaluate"), 0);
    assert.equal(cdp.count("Target.detachFromTarget"), 1);
    assert.equal(cdp.count("Runtime.enable"), 1);
  } finally {
    await Promise.resolve(connection.backend.close()).catch(() => undefined);
    await cdp.close();
  }
});

test("wrong-route attach reply retains compensation for the original real session", async () => {
  const cdp = await createFakeCdpServer();
  const connection = await connectUserBrowserCdp(cdp.endpoint);
  try {
    await connection.backend.listTabs("work");
    cdp.holdNextAttachReply();
    cdp.interceptRequests((request, emit) => {
      if (request.method === "Target.attachToTarget")
        emit({
          id: request.id,
          sessionId: "foreign-route",
          result: { sessionId: "foreign-attachment" },
        });
    });
    await assert.rejects(
      connection.backend.inspect("work", "target-1"),
      /session did not match|unknown/u,
    );
    assert.equal(cdp.count("Target.detachFromTarget"), 0);
    cdp.releaseLateAttachReply();
    await delay(50);
    assert.equal(cdp.count("Target.detachFromTarget"), 1);
    assert.deepEqual(cdp.detachedSessionIds(), [cdp.latestSessionId()]);
    assert.equal(cdp.count("Target.attachToTarget"), 1);
    assert.equal(cdp.count("Page.enable"), 0);
    await assert.rejects(
      Promise.resolve(connection.backend.close()),
      /unknown|tainted/u,
    );
  } finally {
    await Promise.resolve(connection.backend.close()).catch(() => undefined);
    await cdp.close();
  }
});

test("wrong-route input reply retains original settlement without replay or early detach", async () => {
  const cdp = await createFakeCdpServer({ targetedInput: true });
  const connection = await connectUserBrowserCdp(cdp.endpoint);
  const gate = deferred<void>();
  try {
    await connection.backend.listTabs("work");
    const observation = await connection.backend.inspect("work", "target-1");
    cdp.interceptRequests(async (request, emit) => {
      if (request.method === "Input.dispatchKeyEvent") {
        emit({ id: request.id, sessionId: "foreign-route", result: {} });
        await gate.promise;
      }
    });
    await assert.rejects(
      connection.backend.keyPress!(
        "work",
        "target-1",
        observation.observationId,
        "Enter",
      ),
      /outcome is unknown/u,
    );
    let closeSettled = false;
    const close = Promise.resolve(connection.backend.close()).then(
      () => {
        closeSettled = true;
        return undefined;
      },
      (error: unknown) => {
        closeSettled = true;
        return error;
      },
    );
    await delay(50);
    assert.equal(
      closeSettled,
      false,
      "close must await the original input settlement",
    );
    assert.equal(cdp.count("Target.detachFromTarget"), 0);
    gate.resolve();
    assert.ok((await close) instanceof Error);
    assert.equal(
      cdp.count("Input.dispatchKeyEvent"),
      1,
      "never replay or send a guessed release",
    );
    assert.equal(cdp.count("Target.detachFromTarget"), 1);
  } finally {
    gate.resolve();
    await Promise.resolve(connection.backend.close()).catch(() => undefined);
    await cdp.close();
  }
});
