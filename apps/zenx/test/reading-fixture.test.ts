import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import type { Thread } from "../src/protocol-client/index.js";
import { projectNativeThread } from "../src/renderer/src/thread-view-state.js";
import {
  guardReadingBridge,
  readingMarkdown,
  readingRecovery,
  readingApprovals,
  readingBrowserCommand,
  readReadingRequest,
} from "./fixtures/ui-polish-reading.js";
const base: Thread = {
  id: "thread-1",
  sessionId: "thread-1",
  forkedFromId: null,
  parentThreadId: null,
  preview: "",
  ephemeral: false,
  isPinned: false,
  modelProvider: "fake",
  createdAt: 1792033200,
  updatedAt: 1792033260,
  recencyAt: null,
  status: { type: "idle" },
  path: null,
  cwd: "/work/zen",
  cliVersion: "zen/0.1.0",
  source: "appServer",
  threadSource: null,
  agentNickname: null,
  agentRole: null,
  gitInfo: null,
  name: "Synthetic reading",
  turns: [],
};
test("reading data contains real Markdown structures and adjacent compact table/code", () => {
  for (const expression of [
    /^# /m,
    /^## /m,
    /^### /m,
    /^- /m,
    /^1\. /m,
    /^> /m,
    /^\|/m,
    /```typescript/,
  ])
    assert.match(readingMarkdown, expression);
  assert(readingMarkdown.length > 3000);
  const afterTable = readingMarkdown.slice(
    readingMarkdown.indexOf("| Pending area"),
  );
  assert(afterTable.indexOf("```typescript") < 400);
  assert(!/https?:\/\//.test(readingMarkdown));
});
test("native recovery projects full answer and exactly two real queue items only when pending", () => {
  for (const pending of [false, true]) {
    const recovery = readingRecovery(base, pending);
    const projected = projectNativeThread(recovery.thread);
    assert.equal(projected.queuedMessages?.length, pending ? 2 : 0);
    assert.equal(projected.turns.length, 1);
    const turn = projected.turns[0];
    assert(turn);
    assert.equal(turn.status, "completed");
    const answer = turn.items.find((item) => item.type === "agentMessage");
    assert(answer && answer.type === "agentMessage");
    assert.equal(answer.text, readingMarkdown);
    assert.equal(recovery.thread.sandbox, "read-only");
  }
  const first = readingRecovery(base, true);
  const second = readingRecovery(base, true);
  assert.notEqual(second.thread.items, first.thread.items);
  assert.deepEqual(second.thread.items, first.thread.items);
});
test("typed approval is synthetic, stable and opt-in, not an execution", () => {
  assert.deepEqual(readingApprovals(false), []);
  const [approval] = readingApprovals(true);
  assert(approval);
  assert.equal(approval.params.threadId, base.id);
  assert.match(approval.params.reason!, /Do not approve/);
  assert.deepEqual(readingApprovals(true), [approval]);
});
test("reading protocol permits only exact owner reads and rejects writes or extra data", () => {
  for (const method of [
    "zen/thread/resume",
    "zen/thread/resume-window",
    "zen/thread/read",
    "zen/thread/questions/list",
  ])
    assert(readReadingRequest(method, { threadId: "thread-1" }, base, false));
  for (const method of [
    "zen/turn/send",
    "thread/compact",
    "zen/thread/create-child-configured",
    "unknown",
  ])
    assert.throws(() =>
      readReadingRequest(method, { threadId: "thread-1" }, base, true),
    );
  for (const request of [
    null,
    {},
    { threadId: "other" },
    { threadId: "thread-1", write: true },
  ])
    assert.throws(() =>
      readReadingRequest("zen/thread/read", request, base, false),
    );
});
test("bridge denies unlisted actions before invoking their implementations", () => {
  let writes = 0;
  const guarded = guardReadingBridge({
    protocol: { respondToApproval: () => writes++ },
    workspaceFiles: { save: () => writes++ },
    unknown: { read: () => writes++ },
    titles: { observe: () => "synthetic" },
    settings: { get: () => ({}) },
  });
  assert.throws(() => guarded.protocol.respondToApproval(), /denied/);
  assert.throws(() => guarded.workspaceFiles.save(), /denied/);
  assert.throws(() => guarded.unknown.read(), /denied/);
  assert.equal(writes, 0);
  assert.equal(guarded.titles.observe(), "synthetic");
  assert.deepEqual(guarded.settings.get(), {});
});
test("reading integrates the production App and read-only navigation Information bridge without replacing other scenes", async () => {
  const source = await readFile(
    new URL("./fixtures/ui-polish-visual.tsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /readingScene \? guardReadingBridge\(zenx\) : zenx/);
  assert.match(
    source,
    /params.get\("scene"\) === "navigation" \|\| readingScene/,
  );
  assert.match(source, /else createRoot.*render\(<App \/>\)/);
  assert.match(source, /readNavigationQuestions/);
});

test("App startup may read synthetic fleet status without admitting remote or mutating fleet operations", async () => {
  let reads = 0,
    otherCalls = 0;
  const snapshot = {
    revision: 1,
    config: { version: 1, devices: [] },
    host: { enabled: false, hostId: "synthetic-host", clients: [] },
  };
  const guarded = guardReadingBridge({
    fleet: {
      status: async () => {
        reads++;
        return snapshot;
      },
      catalog: () => otherCalls++,
      threadCreate: () => otherCalls++,
      update: () => otherCalls++,
    },
  });
  assert.equal(await guarded.fleet.status(), snapshot);
  assert.equal(reads, 1);
  for (const invoke of [
    () => guarded.fleet.catalog(),
    () => guarded.fleet.threadCreate(),
    () => guarded.fleet.update(),
  ])
    assert.throws(invoke, /Reading bridge denied: fleet\./);
  assert.equal(otherCalls, 0);
  const source = await readFile(
    new URL("./fixtures/ui-polish-visual.tsx", import.meta.url),
    "utf8",
  );
  const implementation = source.slice(
    source.indexOf("fleet: {"),
    source.indexOf("catalog: async"),
  );
  assert.match(implementation, /status: async \(\) =>/);
  assert.match(
    implementation,
    /Synthetic QA target; no connection is attempted/,
  );
  assert.match(implementation, /host: \{ enabled: false/);
  assert.doesNotMatch(
    implementation,
    /fetch\(|WebSocket|executeCommand|threadCreate/,
  );
});

test("read bridge preserves effect dependencies without leaking permissions through aliases", async () => {
  const source = { status: async () => ({ config: { devices: [] } }) };
  const bridge = guardReadingBridge({ fleet: source, unknown: source });
  assert.equal(
    bridge.fleet,
    bridge.fleet,
    "[api] remains stable between component renders",
  );
  assert.equal(
    bridge.fleet.status,
    bridge.fleet.status,
    "bound subscriptions/read methods retain identity",
  );
  assert.notEqual(
    bridge.fleet,
    bridge.unknown,
    "same object at another path retains that path's permissions",
  );
  assert.throws(
    () => bridge.unknown.status(),
    /Reading bridge denied: unknown.status/,
  );
  assert.deepEqual(await bridge.fleet.status(), { config: { devices: [] } });
});

test("AuxiliaryPanel startup admits only the exact synthetic thread tab-list read", async () => {
  const bridge = guardReadingBridge({
    workspaceBrowser: {
      command: readingBrowserCommand,
      mount: () => assert.fail("No browser view may mount"),
    },
  });
  assert.deepEqual(bridge.workspaceBrowser.command("thread-1", "list"), []);
  for (const args of [
    [],
    ["other", "list"],
    ["thread-1", "list", "tab"],
    ["thread-1", "list", undefined],
    ...[
      "new",
      "close",
      "navigate",
      "materialize",
      "take-control",
      "return-control",
      "reload",
    ].map((op) => ["thread-1", op]),
  ])
    assert.throws(
      () => bridge.workspaceBrowser.command(...args),
      /read-only reading browser command/,
    );
  assert.throws(() => bridge.workspaceBrowser.mount(), /Reading bridge denied/);
  const source = await readFile(
    new URL("../src/renderer/src/auxiliary-panel.tsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /api.command\(threadId, "list"\)/);
  const fixture = await readFile(
    new URL("./fixtures/ui-polish-visual.tsx", import.meta.url),
    "utf8",
  );
  assert.match(fixture, /tabId !== undefined \|\| url !== undefined/);
  assert.match(fixture, /return readingBrowserCommand\(threadId, command\)/);
});

test("synthetic Host replacement emits only ordered lifecycle events and updates the snapshot once", async () => {
  const { createReadingApprovalFixture } =
    await import("./fixtures/ui-polish-reading.js");
  const fixture = createReadingApprovalFixture(true);
  const initial = fixture.getPendingApprovals()[0]!;
  assert.equal(initial.requestId, "reading-synthetic-approval");
  assert.equal(
    initial.params.approvalScope,
    undefined,
    "Original request keeps the full existing scope UI",
  );
  const events: { type: string; event: unknown }[] = [];
  fixture.onApprovalResolved((event) =>
    events.push({ type: "resolved", event }),
  );
  fixture.onApprovalRequest((event) =>
    events.push({ type: "requested", event }),
  );
  const record = fixture.replaceRequest();
  assert.deepEqual(record, {
    kind: "synthetic-host-request-replacement",
    oldRequestId: initial.requestId,
    newRequestId: "reading-synthetic-approval-once",
    threadId: "thread-1",
    approvalScope: "once",
    approvalTarget: {
      key: "synthetic-reading-target",
      label: "Synthetic reading-layout preview only",
    },
  });
  assert.deepEqual(
    events.map((event) => event.type),
    ["resolved", "requested"],
  );
  assert.deepEqual(events[0]!.event, {
    requestId: initial.requestId,
    threadId: "thread-1",
    decision: null,
  });
  const [next] = fixture.getPendingApprovals();
  assert.deepEqual(events[1]!.event, next);
  assert.equal(next!.params.approvalScope, "once");
  assert.deepEqual(next!.params.approvalTarget, record.approvalTarget);
  assert.equal(next!.params.itemId, "reading-display-only-once");
  assert.throws(() => fixture.replaceRequest(), /unreplaced pending fixture/);
  assert.equal(events.length, 2);
  assert.doesNotMatch(
    createReadingApprovalFixture.toString(),
    /respondToApproval|protocol|fetch|WebSocket|allow|deny/,
  );
});

test("approval fixture subscriptions unsubscribe and snapshots/listeners cannot mutate Host state", async () => {
  const { createReadingApprovalFixture } =
    await import("./fixtures/ui-polish-reading.js");
  const fixture = createReadingApprovalFixture(true);
  const offRequest = fixture.onApprovalRequest(() =>
    assert.fail("unsubscribed request"),
  );
  const offResolved = fixture.onApprovalResolved(() =>
    assert.fail("unsubscribed resolution"),
  );
  offRequest();
  offRequest();
  offResolved();
  offResolved();
  fixture.getPendingApprovals()[0]!.requestId = "mutated snapshot";
  fixture.onApprovalRequest((event) => {
    event.requestId = "mutated listener";
  });
  fixture.replaceRequest();
  assert.equal(
    fixture.getPendingApprovals()[0]!.requestId,
    "reading-synthetic-approval-once",
  );
  const empty = createReadingApprovalFixture(false);
  assert.deepEqual(empty.getPendingApprovals(), []);
  assert.throws(() => empty.replaceRequest(), /unreplaced pending fixture/);
});

test("replacement hook remains reading-only and never relaxes approval response guard", async () => {
  const fixture = await readFile(
    new URL("./fixtures/ui-polish-visual.tsx", import.meta.url),
    "utf8",
  );
  assert.match(
    fixture,
    /readingScene\s*\?\s*createReadingApprovalFixture\(readingPending\)\s*:\s*null/,
  );
  assert.match(fixture, /if \(readingApprovalFixture\)/);
  assert.match(
    fixture,
    /__readingApprovalFixture: \{\s*replaceRequest: readingApprovalFixture.replaceRequest/,
  );
  const guarded = guardReadingBridge({
    protocol: { respondToApproval: () => assert.fail("No decision") },
  });
  assert.throws(
    () => guarded.protocol.respondToApproval(),
    /Reading bridge denied/,
  );
});

test("optional inline trace preserves failed shell result through production projection", () => {
  for (const pending of [false, true])
    for (const results of [false, true]) {
      assert.deepEqual(
        readingRecovery(base, pending, undefined, results),
        readingRecovery(base, pending, undefined, results, false),
      );
    }
  const recovery = readingRecovery(base, false, undefined, true, true);
  const projected = projectNativeThread(recovery.thread);
  assert.equal(projected.turns.length, 2);
  const first = projected.turns[0],
    second = projected.turns[1];
  assert(first && second);
  assert.equal(first.status, "completed");
  assert.equal(second.status, "completed");
  const success = first.items.find((i) => i.type === "commandExecution");
  const failed = second.items.find((i) => i.type === "commandExecution");
  assert(
    success?.type === "commandExecution" && failed?.type === "commandExecution",
  );
  assert.equal(success.exitCode, 0);
  assert.equal(failed.exitCode, 1);
  assert.equal(failed.status, "failed");
  assert.equal(failed.command, "synthetic-check labels");
  assert.match(
    failed.aggregatedOutput ?? "",
    /Expected reader_name, received reader_label/,
  );
  const answer = second.items.find((i) => i.type === "agentMessage");
  assert(answer?.type === "agentMessage");
  assert.match(answer.text, /Label check needs attention/);
  assert.equal(projected.queuedMessages?.length ?? 0, 0);
});
