import React from "react";
import {
  firstInputMessagePreview,
  type DeliveredInputItem,
} from "../../../../src/item.js";
import { createRoot } from "react-dom/client";
import type { NativeThreadSummary } from "../../../../src/thread-summary.js";
import { Sidebar } from "../../src/renderer/src/Sidebar.js";
import { i18n } from "../../src/renderer/src/i18n.js";
import { installScrollbarVisibility } from "../../src/renderer/src/scrollbar-visibility.js";
import "../../src/renderer/src/theme.css";
import "../../src/renderer/src/styles.css";

installScrollbarVisibility(document);
const { createElement } = React;
const noop = () => undefined;

function summary(
  threadId: string,
  name: string | undefined,
  preview: string,
  cwd = "/work/demo",
): NativeThreadSummary {
  return {
    threadId,
    currentMetadata: {
      model: "kimi-k3",
      provider: "dashscope",
      cwd,
      sandbox: "danger-full-access",
      approvalPolicy: "never",
    },
    archived: false,
    createdAt: new Date(1_000).toISOString(),
    updatedAt: new Date(2_000).toISOString(),
    ...(name === undefined ? {} : { name }),
    preview,
    status: "idle",
  };
}

// Synthetic canonical inputs, rendered by the production Sidebar; no Host runs.
const stamp = "2026-01-01T00:00:00.000Z";
const base = {
  id: "input",
  threadId: "synthetic",
  turnId: "turn",
  clientId: "client",
  createdAt: stamp,
};
const user: DeliveredInputItem = {
  ...base,
  type: "user_message",
  text: "User input · Investigate the release build",
};
const threadInput: DeliveredInputItem = {
  ...base,
  type: "thread_message",
  mode: "batch-next",
  messageType: "follow_up",
  sender: {
    threadId: "synthetic-source",
    turnId: "source-turn",
    toolCallId: "tool",
    callId: "call",
  },
  content: [{ type: "text", text: "Thread input · Review the release plan" }],
};
const host: DeliveredInputItem = {
  ...base,
  type: "host_message",
  sender: "host",
  source: "bootstrap",
  mode: "start",
  text: "Host input · Prepare the weekly summary",
};
const threads = [
  summary("user-preview", undefined, firstInputMessagePreview([user])),
  summary(
    "thread-preview",
    undefined,
    firstInputMessagePreview([threadInput, user]),
  ),
  summary("host-preview", undefined, firstInputMessagePreview([host, user])),
  summary(
    "thread-generated",
    "Release plan review",
    firstInputMessagePreview([threadInput]),
  ),
  summary("host-generated", "Weekly summary", firstInputMessagePreview([host])),
  summary(
    "manual-title",
    "My saved title stays unchanged",
    firstInputMessagePreview([host]),
  ),
];
const theme = new URLSearchParams(location.search).get("theme") ?? "light";
document.documentElement.dataset.theme = theme;
document.documentElement.dataset.platform = "linux";

await i18n.changeLanguage("en");

createRoot(document.getElementById("root")!).render(
  <main style={{ display: "flex", height: "100vh", gap: 24 }}>
    {createElement(Sidebar, {
      liveThread: null,
      mode: "projects",
      open: true,
      onClose: noop,
      onNewThread: noop,
      onAddProject: noop,
      onRemoveProject: noop,
      onSetDefaultProject: noop,
      onOpenContribution: noop,
      onOpenSettings: noop,
      onChangeThreadLifecycle: async () => undefined,
      onChangeThreadPinned: async () => undefined,
      onRenameThread: async () => undefined,
      onRetryThreads: noop,
      onSelectThread: noop,
      pendingApprovalThreadIds: new Set<string>(),
      pinnedThreads: [],
      pluginContributions: [],
      projects: {
        projects: [
          {
            key: "/work/demo",
            workspace: "/work/demo",
            configured: true,
            isDefault: true,
            threadIds: threads.map((thread) => thread.threadId),
          },
        ],
        unavailableThreadIds: [],
        lastUsedWorkspace: "/work/demo",
      },
      selectedPage: "agent",
      selectedThreadId: null,
      serverStatus: { type: "ready", reconnected: false },
      threadError: null,
      threadLoading: false,
      threads,
    })}
    <div style={{ padding: 40, maxWidth: 460 }}>
      <h1>Every first input counts</h1>
      <p>
        Synthetic canonical input, real production Sidebar. No user device, live
        task, profile write or Provider call.
      </p>
      <ol>
        <li>Unnamed User, Thread and Host inputs all supply a preview.</li>
        <li>Generated native titles replace their provisional previews.</li>
        <li>A saved manual title stays authoritative.</li>
      </ol>
      <p>
        Source and lifecycle behavior are verified separately by native
        recovery, live event and naming ownership regression tests.
      </p>
    </div>
  </main>,
);
