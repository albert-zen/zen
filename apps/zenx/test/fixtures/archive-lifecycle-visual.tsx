import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { Sidebar } from "../../src/renderer/src/Sidebar.js";
import { ArchivedThreadsPanel } from "../../src/renderer/src/SettingsView.js";
import type { NativeThreadSummary } from "../../../../src/thread-summary.js";
import "../../src/renderer/src/theme.css";
import "../../src/renderer/src/styles.css";
const noop = () => undefined;
Object.assign(window, {
  zenx: {
    platform: "darwin",
    settings: {
      get: async () => ({ profile: { providerProfiles: [] } }),
      onChanged: () => noop,
    },
  },
});
function App() {
  const [threads, setThreads] = useState(
    Array.from({ length: 40 }, (_, index): NativeThreadSummary => ({
      threadId: `thread-${String(index).padStart(2, "0")}`,
      name: `Conversation ${String(index + 1).padStart(2, "0")}`,
      archived: false,
      lastItemId: `last-${index}`,
      currentMetadata: {
        model: "gpt-5.6",
        provider: "openai",
        cwd: "/synthetic/zen",
        sandbox: "danger-full-access",
        approvalPolicy: "never",
      },
      createdAt: new Date(1000).toISOString(),
      updatedAt: new Date(2000).toISOString(),
      preview: "",
      status: "idle",
    })),
  );
  const [archived, setArchived] = useState<NativeThreadSummary[]>([]);
  const [deleted, setDeleted] = useState<NativeThreadSummary[]>([]);
  const [fail, setFail] = useState(false);
  return (
    <div className="app-shell" style={{ height: "100vh" }}>
      <header className="window-titlebar" style={{ padding: "12px" }}>
        ZenX synthetic archive QA
      </header>
      <Sidebar
        mode="inbox"
        open={true}
        onClose={noop}
        onNewThread={noop}
        onAddProject={noop}
        onRemoveProject={noop}
        onSetDefaultProject={noop}
        onOpenContribution={noop}
        onOpenSettings={noop}
        onChangeThreadLifecycle={async (thread) => {
          await new Promise((resolve) => setTimeout(resolve, 120));
          if (fail) throw new Error("Synthetic archive failure");
          setThreads((value) =>
            value.filter((item) => item.threadId !== thread.threadId),
          );
          setArchived((value) => [...value, { ...thread, archived: true }]);
        }}
        onChangeThreadPinned={async () => undefined}
        onRenameThread={async () => undefined}
        onRetryThreads={noop}
        onSelectThread={noop}
        pendingApprovalThreadIds={new Set()}
        pluginContributions={[]}
        projects={{
          projects: [],
          unavailableThreadIds: [],
          lastUsedWorkspace: null,
        }}
        selectedPage="agent"
        selectedThreadId={null}
        serverStatus={{ type: "ready", reconnected: false }}
        liveThread={null}
        threadError={null}
        threadLoading={false}
        pinnedThreads={[]}
        threads={threads}
      />
      <main
        style={{
          gridRow: 2,
          gridColumn: 2,
          overflow: "auto",
          padding: "28px",
          minWidth: 0,
        }}
      >
        <label style={{ display: "flex", gap: "8px", marginBottom: "24px" }}>
          <input
            type="checkbox"
            checked={fail}
            onChange={(event) => setFail(event.target.checked)}
          />
          Simulate request failure
        </label>
        <section className="settings-panel">
          <ArchivedThreadsPanel
            error={null}
            loading={false}
            onRetry={noop}
            threads={archived}
            onUnarchive={async (thread) => {
              setArchived((value) =>
                value.filter((item) => item.threadId !== thread.threadId),
              );
              setThreads((value) => [...value, { ...thread, archived: false }]);
            }}
            onDelete={async (thread) => {
              if (fail) throw new Error("Synthetic delete failure");
              setArchived((value) =>
                value.filter((item) => item.threadId !== thread.threadId),
              );
              setDeleted((value) => [...value, thread]);
            }}
            deletedThreads={deleted.map((thread) => ({
              threadId: thread.threadId,
              name: thread.name,
              cwd: "/synthetic/zen",
              deletedAt: new Date().toISOString(),
              deletionItemId: `delete-${thread.threadId}`,
            }))}
            onRestoreDeleted={async (item) => {
              const thread = deleted.find(
                (thread) => thread.threadId === item.threadId,
              )!;
              setDeleted((value) =>
                value.filter((thread) => thread.threadId !== item.threadId),
              );
              setArchived((value) => [...value, thread]);
            }}
          />
        </section>
      </main>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
