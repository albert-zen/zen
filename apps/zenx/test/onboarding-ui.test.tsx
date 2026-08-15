import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";

import type { Thread } from "../src/protocol-client/index.js";
import {
  ProjectCreateThreadButton,
  Sidebar,
} from "../src/renderer/src/Sidebar.js";
import { ModelSelector } from "../src/renderer/src/ModelSelector.js";
import {
  applyStatusCopy,
  cleanupLegacyJournalsAndRefreshThreads,
  isProviderReady,
  LegacyJournalCard,
} from "../src/renderer/src/SettingsView.js";
import { deriveProjectGroups } from "../src/renderer/src/thread-list.js";
import { ThreadTitleEditor } from "../src/renderer/src/App.js";
import { DirectoryPicker } from "../src/renderer/src/DirectoryPicker.js";

const noop = () => undefined;
const noopAsync = async () => undefined;

test("internal directory picker exposes an accessible modal and explicit selection", () => {
  const html = renderToStaticMarkup(
    createElement(DirectoryPicker, { onCancel: noop, onSelect: noop }),
  );
  assert.match(html, /role="dialog"/u);
  assert.match(html, /aria-modal="true"/u);
  assert.match(html, /tabindex="-1"/u);
  assert.match(html, /Close folder picker/u);
  assert.match(html, /Current selection/u);
  assert.match(html, /Add this folder/u);
  assert.match(html, /Loading folders/u);
});

test("projects navigation has one heading, add action, empty workspace, and one unavailable summary", () => {
  const threads = Array.from({ length: 179 }, (_, index) =>
    thread(`broken-${index}`, { type: "systemError" }, ""),
  );
  const html = renderToStaticMarkup(
    createElement(Sidebar, {
      configuredWorkspaces: ["D:\\work\\quiet-project"],
      defaultWorkspace: "D:\\work\\quiet-project",
      mode: "projects",
      onModeChange: noop,
      onNewThread: noop,
      onAddProject: noop,
      onRemoveProject: noop,
      onSetDefaultProject: noop,
      onOpenSettings: noop,
      onOpenScheduled: noop,
      onSelectRoom: noop,
      onSelectThread: noop,
      pendingApprovalThreadIds: new Set(),
      projectActionError: null,
      selectedThreadId: null,
      serverReady: true,
      threads,
      triggerSnapshot: { triggers: [], history: [], rooms: [] },
    }),
  );
  assert.equal((html.match(/Projects/g) ?? []).length, 1);
  assert.match(html, /Add project/);
  assert.match(html, /quiet-project/);
  assert.match(html, /No threads yet/);
  assert.match(html, /179 unavailable journals/);
  assert.equal(
    (html.match(/Thread journal could not be loaded/g) ?? []).length,
    0,
  );
  assert.match(html, /New thread in quiet-project/);
  assert.match(html, /files stay untouched/i);
});

test("inbox aggregates unavailable journals into one cleanup summary", () => {
  const threads = Array.from({ length: 179 }, (_, index) =>
    thread(`broken-${index}`, { type: "systemError" }, ""),
  );
  const html = renderToStaticMarkup(
    createElement(Sidebar, {
      configuredWorkspaces: ["D:\\work"],
      defaultWorkspace: "D:\\work",
      mode: "inbox",
      onModeChange: noop,
      onNewThread: noop,
      onAddProject: noop,
      onRemoveProject: noop,
      onSetDefaultProject: noop,
      onOpenSettings: noop,
      onOpenScheduled: noop,
      onSelectRoom: noop,
      onSelectThread: noop,
      pendingApprovalThreadIds: new Set(),
      projectActionError: null,
      selectedThreadId: null,
      serverReady: true,
      threads,
      triggerSnapshot: { triggers: [], history: [], rooms: [] },
    }),
  );
  assert.match(html, /179 unavailable journals/);
  assert.equal(
    (html.match(/Thread journal could not be loaded/g) ?? []).length,
    0,
  );
  assert.equal((html.match(/Review cleanup in Settings/g) ?? []).length, 1);
});

test("unassigned project creation uses the host default instead of artifact cwd", () => {
  const artifact =
    "D:\\desktop\\zen\\apps\\zenx\\.packaged\\artifact\\ZenX-win32-x64";
  const group = deriveProjectGroups(
    [thread("artifact", { type: "idle" }, artifact)],
    ["D:\\work"],
    "D:\\work",
  ).find((candidate) => candidate.key === "__unassigned__");
  assert.ok(group);
  let requestedCwd: string | undefined = "not-called";
  const onNewThread = (cwd?: string) => {
    requestedCwd = cwd;
  };
  const action = ProjectCreateThreadButton({ group, onNewThread });
  action.props.onClick();
  assert.equal(requestedCwd, undefined);
});

test("unauthenticated subscription cannot satisfy the onboarding provider gate", () => {
  assert.equal(
    isProviderReady(
      { type: "openai-subscription", displayName: "OpenAI subscription" },
      false,
      false,
      "",
    ),
    false,
  );
});

test("unavailable model explains no silent change and offers an explicit repair", () => {
  const html = renderToStaticMarkup(
    createElement(ModelSelector, {
      disabled: false,
      error: null,
      models: [model("gpt-ready", true)],
      onChange: noop,
      repairModel: "gpt-ready",
      selectedModel: "fake",
      switching: false,
    }),
  );
  assert.match(html, /model is unavailable/i);
  assert.match(html, /setting has not changed/i);
  assert.match(html, /Switch to gpt-ready/);
});

test("subscription model repair follows the current Terra host default", () => {
  const html = renderToStaticMarkup(
    createElement(ModelSelector, {
      disabled: false,
      error: null,
      models: [model("gpt-5.6-terra", true), model("gpt-5.6-sol", false)],
      onChange: noop,
      repairModel: "gpt-5.6-terra",
      selectedModel: "fake",
      switching: false,
    }),
  );
  assert.match(html, /Switch to gpt-5.6-terra/);
  assert.doesNotMatch(html, /Switch to fake/);
});

test("thread title actions expose visible rename and non-destructive archive", () => {
  const html = renderToStaticMarkup(
    createElement(ThreadTitleEditor, {
      actionError: null,
      title: "Important work",
      projection: undefined,
      onRename: noopAsync,
      onRetry: noopAsync,
      onArchive: noopAsync,
    }),
  );
  assert.match(html, />Rename</);
  assert.match(html, />Archive</);
  assert.match(html, /journal and files stay untouched/i);
});

test("legacy maintenance distinguishes safe, useful, and unknown entries", () => {
  const html = renderToStaticMarkup(
    createElement(LegacyJournalCard, {
      report: {
        zenHome: "D:\\zen",
        threadsDirectory: "D:\\zen\\threads",
        quarantineDirectory: "D:\\zen\\legacy-journal-quarantine",
        counts: {
          current: 0,
          knownLegacy: 2,
          legacyNoUsefulContent: 1,
          legacyUsefulContent: 1,
          unknown: 1,
          unavailable: 3,
        },
        candidates: [],
      },
      result: "Moved 1 empty legacy journal. The list has been refreshed.",
      busy: false,
      onCleanup: noopAsync,
    }),
  );
  assert.match(html, /3 unavailable journals/);
  assert.match(html, /Safe to clean up/);
  assert.match(html, /Useful legacy content/);
  assert.match(html, /Unknown or damaged/);
  assert.match(html, /recoverable quarantine/);
  assert.match(html, /list has been refreshed/);
});

test("post-cleanup legacy projection preserves useful JSONL without a cleanup target", () => {
  const html = renderToStaticMarkup(
    createElement(LegacyJournalCard, {
      report: {
        zenHome: "D:\\zen",
        threadsDirectory: "D:\\zen\\threads",
        quarantineDirectory: "D:\\zen\\legacy-journal-quarantine",
        counts: {
          current: 2,
          knownLegacy: 1,
          legacyNoUsefulContent: 0,
          legacyUsefulContent: 1,
          unknown: 0,
          unavailable: 1,
        },
        candidates: [],
      },
      result: null,
      busy: false,
      onCleanup: noopAsync,
    }),
  );
  assert.match(html, /1 unavailable journal/);
  assert.match(html, /Useful legacy content<\/dt><dd>1/);
  assert.match(html, /Safe to clean up<\/dt><dd>0/);
  assert.match(html, /Useful and unknown files remain untouched/);
  assert.match(html, /disabled=""/);
});

test("apply area keeps dirty, restarting, applied, and failure states explicit", () => {
  assert.equal(applyStatusCopy("idle", true), "Changes ready to apply");
  assert.equal(
    applyStatusCopy("restarting", true),
    "Restarting the local host…",
  );
  assert.equal(applyStatusCopy("applied", false), "Applied on this device");
  assert.equal(applyStatusCopy("failed", true), "Changes were not applied");
});

test("successful legacy cleanup refreshes canonical threads before reporting completion", async () => {
  const calls: string[] = [];
  const result = await cleanupLegacyJournalsAndRefreshThreads(
    async () => {
      calls.push("cleanup");
      return { moved: 178 };
    },
    async () => {
      calls.push("thread/list");
    },
  );
  assert.deepEqual(result, { moved: 178 });
  assert.deepEqual(calls, ["cleanup", "thread/list"]);

  for (const mode of ["projects", "inbox"] as const) {
    const before = renderSidebar(mode, [
      thread("safe", { type: "systemError" }, ""),
      thread("useful", { type: "systemError" }, ""),
    ]);
    const after = renderSidebar(mode, [
      thread("useful", { type: "systemError" }, ""),
    ]);
    assert.match(before, /2 unavailable journals/);
    assert.match(after, /1 unavailable journal/);
    assert.doesNotMatch(after, /2 unavailable journals/);
  }
});

function thread(id: string, status: Thread["status"], cwd: string): Thread {
  return {
    id,
    sessionId: id,
    forkedFromId: null,
    parentThreadId: null,
    preview: "",
    ephemeral: false,
    isPinned: false,
    modelProvider: "",
    createdAt: 1,
    updatedAt: 1,
    recencyAt: null,
    status,
    path: null,
    cwd,
    cliVersion: "zen/0.1.0",
    source: "appServer",
    threadSource: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: null,
    turns: [],
  };
}

function renderSidebar(
  mode: "projects" | "inbox",
  threads: readonly Thread[],
): string {
  return renderToStaticMarkup(
    createElement(Sidebar, {
      configuredWorkspaces: ["D:\\work"],
      defaultWorkspace: "D:\\work",
      mode,
      onModeChange: noop,
      onNewThread: noop,
      onAddProject: noop,
      onRemoveProject: noop,
      onSetDefaultProject: noop,
      onOpenSettings: noop,
      onOpenScheduled: noop,
      onSelectRoom: noop,
      onSelectThread: noop,
      pendingApprovalThreadIds: new Set(),
      projectActionError: null,
      selectedThreadId: null,
      serverReady: true,
      threads,
      triggerSnapshot: { triggers: [], history: [], rooms: [] },
    }),
  );
}

function model(id: string, isDefault: boolean) {
  return {
    id,
    model: id,
    upgrade: null,
    upgradeInfo: null,
    availabilityNux: null,
    displayName: id,
    description: "",
    hidden: false,
    supportedReasoningEfforts: [],
    defaultReasoningEffort: "medium" as const,
    inputModalities: ["text"] as ["text"],
    supportsPersonality: false as const,
    additionalSpeedTiers: [],
    serviceTiers: [],
    defaultServiceTier: null,
    isDefault,
  };
}
