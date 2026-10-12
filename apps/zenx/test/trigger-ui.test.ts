import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  TriggersPage,
  TriggersPanel,
  editorFromTrigger,
  localDateTime,
  safeProgramFailure,
  triggerEditorInput,
} from "../src/renderer/src/bundled-automation-ui.js";
import type { TriggerHistoryEntry } from "../src/main/trigger-types.js";

test("program failure summary contains only Host-classified fields", () => {
  const entry = {
    id: "history-1",
    status: "failed",
    error: "private raw error",
    programOutcome: {
      stage: "action",
      status: "nonzero_exit",
      exitCode: 12,
      error: "SECRET env and command",
      output: "private stdout",
    },
  } as TriggerHistoryEntry;
  const summary = safeProgramFailure(entry);
  assert.match(summary!, /Program action: nonzero_exit \(exit 12\).*history-1/);
  assert.doesNotMatch(summary!, /SECRET|private|command|stdout/);
});
import type { PluginUiSdkV1 } from "../src/renderer/src/plugin-ui-host.js";

test("timer editor round-trips its absolute instant and interval without rewriting identity", () => {
  const runAt = Date.now() + 60 * 60_000;
  const trigger = {
    id: "abc",
    threadId: "thread",
    kind: "timer" as const,
    label: "Check",
    prompt: "Check status",
    createdAt: 1,
    active: false,
    timer: { nextRunAt: runAt, intervalMinutes: 60 },
  };
  const editor = editorFromTrigger(trigger);
  assert.equal(editor.interval, "60");
  assert.equal(editor.runAt, localDateTime(runAt));
  const saved = triggerEditorInput(editor);
  assert.equal(saved.id, "abc");
  assert.equal(saved.threadId, "thread");
  assert("runAt" in saved);
  assert.equal(saved.intervalMinutes, 60);
  assert(Math.abs(saved.runAt - runAt) < 60_000);
  assert.throws(
    () => triggerEditorInput({ ...editor, runAt: "2000-01-01T00:00" }),
    /future/,
  );
  assert.throws(
    () => triggerEditorInput({ ...editor, interval: "0" }),
    /positive/,
  );
});

test("thread editor does not replay includeLatest on update", () => {
  const editor = editorFromTrigger({
    id: "watch",
    threadId: "target",
    kind: "thread",
    label: "Watch",
    prompt: "Read",
    createdAt: 1,
    active: true,
    watch: { threadId: "source", event: "turn_completed", once: true },
  });
  assert.deepEqual(triggerEditorInput(editor), {
    id: "watch",
    threadId: "target",
    kind: "thread",
    label: "Watch",
    prompt: "Read",
    watchedThreadId: "source",
    once: true,
  });
});

test("remote thread editor preserves its exact device/workspace locator and never stores transient source errors", () => {
  const editor = editorFromTrigger({
    id: "remote-watch",
    threadId: "local-target",
    kind: "thread",
    label: "Watch remote work",
    prompt: "Read the result",
    createdAt: 1,
    active: true,
    sourceError: "Device disconnected",
    watch: {
      threadId: "same-id",
      sourceDevice: "desktop",
      sourceWorkspace: "remote-workspace",
      event: "turn_completed",
      once: true,
    },
  });
  const input = triggerEditorInput({
    ...editor,
    label: "Updated name",
    prompt: "Updated instructions",
    includeLatest: true,
  });
  assert.deepEqual(input, {
    id: "remote-watch",
    threadId: "local-target",
    kind: "thread",
    label: "Updated name",
    prompt: "Updated instructions",
    watchedThreadId: "same-id",
    sourceDevice: "desktop",
    sourceWorkspace: "remote-workspace",
    once: true,
  });
  assert.equal("sourceError" in editor, false);
  assert.equal("sourceError" in input, false);
  assert.equal("includeLatest" in input, false);
});

test("thread editor normalizes remote selectors and rejects a workspace without a remote device", () => {
  const editor = editorFromTrigger({
    id: "watch",
    threadId: "target",
    kind: "thread",
    label: "Watch",
    prompt: "Read",
    createdAt: 1,
    active: true,
    watch: { threadId: "source", event: "turn_completed", once: true },
  });
  const remote = triggerEditorInput({
    ...editor,
    sourceDevice: " desktop ",
    sourceWorkspace: " remote-workspace ",
  });
  assert("sourceDevice" in remote);
  assert.equal(remote.sourceDevice, "desktop");
  assert.equal(remote.sourceWorkspace, "remote-workspace");
  const local = triggerEditorInput({ ...editor, sourceDevice: "local" });
  assert.equal("sourceDevice" in local, false);
  assert.equal("sourceWorkspace" in local, false);
  assert.throws(
    () =>
      triggerEditorInput({ ...editor, sourceWorkspace: "orphan-workspace" }),
    /remote source device/u,
  );
});

test("thread panel displays empty-state creation scoped to Thread; global page has independent entry", () => {
  const sdk = { context: { threadId: "target" } } as unknown as PluginUiSdkV1;
  const rail = renderToStaticMarkup(createElement(TriggersPanel, { sdk }));
  assert.match(rail, /Thread triggers/);
  assert.match(rail, /New trigger/);
  assert.match(rail, /All automations/);
  const global = renderToStaticMarkup(createElement(TriggersPage, { sdk }));
  assert.match(global, /Automations/);
  assert.match(global, /New trigger/);
});
