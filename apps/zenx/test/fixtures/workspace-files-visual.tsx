import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { AuxiliaryPanel } from "../../src/renderer/src/auxiliary-panel.js";
import { Sidebar } from "../../src/renderer/src/Sidebar.js";
import { ThreadView } from "../../src/renderer/src/ThreadView.js";
import { Icon } from "../../src/renderer/src/icons.js";
import { emptyComposerState } from "../../src/renderer/src/composer-state.js";
import { runtimeThread, runtimeMessage } from "./agent-runtime-data.js";
import type { NativeThreadSummary } from "../../../../src/thread-summary.js";
import { WorkspaceFileDrafts } from "../../src/renderer/src/workspace-file-drafts.js";
import { i18n } from "../../src/renderer/src/i18n.js";
import "../../src/renderer/src/theme.css";
import "../../src/renderer/src/styles.css";
import "../../src/renderer/src/shell-thread-panel.css";
import "../../src/renderer/src/agent-readiness-notice.css";
import "../../src/renderer/src/trigger-ui.css";
import "../../src/renderer/src/skills.css";
import "../../src/renderer/src/rooms-layout.css";
import "../../src/renderer/src/room-message-actions.css";
import "../../src/renderer/src/room-conversations.css";
import "../../src/renderer/src/companion-workspace.css";
Object.assign(globalThis, { React });
const params = new URLSearchParams(location.search);
void i18n.changeLanguage(params.get("lang") ?? "en");
document.documentElement.dataset.appearance = params.get("theme") ?? "dark";
document.documentElement.dataset.platform = params.get("platform") ?? "darwin";
const files: Record<string, string> = {
  "cmd/demo/main.go": [
    "package main",
    "",
    'import "fmt"',
    "",
    "// A synthetic file for checking syntax and scrolling.",
    "func main() {",
    '    message := "A long line: ' + "readable source ".repeat(25) + '"',
    "    fmt.Println(message)",
    "}",
    "",
    ...Array.from(
      { length: 240 },
      (_, index) =>
        `// Example line ${index + 1}: source stays editable throughout the file.`,
    ),
    "",
    "// END OF SYNTHETIC FILE",
    "",
  ].join("\n"),
  "README.md":
    "# File search\n\nFind files across the workspace without leaving your conversation.\n\n## Keyboard shortcuts\n\n- **Ctrl / Cmd P**: find a file by name or path\n- **Ctrl / Cmd F**: find text in the current file\n\nSearch keeps your draft safe while you move between files.\n",
  "package.json": '{\n  "name": "workspace-demo",\n  "private": true\n}\n',
  "src/components/FileSearch.tsx":
    'import { useState } from "react";\n\n// Search files in the current workspace.\nexport function FileSearch() {\n  const [query, setQuery] = useState("");\n  const limit = 80;\n\n  return (\n    <input\n      aria-label="Find a file"\n      value={query}\n      onChange={(event) => setQuery(event.target.value)}\n    />\n  );\n}\n',
  "src/components/WorkspacePanel.tsx": "export const panel = 'workspace';\n",
  "src/styles/theme.css": ":root {\n  --accent: #2563eb;\n}\n",
  "tests/FileSearch.test.ts":
    "// Keeps stale requests out of the current workspace.\nexport const result = true;\n",
  "docs/architecture.md":
    "# Architecture\n\nOne workspace, one file boundary.\n",
};
const drafts = new WorkspaceFileDrafts(100);
(window as any).zenx = {
  plugins: { executeCommand: async () => null, readHandle: async () => null },
  workspaceFiles: {
    applications: async () => ({
      platform: "darwin",
      applications: {
        vscode: "/Applications/Visual Studio Code.app",
        cursor: "/Applications/Cursor.app",
        editor: "/System/Applications/TextEdit.app",
      },
    }),
    openExternal: async () => {
      throw new Error("Synthetic preview: no application is launched");
    },
    configureApplication: async () => {
      throw new Error("Synthetic preview: no native picker is opened");
    },
    list: async (_thread: string, relative: string) => {
      const prefix = relative === "." ? "" : relative + "/";
      const entries = new Map<
        string,
        { name: string; path: string; kind: string }
      >();
      for (const file of Object.keys(files))
        if (file.startsWith(prefix)) {
          const remainder = file.slice(prefix.length);
          const name = remainder.split("/")[0]!;
          entries.set(name, {
            name,
            path: prefix + name,
            kind: remainder.includes("/") ? "directory" : "file",
          });
        }
      return {
        path: relative,
        entries: [...entries.values()].sort(
          (a, b) =>
            (a.kind === b.kind ? 0 : a.kind === "directory" ? -1 : 1) ||
            a.name.localeCompare(b.name),
        ),
        truncated: false,
      };
    },
    search: async (_thread: string, query: string) => ({
      cwd: "/synthetic/workspace-demo",
      entries: Object.keys(files)
        .filter((path) => path.toLowerCase().includes(query.toLowerCase()))
        .map((path) => ({ path, name: path.split("/").at(-1)! })),
      scanned: 12,
      truncated: false,
    }),
    read: async (_thread: string, path: string) => {
      if (!(path in files))
        throw new Error("File not found in this synthetic workspace");
      return { path, text: files[path], revision: "a".repeat(64) };
    },
    save: async (_thread: string, path: string, text: string) => {
      files[path] = text;
      return {
        status: "saved",
        file: { path, text, revision: "a".repeat(64) },
      };
    },
  },
};
// Production navigation, conversation and AuxiliaryPanel; data below is synthetic.
const thread = {
  ...runtimeThread(
    [
      {
        type: "userMessage" as const,
        id: "user",
        clientId: null,
        content: [
          {
            type: "text" as const,
            text: "Help me understand how file search works in this project.",
            text_elements: [],
          },
        ],
      },
      runtimeMessage(
        "answer",
        "The file search lives in `src/components/FileSearch.tsx`.\n\nIt keeps the query local, searches across the workspace, and ignores older results when the query changes.\n\nOpen the file on the right to explore the implementation. Your conversation stays here while you browse and edit.",
      ),
    ],
    "completed",
    "fixture",
  ),
  name: "Explore file search",
  cwd: "/synthetic/workspace-demo",
};
const summaries: NativeThreadSummary[] = [
  "Explore file search",
  "Review workspace navigation",
  "Project notes",
].map((name, index) => ({
  threadId: index ? `fixture-${index}` : "fixture",
  name,
  archived: false,
  createdAt: "2026-10-14T05:00:00Z",
  updatedAt: "2026-10-14T05:00:00Z",
  preview: name,
  status: "idle",
  currentMetadata: {
    model: "gpt-5.4",
    provider: "openai",
    cwd: "/synthetic/workspace-demo",
    sandbox: "workspace-write",
    approvalPolicy: "on-request",
  },
}));
const firstPath = params.get("file") ?? "cmd/demo/main.go";
drafts.set(JSON.stringify(["fixture", firstPath]), {
  base: { path: firstPath, text: files[firstPath]!, revision: "a".repeat(64) },
  text: files[firstPath]!,
});
function Fixture() {
  const [selected, setSelected] = useState(`file:${firstPath}`);
  const [opened, setOpened] = useState(true);
  const [width, setWidth] = useState(520);
  const [composer, setComposer] = useState(emptyComposerState());
  const narrow = params.has("narrow");
  return (
    <div
      className={"app-shell" + (narrow ? " sidebar-collapsed" : "")}
      style={
        {
          "--workspace-panel-width": `${width}px`,
          ...(narrow ? { width: 390, maxWidth: "100vw" } : {}),
        } as React.CSSProperties
      }
    >
      <header className="window-titlebar">
        <div className="window-titlebar-product">
          <span style={{ paddingLeft: 18, fontWeight: 650 }}>ZenX</span>
        </div>
        <div
          className="workspace-heading-row"
          style={{
            paddingInline: 16,
            color: "var(--color-text-secondary)",
            fontSize: 12,
          }}
        >
          workspace-demo <Icon name="chevron-right" /> Explore file search
        </div>
      </header>
      <Sidebar
        mode="projects"
        open={false}
        collapsed={narrow}
        onClose={() => {}}
        onChangeThreadLifecycle={async () => {}}
        onChangeThreadPinned={async () => {}}
        onNewThread={() => {}}
        onAddProject={() => {}}
        onRemoveProject={() => {}}
        onSetDefaultProject={() => {}}
        onOpenContribution={() => {}}
        onOpenSettings={() => {}}
        onRetryThreads={() => {}}
        onRenameThread={async () => {}}
        onSelectThread={() => {}}
        pendingApprovalThreadIds={new Set()}
        pluginContributions={[]}
        selectedPage="agent"
        selectedThreadId="fixture"
        serverStatus={{ type: "ready", reconnected: false }}
        liveThread={thread}
        threadError={null}
        threadLoading={false}
        projects={{
          projects: [
            {
              key: "/synthetic/workspace-demo",
              workspace: "/synthetic/workspace-demo",
              name: "workspace-demo",
              configured: true,
              isDefault: true,
              threadIds: summaries.map((value) => value.threadId),
            },
          ],
          unavailableThreadIds: [],
          lastUsedWorkspace: "/synthetic/workspace-demo",
        }}
        pinnedThreads={[]}
        threads={summaries}
      />
      <main className="workspace">
        <section className="agent-surface">
          <ThreadView
            thread={thread}
            composer={composer}
            approvals={[]}
            onDraftChange={(text) =>
              setComposer((value) => ({
                ...value,
                draft: { ...value.draft, text },
              }))
            }
            onInterrupt={async () => {}}
            onRespondToApproval={async () => {}}
            onSubmit={async () => {}}
          />
        </section>
        <AuxiliaryPanel
          threadId="fixture"
          title="Explore file search"
          workspacePath="/synthetic/workspace-demo"
          open={opened}
          onOpenChange={setOpened}
          selectedTab={selected}
          onSelectTab={setSelected}
          fileDrafts={drafts}
          snapshot={null}
          onWidthChange={setWidth}
        />
      </main>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
