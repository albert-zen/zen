import React from "react";
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

/** Synthetic Room wakeup text; the same shape a real PAW first message has. */
const roomWakeup = [
  "[ZenX trigger wakeup]",
  "Trigger ID: 00000000-0000-4000-8000-000000000000",
  "Reason: Room #PAW mention from You: 帮我看一下构建",
  "Source Room: 63c6c01d-5989-4d55-bf78-03e714189d3e",
  "Source Room message: 00000000-0000-4000-8000-000000000001",
  "Registered trigger: PAW",
  "",
  "Injected prompt:",
  "You are the user's ongoing personal assistant in ZenX.",
].join("\n");

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

// 1. PAW/Room working Thread with its own name (the reported case).
const namedPaw = summary("named-paw", "PAW 助理", roomWakeup);
// 2. Same first message, no name yet: the first-message preview is provisional.
const unnamedPaw = summary("unnamed-paw", undefined, roomWakeup);
// 3. A legacy name that is itself the raw wakeup prompt stays disclosed.
const legacyNamed = summary("legacy-named", roomWakeup, "");

const threads = [namedPaw, unnamedPaw, legacyNamed];

await i18n.changeLanguage("zh-CN");

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
      <h1>Thread title authority</h1>
      <p>
        Synthetic Threads rendered by the production Sidebar. No live task, no
        profile write, no Provider call.
      </p>
      <ol>
        <li>
          <code>named-paw</code>: a PAW/Room working Thread whose first message
          is a Room wakeup, with its own name. The name wins.
        </li>
        <li>
          <code>unnamed-paw</code>: same first message, still unnamed. Only this
          case falls back to the first-message preview.
        </li>
        <li>
          <code>legacy-named</code>: a legacy name that is itself the raw wakeup
          prompt keeps the short disclosure label.
        </li>
      </ol>
    </div>
  </main>,
);
