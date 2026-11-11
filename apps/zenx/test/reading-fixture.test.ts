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
    assert.equal(projected.turns[0].status, "completed");
    const answer = projected.turns[0].items.find(
      (item) => item.type === "agentMessage",
    );
    assert(answer && answer.type === "agentMessage");
    assert.equal(answer.text, readingMarkdown);
    assert.equal(recovery.thread.sandbox, "read-only");
  }
  const first = readingRecovery(base, true);
  first.thread.items.pop();
  assert.equal(
    readingRecovery(base, true).thread.items.length,
    first.thread.items.length + 1,
  );
});
test("typed approval is synthetic, stable and opt-in, not an execution", () => {
  assert.deepEqual(readingApprovals(false), []);
  const [approval] = readingApprovals(true);
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
