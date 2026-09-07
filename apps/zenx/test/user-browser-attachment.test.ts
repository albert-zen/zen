import assert from "node:assert/strict";
import test from "node:test";
import { connectUserBrowserCdp } from "../src/main/capabilities/user-browser-provider.js";
import {
  createFakeCdpServer,
  nextTurn,
  waitUntil,
} from "./fixtures/user-browser-cdp.js";

test("attach timeout remains owned and makes session and backend close honest", async () => {
  const cdp = await createFakeCdpServer();
  try {
    const connection = await connectUserBrowserCdp(cdp.endpoint);
    await connection.backend.listTabs("work");
    cdp.dropNextAttachReply();
    await assert.rejects(
      connection.backend.inspect("work", "target-1"),
      /attachToTarget outcome is unknown|document changed/u,
    );
    await assert.rejects(
      async () => await connection.backend.closeSession("work"),
      /outcome is unknown|tainted/u,
    );
    await assert.rejects(
      async () => await connection.backend.close(),
      /outcome is unknown|tainted/u,
    );
    assert.equal(cdp.count("Target.closeTarget"), 0);
  } finally {
    await cdp.close();
  }
});

test("known attach Page.enable and Runtime.enable failures remain retryable without taint", async () => {
  for (const failure of ["attach", "page-enable", "runtime-enable"] as const) {
    const cdp = await createFakeCdpServer();
    try {
      const connection = await connectUserBrowserCdp(cdp.endpoint);
      await connection.backend.listTabs("work");
      if (failure === "attach") cdp.failNextAttachReply();
      else if (failure === "page-enable") cdp.failNextEnableReply();
      else cdp.failNextRuntimeEnableReply();
      await assert.rejects(
        connection.backend.inspect("work", "target-1"),
        /command failed/u,
      );
      assert.equal(
        cdp.count("Target.detachFromTarget"),
        failure === "attach" ? 0 : 1,
      );
      await connection.backend.inspect("work", "target-1");
      assert.equal(await connection.backend.closeSession("work"), 1);
      await connection.backend.close();
    } finally {
      await cdp.close();
    }
  }
});

test("stale detachedFromTarget for s1 cannot reap successor s2", async () => {
  const cdp = await createFakeCdpServer();
  try {
    const connection = await connectUserBrowserCdp(cdp.endpoint);
    await connection.backend.listTabs("work");
    await connection.backend.inspect("work", "target-1");
    const s1 = cdp.latestSessionId();
    cdp.emitDetached(s1, "target-1");
    await connection.backend.listTabs("work");
    await connection.backend.inspect("work", "target-1");
    const s2 = cdp.latestSessionId();
    assert.notEqual(s2, s1);

    cdp.emitDetached(s1, "target-1");
    await connection.backend.listTabs("work");
    assert.equal(await connection.backend.closeSession("work"), 1);
    assert.deepEqual(cdp.detachedSessionIds(), [s2]);
    await connection.backend.close();
  } finally {
    await cdp.close();
  }
});

test("unknown detachedFromTarget cannot use deprecated targetId to reap current attachment", async () => {
  const cdp = await createFakeCdpServer();
  try {
    const connection = await connectUserBrowserCdp(cdp.endpoint);
    await connection.backend.listTabs("work");
    await connection.backend.inspect("work", "target-1");
    const current = cdp.latestSessionId();
    cdp.emitDetached("unknown-session", "target-1");
    await connection.backend.listTabs("work");

    await assert.rejects(
      async () => await connection.backend.closeSession("work"),
      /lifecycle|outcome is unknown|tainted/u,
    );
    assert.deepEqual(cdp.detachedSessionIds(), [current]);
    await assert.rejects(
      async () => await connection.backend.close(),
      /outcome is unknown|tainted/u,
    );
  } finally {
    await cdp.close();
  }
});

test("pending attach correlates a pre-response detach without leaking or reaping a successor", async () => {
  const cdp = await createFakeCdpServer();
  try {
    const connection = await connectUserBrowserCdp(cdp.endpoint);
    await connection.backend.listTabs("work");
    cdp.holdNextAttachReply();
    const inspection = connection.backend.inspect("work", "target-1");
    await waitUntil(() => cdp.count("Target.attachToTarget") === 1);
    const pendingSession = cdp.latestSessionId();
    cdp.emitDetached(pendingSession, "target-1");
    cdp.releaseLateAttachReply();
    await assert.rejects(inspection, /detached during attachment/u);

    await connection.backend.inspect("work", "target-1");
    const successor = cdp.latestSessionId();
    assert.notEqual(successor, pendingSession);
    assert.equal(await connection.backend.closeSession("work"), 1);
    assert.deepEqual(cdp.detachedSessionIds(), [successor]);
    await connection.backend.close();
  } finally {
    await cdp.close();
  }
});

test("repeated stale and unknown detach evidence stays bounded and preserves current ownership", async () => {
  const cdp = await createFakeCdpServer();
  try {
    const connection = await connectUserBrowserCdp(cdp.endpoint);
    await connection.backend.listTabs("work");
    await connection.backend.inspect("work", "target-1");
    const s1 = cdp.latestSessionId();
    cdp.emitDetached(s1, "target-1");
    await connection.backend.listTabs("work");
    await connection.backend.inspect("work", "target-1");
    const s2 = cdp.latestSessionId();
    for (let index = 0; index < 256; index += 1) {
      cdp.emitDetached(s1, "target-1");
      cdp.emitDetached("unknown-session", "target-1");
    }
    await connection.backend.listTabs("work");

    const failure = await Promise.resolve(
      connection.backend.closeSession("work"),
    ).then(
      () => undefined,
      (error: unknown) => error,
    );
    assert.ok(failure instanceof Error);
    assert.match(failure.message, /lifecycle|outcome is unknown|tainted/u);
    assert.ok(failure.message.length < 2_000, "diagnostics must stay bounded");
    assert.deepEqual(cdp.detachedSessionIds(), [s2]);
    await assert.rejects(
      async () => await connection.backend.close(),
      /outcome is unknown|tainted/u,
    );
  } finally {
    await cdp.close();
  }
});

test("late attach compensation preserves bounded historical unknown evidence", async () => {
  const cdp = await createFakeCdpServer();
  try {
    const connection = await connectUserBrowserCdp(cdp.endpoint);
    await connection.backend.listTabs("work");
    cdp.holdNextAttachReply();
    await assert.rejects(
      connection.backend.inspect("work", "target-1"),
      /attachToTarget outcome is unknown|document changed/u,
    );
    cdp.releaseLateAttachReply();
    await waitUntil(() => cdp.count("Target.detachFromTarget") === 1);
    const lateSession = cdp.latestSessionId();
    assert.deepEqual(cdp.detachedSessionIds(), [lateSession]);
    const sessionFailure = await Promise.resolve(
      connection.backend.closeSession("work"),
    ).then(
      () => undefined,
      (error: unknown) => error,
    );
    assert.ok(sessionFailure instanceof Error);
    assert.match(sessionFailure.message, /outcome is unknown|tainted/u);
    assert.ok(sessionFailure.message.length < 2_000);
    await assert.rejects(
      async () => await connection.backend.closeSession("work"),
      /outcome is unknown|tainted/u,
    );
    assert.deepEqual(cdp.detachedSessionIds(), [lateSession]);
    await assert.rejects(
      async () => await connection.backend.close(),
      /outcome is unknown|tainted/u,
    );
    assert.deepEqual(cdp.detachedSessionIds(), [lateSession]);
  } finally {
    await cdp.close();
  }
});

test("late attach protocol error preserves bounded historical unknown evidence", async () => {
  const cdp = await createFakeCdpServer();
  try {
    const connection = await connectUserBrowserCdp(cdp.endpoint);
    await connection.backend.listTabs("work");
    cdp.holdNextAttachErrorReply();
    await assert.rejects(
      connection.backend.inspect("work", "target-1"),
      /attachToTarget outcome is unknown|document changed/u,
    );
    cdp.releaseLateAttachErrorReply();
    await nextTurn();
    const sessionFailure = await Promise.resolve(
      connection.backend.closeSession("work"),
    ).then(
      () => undefined,
      (error: unknown) => error,
    );
    assert.ok(sessionFailure instanceof Error);
    assert.match(sessionFailure.message, /outcome is unknown|tainted/u);
    assert.ok(sessionFailure.message.length < 2_000);
    await assert.rejects(
      async () => await connection.backend.closeSession("work"),
      /outcome is unknown|tainted/u,
    );
    await assert.rejects(
      async () => await connection.backend.close(),
      /outcome is unknown|tainted/u,
    );
    assert.equal(cdp.count("Target.detachFromTarget"), 0);
    assert.equal(cdp.count("Target.closeTarget"), 0);
  } finally {
    await cdp.close();
  }
});

test("Page.enable timeout compensates detach and failed compensation taints close", async () => {
  for (const detachReply of ["reply", "drop-once"] as const) {
    const cdp = await createFakeCdpServer();
    try {
      const connection = await connectUserBrowserCdp(cdp.endpoint);
      await connection.backend.listTabs("work");
      cdp.dropNextEnableReply();
      if (detachReply === "drop-once") cdp.dropNextDetachReply();
      await assert.rejects(
        connection.backend.inspect("work", "target-1"),
        /Page.enable outcome is unknown|document changed/u,
      );
      assert.equal(cdp.count("Target.detachFromTarget"), 1);
      await assert.rejects(
        async () => await connection.backend.closeSession("work"),
        /outcome is unknown|tainted/u,
      );
      assert.equal(
        cdp.count("Target.detachFromTarget"),
        detachReply === "drop-once" ? 2 : 1,
      );
      await assert.rejects(
        async () => await connection.backend.close(),
        /outcome is unknown|tainted/u,
      );
    } finally {
      await cdp.close();
    }
  }
});

test("Runtime.enable timeout is attachment-owned and dispatches no page code", async () => {
  const cdp = await createFakeCdpServer();
  try {
    const connection = await connectUserBrowserCdp(cdp.endpoint);
    await connection.backend.listTabs("work");
    cdp.dropNextRuntimeEnableReply();
    await assert.rejects(
      connection.backend.inspect("work", "target-1"),
      /Runtime.enable outcome is unknown|document changed/u,
    );
    assert.equal(cdp.count("Runtime.evaluate"), 0);
    assert.equal(cdp.count("Target.detachFromTarget"), 1);
    await assert.rejects(
      async () => await connection.backend.closeSession("work"),
      /outcome is unknown|tainted/u,
    );
  } finally {
    await cdp.close();
  }
});

test("wire target discovery rejects oversized collections without leaking state", async () => {
  const cdp = await createFakeCdpServer();
  try {
    cdp.addTargets(513);
    const connection = await connectUserBrowserCdp(cdp.endpoint);
    await assert.rejects(
      connection.backend.listTabs("work"),
      /target list exceeded its bound/u,
    );
    await connection.backend.closeSession("work");
    await connection.backend.close();
  } finally {
    await cdp.close();
  }
});

test("CDP open creates a background non-focused target before navigating", async () => {
  const cdp = await createFakeCdpServer();
  try {
    const connection = await connectUserBrowserCdp(cdp.endpoint);
    const opened = await connection.backend.open(
      "work",
      "https://example.test/new",
    );
    assert.equal(opened.url, "https://example.test/new");
    const create = cdp.requests("Target.createTarget")[0];
    assert.equal(create?.background, true);
    assert.equal(create?.focus, false);
    assert.match(String(create?.url), /^about:blank#zenx-pending-/u);
    assert.equal(cdp.requests("Page.navigate")[0]?.url, opened.url);
    await connection.backend.closeSession("work");
    assert.equal(cdp.count("Target.closeTarget"), 0);
  } finally {
    await cdp.close();
  }
});

test("CDP create reply loss reconciles the marker over HTTP after disconnect", async () => {
  const cdp = await createFakeCdpServer();
  try {
    const connection = await connectUserBrowserCdp(cdp.endpoint);
    await connection.backend.listTabs("work");
    cdp.loseNextCreateReply();
    await assert.rejects(
      connection.backend.open("work", "https://example.test/new"),
      /recovered provider target target-2/u,
    );
    await assert.rejects(
      async () => await connection.backend.closeSession("work"),
      /outcome is unknown|tainted/u,
    );
    await assert.rejects(
      async () => await connection.backend.close(),
      /outcome is unknown|tainted/u,
    );
    assert.equal(cdp.count("Target.closeTarget"), 0);
  } finally {
    await cdp.close();
  }
});

test("healthy-socket create reply loss reaches a bounded reconciled close", async () => {
  const cdp = await createFakeCdpServer();
  try {
    const connection = await connectUserBrowserCdp(cdp.endpoint);
    await connection.backend.listTabs("work");
    cdp.dropNextCreateReply();
    const controller = new AbortController();
    const opening = connection.backend.open(
      "work",
      "https://example.test/new",
      controller.signal,
    );
    await waitUntil(() => cdp.count("Target.createTarget") === 1);
    controller.abort(new DOMException("cancelled", "AbortError"));
    await assert.rejects(opening, /cancelled/u);
    const started = Date.now();
    await assert.rejects(
      async () => await connection.backend.closeSession("work"),
      /outcome is unknown|tainted/u,
    );
    assert.ok(
      Date.now() - started < 5_000,
      "close must have a bounded outcome",
    );
  } finally {
    await cdp.close();
  }
});

test("attachment uncertainty survives target destroy and detach lifecycle reaping", async () => {
  for (const lifecycle of [
    "destroy",
    "target-detach",
    "inspector-detach",
  ] as const) {
    const cdp = await createFakeCdpServer();
    try {
      const connection = await connectUserBrowserCdp(cdp.endpoint);
      await connection.backend.listTabs("work");
      cdp.dropNextAttachReply();
      await assert.rejects(
        connection.backend.inspect("work", "target-1"),
        /attachToTarget outcome is unknown|document changed/u,
      );
      if (lifecycle === "destroy") cdp.destroyTarget("target-1");
      else if (lifecycle === "target-detach") cdp.detachSession();
      else cdp.detachInspector();
      await nextTurn();
      await assert.rejects(
        async () => await connection.backend.closeSession("work"),
        /outcome is unknown|tainted/u,
      );
      await assert.rejects(
        async () => await connection.backend.close(),
        /outcome is unknown|tainted/u,
      );
    } finally {
      await cdp.close();
    }
  }
});

test("unknown detach mapping cannot be reused by a reopened logical session", async () => {
  const cdp = await createFakeCdpServer();
  try {
    const connection = await connectUserBrowserCdp(cdp.endpoint);
    await connection.backend.listTabs("work");
    await connection.backend.inspect("work", "target-1");
    cdp.dropNextDetachReply();
    await assert.rejects(
      async () => await connection.backend.closeSession("work"),
      /outcome is unknown|tainted/u,
    );
    await assert.rejects(
      connection.backend.listTabs("work"),
      /outcome is unknown|tainted/u,
    );
    await assert.rejects(
      async () => await connection.backend.close(),
      /outcome is unknown|tainted/u,
    );
  } finally {
    await cdp.close();
  }
});

test("connection loss after attach dispatch remains session-owned uncertainty", async () => {
  const cdp = await createFakeCdpServer();
  try {
    const connection = await connectUserBrowserCdp(cdp.endpoint);
    await connection.backend.listTabs("work");
    cdp.holdNextAttachReply();
    const inspection = connection.backend.inspect("work", "target-1");
    await waitUntil(() => cdp.count("Target.attachToTarget") === 1);
    cdp.disconnect();
    await assert.rejects(inspection, /connection|outcome is unknown/u);
    await assert.rejects(
      async () => await connection.backend.closeSession("work"),
      /outcome is unknown|tainted/u,
    );
    await assert.rejects(
      async () => await connection.backend.close(),
      /outcome is unknown|tainted/u,
    );
  } finally {
    await cdp.close();
  }
});

test("post-attach connection loss taints closeSession before backend cleanup", async () => {
  const cdp = await createFakeCdpServer();
  try {
    const connection = await connectUserBrowserCdp(cdp.endpoint);
    await connection.backend.listTabs("work");
    await connection.backend.inspect("work", "target-1");
    cdp.disconnect();
    await nextTurn();
    await assert.rejects(
      async () => await connection.backend.closeSession("work"),
      /connection|outcome is unknown|tainted/u,
    );
    await assert.rejects(
      async () => await connection.backend.close(),
      /connection|outcome is unknown|tainted/u,
    );
  } finally {
    await cdp.close();
  }
});

test("vanished target detach uncertainty transfers through list cleanup", async () => {
  const cdp = await createFakeCdpServer();
  try {
    const connection = await connectUserBrowserCdp(cdp.endpoint);
    await connection.backend.listTabs("work");
    await connection.backend.inspect("work", "target-1");
    cdp.dropNextDetachReply();
    cdp.removeTarget("target-1");
    await assert.rejects(
      connection.backend.listTabs("work"),
      /detach|outcome is unknown|tainted/u,
    );
    await assert.rejects(
      async () => await connection.backend.closeSession("work"),
      /detach|outcome is unknown|tainted/u,
    );
    await assert.rejects(
      async () => await connection.backend.close(),
      /detach|outcome is unknown|tainted/u,
    );
  } finally {
    await cdp.close();
  }
});

test("known attach or setup failure before navigate does not poison cleanup", async () => {
  for (const failure of ["attach", "page-enable", "runtime-enable"] as const) {
    const cdp = await createFakeCdpServer();
    try {
      const connection = await connectUserBrowserCdp(cdp.endpoint);
      await connection.backend.listTabs("work");
      if (failure === "attach") cdp.failNextAttachReply();
      else if (failure === "page-enable") cdp.failNextEnableReply();
      else cdp.failNextRuntimeEnableReply();
      await assert.rejects(
        connection.backend.navigate(
          "work",
          "target-1",
          "https://example.test/known-failure",
        ),
        /known attach failure|known enable failure|known Runtime.enable failure|command failed/u,
      );
      assert.equal(cdp.count("Page.navigate"), 0);
      assert.equal(await connection.backend.closeSession("work"), 1);
      await connection.backend.close();
    } finally {
      await cdp.close();
    }
  }
});

test("known reattach or setup failure before action does not poison cleanup", async () => {
  for (const failure of ["attach", "page-enable", "runtime-enable"] as const) {
    const cdp = await createFakeCdpServer();
    try {
      const connection = await connectUserBrowserCdp(cdp.endpoint);
      await connection.backend.listTabs("work");
      const inspection = await connection.backend.inspect("work", "target-1");
      const target = inspection.targets[0];
      assert.ok(target);
      const evaluationsBefore = cdp.count("Runtime.evaluate");
      cdp.detachSession();
      // Fence delivery of the preceding Target.detachedFromTarget notification on
      // the same ordered CDP connection before exercising the reattach path.
      await connection.backend.listTabs("work");
      if (failure === "attach") cdp.failNextAttachReply();
      else if (failure === "page-enable") cdp.failNextEnableReply();
      else cdp.failNextRuntimeEnableReply();
      await assert.rejects(
        connection.backend.click(
          "work",
          "target-1",
          inspection.observationId,
          target.targetId,
        ),
        /known attach failure|known enable failure|known Runtime.enable failure|command failed/u,
      );
      assert.equal(cdp.count("Runtime.evaluate"), evaluationsBefore);
      assert.equal(await connection.backend.closeSession("work"), 1);
      await connection.backend.close();
    } finally {
      await cdp.close();
    }
  }
});

test("healthy-socket detach reply loss terminates close with an explicit error", async () => {
  const cdp = await createFakeCdpServer();
  try {
    const connection = await connectUserBrowserCdp(cdp.endpoint);
    await connection.backend.listTabs("work");
    await connection.backend.inspect("work", "target-1");
    cdp.dropNextDetachReply();
    const started = Date.now();
    await assert.rejects(
      async () => await connection.backend.closeSession("work"),
      /detachFromTarget outcome is unknown|detach outcome is unknown/u,
    );
    assert.ok(
      Date.now() - started < 5_000,
      "detach must have a bounded outcome",
    );
    await assert.rejects(
      async () => await connection.backend.close(),
      /backend close outcome is unknown|tainted/u,
    );
  } finally {
    await cdp.close();
  }
});
