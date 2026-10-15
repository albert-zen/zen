import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { WebSocketServer, type WebSocket } from "ws";
import { diagnoseOwnedBrowserStartup } from "../src/main/browser-startup-diagnostic.js";

const targetId = "private-target-id";
const sessionId = "private-session-id";
async function fixture(
  mode:
    | "normal"
    | "late"
    | "late-error"
    | "late-closed"
    | "probe-errors"
    | "silent"
    | "wrong-session"
    | "closed"
    | "error",
  extended = false,
  failingMethod = "Page.createIsolatedWorld",
) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const requests: {
    id: number;
    method: string;
    params: Record<string, unknown>;
    sessionId?: string;
  }[] = [];
  const timers: ReturnType<typeof setTimeout>[] = [];
  let marker: unknown;
  server.on("connection", (socket: WebSocket) => {
    socket.on("message", (raw) => {
      const request = JSON.parse(String(raw)) as (typeof requests)[number];
      requests.push(request);
      const reply = (
        result: Record<string, unknown>,
        routed = request.sessionId,
      ) =>
        socket.send(
          JSON.stringify({
            id: request.id,
            result,
            ...(routed === undefined ? {} : { sessionId: routed }),
          }),
        );
      if (request.method === "Target.createTarget") {
        marker = request.params.url;
        assert.equal(request.params.background, true);
        assert.equal(request.params.focus, false);
        reply({ targetId });
      } else if (request.method === "Target.getTargets")
        reply({ targetInfos: [] });
      else if (request.method === "Target.attachToTarget") {
        assert.equal(request.params.flatten, true);
        socket.send(
          JSON.stringify({
            method: "Target.attachedToTarget",
            params: {
              sessionId,
              waitingForDebugger: false,
              targetInfo: { targetId, url: "https://private.invalid/content" },
            },
          }),
        );
        reply({ sessionId });
      } else if (
        request.method === (extended ? failingMethod : "Page.enable")
      ) {
        assert.equal(request.sessionId, sessionId);
        if (mode === "late-error")
          timers.push(
            setTimeout(
              () =>
                socket.send(
                  JSON.stringify({
                    id: request.id,
                    sessionId,
                    error: { message: "PRIVATE late error text" },
                  }),
                ),
              2_050,
            ),
          );
        else if (mode === "late")
          timers.push(setTimeout(() => reply({}), 2_050));
        else if (mode === "late-closed")
          timers.push(setTimeout(() => socket.close(), 2_050));
        else if (mode === "silent" || mode === "probe-errors") return;
        else if (mode === "wrong-session") {
          reply({}, "private-stale-session");
          timers.push(setTimeout(() => socket.close(), 20));
        } else if (mode === "closed") socket.close();
        else if (mode === "error")
          socket.send(
            JSON.stringify({
              id: request.id,
              sessionId,
              error: {
                message: "PRIVATE error text https://private.invalid/content",
              },
            }),
          );
        else
          reply(
            request.method === "Page.createIsolatedWorld"
              ? { executionContextId: 7 }
              : {},
          );
      } else if (request.method === "Page.getFrameTree") {
        reply({ frameTree: { frame: { id: "private-frame", url: marker } } });
      } else if (request.method === "Browser.getVersion") {
        if (mode === "probe-errors")
          socket.send(
            JSON.stringify({
              id: request.id,
              error: { message: "PRIVATE rejected probe" },
            }),
          );
        else reply({ product: "Chrome/test" });
      } else if (request.method === "Runtime.getIsolateId") {
        assert.equal(request.sessionId, sessionId);
        if (mode === "probe-errors")
          socket.send(
            JSON.stringify({
              id: request.id,
              sessionId,
              error: { message: "PRIVATE rejected probe" },
            }),
          );
        else if (mode !== "silent") reply({ id: "private-isolate-id" });
      } else if (request.method === "Target.detachFromTarget") {
        assert.equal(request.params.sessionId, sessionId);
        socket.send(
          JSON.stringify({
            method: "Target.detachedFromTarget",
            params: { sessionId, targetId },
          }),
        );
        reply({});
      } else reply({});
    });
  });
  try {
    const report = await diagnoseOwnedBrowserStartup({
      browserSocketUrl: `ws://127.0.0.1:${address.port}`,
      throughIsolatedWorld: extended,
      ...(extended ? { ownedPageUrl: "http://127.0.0.1:12345/agent" } : {}),
      listOwnedTargets: async () => [
        { id: targetId, type: "page", url: marker },
      ],
    });
    assert.equal(requests.filter((r) => r.method === "Page.enable").length, 1);
    assert.ok(
      requests.filter((r) =>
        ["Browser.getVersion", "Runtime.getIsolateId"].includes(r.method),
      ).length <= 2,
    );
    assert.equal(
      requests.some((r) =>
        /^(Input\.|Page\.navigate$|Runtime\.evaluate$)/u.test(r.method),
      ),
      false,
    );
    if (!extended)
      assert.equal(
        requests.some((r) => r.method === "Runtime.enable"),
        false,
      );
    for (const method of [
      "Page.enable",
      "Runtime.enable",
      "Page.getFrameTree",
      "Page.createIsolatedWorld",
      "Browser.getVersion",
      "Runtime.getIsolateId",
    ])
      assert.ok(requests.filter((r) => r.method === method).length <= 1);
    assert.equal(report.productionAcceptance, false);
    assert.doesNotMatch(
      JSON.stringify(report),
      /private-|https?:|about:blank|PRIVATE/u,
    );
    return { report, requests };
  } finally {
    for (const timer of timers) clearTimeout(timer);
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("startup replica reports non-reproduction and never proceeds to navigation/input", async () => {
  const { report, requests } = await fixture("normal");
  assert.equal(report.classification, "not-reproduced");
  assert.equal(report.initialOutcome, "success");
  assert.deepEqual(report.probes, {});
  assert.equal(report.cleanup, "success");
  assert.equal(
    requests.filter((r) => r.method === "Target.detachFromTarget").length,
    1,
  );
});

test("late original reply remains unknown and is evidence only, with two read-only probes", async () => {
  const { report, requests } = await fixture("late");
  assert.equal(report.classification, "initialization-original-reply-late");
  assert.equal(report.initialOutcome, "outcome-unknown");
  assert.equal(report.lateOriginalResponse, "success");
  assert.deepEqual(report.probes, { browser: "success", renderer: "success" });
  assert.equal(
    requests.filter((r) => r.method === "Browser.getVersion").length,
    1,
  );
  assert.equal(
    requests.filter((r) => r.method === "Runtime.getIsolateId").length,
    1,
  );
  assert.equal(requests.filter((r) => r.method === "Page.enable").length, 1);
  const deadline = report.events.findIndex(
    (event) => event.kind === "outcome-deadline",
  );
  const probe = report.events.findIndex(
    (event) => event.kind === "send" && event.method === "Browser.getVersion",
  );
  assert.ok(probe > deadline);
});

test("silent renderer stops at the bounded late observation and detaches once", async () => {
  const { report, requests } = await fixture("silent");
  assert.equal(report.classification, "browser-responsive-renderer-unanswered");
  assert.equal(report.initialOutcome, "outcome-unknown");
  assert.equal(report.lateOriginalResponse, "not-observed");
  assert.deepEqual(report.probes, {
    browser: "success",
    renderer: "outcome-unknown",
  });
  assert.ok(
    report.events.some((event) => event.kind === "late-observation-ended"),
  );
  assert.equal(
    requests.filter((r) => r.method === "Target.detachFromTarget").length,
    1,
  );
});

test("a wrong-session response is recorded and cannot settle the initialization", async () => {
  const { report } = await fixture("wrong-session");
  assert.equal(report.classification, "session-route-mismatch");
  assert.equal(report.initialOutcome, "transport-closed");
  assert.ok(
    report.events.some((event) => event.kind === "reply-route-mismatch"),
  );
});

test("socket closure ends the replica without probes or retry", async () => {
  const { report } = await fixture("closed");
  assert.equal(report.classification, "transport-closed");
  assert.equal(report.initialOutcome, "transport-closed");
  assert.deepEqual(report.probes, {});
  assert.equal(report.cleanup, "transport-closed");
});

test("known protocol failure is reported without leaking its remote error text", async () => {
  const { report } = await fixture("error");
  assert.equal(report.classification, "initialization-known-error");
  assert.equal(report.initialOutcome, "protocol-error");
  assert.deepEqual(report.probes, {});
});

test("late protocol error also preserves the initial unknown outcome", async () => {
  const { report } = await fixture("late-error");
  assert.equal(report.classification, "initialization-original-reply-late");
  assert.equal(report.initialOutcome, "outcome-unknown");
  assert.equal(report.lateOriginalResponse, "protocol-error");
});

test("socket closure after the deadline is explicit and cannot upgrade unknown", async () => {
  const { report } = await fixture("late-closed");
  assert.equal(report.classification, "transport-closed");
  assert.equal(report.initialOutcome, "outcome-unknown");
  assert.equal(report.lateOriginalResponse, "not-observed");
  assert.equal(report.cleanup, "transport-closed");
});

test("probe protocol errors prove neither unresponsiveness nor renderer health", async () => {
  const { report } = await fixture("probe-errors");
  assert.equal(report.classification, "probe-protocol-error");
  assert.equal(report.initialOutcome, "outcome-unknown");
  assert.deepEqual(report.probes, {
    browser: "protocol-error",
    renderer: "protocol-error",
  });
});

test("extended replica initializes only one owned fixture world and one independent browser probe", async () => {
  const { report, requests } = await fixture("normal", true);
  assert.equal(report.classification, "not-reproduced");
  assert.deepEqual(
    report.stages?.map((stage) => [stage.method, stage.initialOutcome]),
    [
      ["Page.enable", "success"],
      ["Runtime.enable", "success"],
      ["Page.getFrameTree", "success"],
      ["Page.createIsolatedWorld", "success"],
    ],
  );
  assert.deepEqual(report.probes, { browser: "success" });
  const world = requests.find(
    (request) => request.method === "Page.createIsolatedWorld",
  )!;
  assert.deepEqual(world.params, {
    frameId: "private-frame",
    worldName: "__zenx_user_browser_document__",
    grantUniveralAccess: false,
  });
  assert.equal(world.sessionId, sessionId);
  assert.equal(
    requests.some((request) => request.method === "Runtime.getIsolateId"),
    false,
  );
  assert.ok(report.eventLoop && Number.isFinite(report.eventLoop.maxMs));
  assert.ok(
    report.events.some(
      (event) =>
        event.method === "Page.createIsolatedWorld" &&
        typeof event.elapsedMs === "number",
    ),
  );
});

test("late isolated-world reply is retained but never upgrades the initial unknown or repeats initialization", async () => {
  const { report } = await fixture("late", true);
  assert.equal(report.initialOutcome, "outcome-unknown");
  assert.equal(report.lateOriginalResponse, "success");
  assert.equal(report.stages?.at(-1)?.method, "Page.createIsolatedWorld");
  assert.equal(report.stages?.at(-1)?.initialOutcome, "outcome-unknown");
  assert.equal(report.stages?.at(-1)?.lateOriginalResponse, "success");
});

test("a Runtime.enable failure stops before frame/world work, without changing production timeouts", async () => {
  const { report, requests } = await fixture("error", true, "Runtime.enable");
  assert.equal(report.initialOutcome, "protocol-error");
  assert.deepEqual(
    report.stages?.map((stage) => stage.method),
    ["Page.enable", "Runtime.enable"],
  );
  assert.equal(
    requests.some((request) => request.method === "Page.getFrameTree"),
    false,
  );
  assert.equal(
    requests.some((request) => request.method === "Page.createIsolatedWorld"),
    false,
  );
  assert.equal(
    requests.some((request) => request.method === "Browser.getVersion"),
    false,
  );
});

test("an earlier unknown is never permission to advance to Runtime or the isolated world", async () => {
  const { report, requests } = await fixture("late", true, "Page.enable");
  assert.equal(report.initialOutcome, "outcome-unknown");
  assert.equal(report.lateOriginalResponse, "success");
  assert.equal(
    requests.some((request) => request.method === "Runtime.enable"),
    false,
  );
  assert.equal(
    requests.some((request) => request.method === "Page.createIsolatedWorld"),
    false,
  );
});
