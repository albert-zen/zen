import type {
  ExternalApplicationId,
  ExternalOpenRequest,
} from "../src/main/workspace-external-open.js";
/** Actual workspace components with synthetic, memory-only file data. */
import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { WorkspaceTextFile } from "../src/main/workspace-files.js";
import { AuxiliaryPanel } from "../src/renderer/src/auxiliary-panel.js";
import {
  WorkspaceFileDrafts,
  fileDraftKey,
} from "../src/renderer/src/workspace-file-drafts.js";
import { ZenXBrand } from "../src/renderer/src/ZenXBrand.js";
import { i18n } from "../src/renderer/src/i18n.js";
import "../src/renderer/src/theme.css";
import "../src/renderer/src/styles.css";

const search = new URLSearchParams(location.search);
const language = search.get("lang") === "zh-CN" ? "zh-CN" : "en";
const appearance = search.get("theme") === "light" ? "light" : "dark";
const threadId = "synthetic-file-sidebar-thread";
const workspace = "/synthetic/file-sidebar-preview";
const sourcePath = "src/long-source.ts";
const markdownPath = "docs/long-notes.md";
const source =
  Array.from(
    { length: 320 },
    (_, index) =>
      `export const line${String(index + 1).padStart(3, "0")} = ${index + 1}; // ${"A wide synthetic source line keeps horizontal navigation measurable. ".repeat(4)}`,
  ).join("\n") + "\n// LAST_SOURCE_LINE: end of the synthetic source file.\n";
const markdown =
  "# Long file reading preview\n\n" +
  Array.from(
    { length: 100 },
    (_, index) =>
      `## Section ${index + 1}\n\nThis is synthetic Markdown for checking a bounded editor viewport. Reading should scroll the editor, not move its breadcrumbs or the workspace tab row.\n\n- Item ${index + 1}: **bold content** and an inline \`code sample\`.\n- Another item with enough ordinary text to wrap naturally in a narrow pane.\n\n`,
  ).join("") +
  "## LAST_MARKDOWN_SECTION\n\nEnd of the synthetic Markdown file.\n";
const files = new Map<string, WorkspaceTextFile>([
  [
    sourcePath,
    { path: sourcePath, text: source, revision: "synthetic-source-v1" },
  ],
  [
    markdownPath,
    { path: markdownPath, text: markdown, revision: "synthetic-markdown-v1" },
  ],
]);
const drafts = new WorkspaceFileDrafts();
for (const file of files.values())
  drafts.set(fileDraftKey(threadId, file.path), {
    base: file,
    text: file.text,
  });
const calls: { method: string; threadId: string; path: string }[] = [];
const record = (method: string, owner: string, path: string) => {
  if (owner !== threadId)
    throw new Error("Synthetic fixture received an unexpected resource owner.");
  calls.push({ method, threadId: owner, path });
};
document.documentElement.lang = language;
document.documentElement.dataset.appearance = appearance;
document.documentElement.dataset.themePreset = "graphite";
document.documentElement.dataset.platform = "linux";
void i18n.changeLanguage(language);
const externalCalls: unknown[] = [];
const externalState = { rejectRemote: false };
const applications: Partial<Record<ExternalApplicationId, string>> = {
  vscode: "/synthetic/apps/VS Code",
  cursor: "/synthetic/apps/Cursor",
  editor: "/synthetic/apps/Text Editor",
};
Object.assign(window, {
  zenx: {
    platform: "linux",
    workspaceFiles: {
      applications: async () => ({
        platform: "linux",
        applications: { ...applications },
      }),
      configureApplication: async (
        id: ExternalApplicationId,
        reset: boolean,
      ) => {
        externalCalls.push({ operation: "synthetic-picker", id, reset });
        if (reset) delete applications[id];
        else applications[id] = "/synthetic/apps/Chosen Editor";
        return { platform: "linux", applications: { ...applications } };
      },
      openExternal: async (input: ExternalOpenRequest) => {
        if (
          input.host !== "local" ||
          input.threadId !== threadId ||
          !files.has(input.path)
        )
          throw new Error("Invalid synthetic file identity");
        if (externalState.rejectRemote)
          throw new Error(
            "External opening supports local Host files only. No local fallback was attempted.",
          );
        externalCalls.push({ operation: "synthetic-open", ...input });
      },
      read: async (owner: string, path: string) => {
        record("read", owner, path);
        const file = files.get(path);
        if (!file) throw new Error(`Unknown synthetic file: ${path}`);
        return { ...file };
      },
      list: async (owner: string, path: string) => {
        record("list", owner, path);
        return {
          path,
          truncated: false,
          entries:
            path === "."
              ? ["docs", "src"].map((name) => ({
                  name,
                  path: name,
                  kind: "directory",
                }))
              : [...files.keys()]
                  .filter((file) => file.startsWith(`${path}/`))
                  .map((file) => ({
                    name: file.split("/").at(-1)!,
                    path: file,
                    kind: "file",
                  })),
        };
      },
      search: async (owner: string, query: string) => {
        record("search", owner, query);
        return {
          cwd: workspace,
          scanned: files.size,
          truncated: false,
          entries: [...files.keys()]
            .filter((path) => path.includes(query))
            .map((path) => ({ path, name: path.split("/").at(-1)! })),
        };
      },
      save: async () => {
        throw new Error(
          "Saving is unavailable in this read-only synthetic fixture.",
        );
      },
    },
  },
  __fileSidebarPreview: {
    sourcePath,
    markdownPath,
    threadId,
    calls,
    externalCalls,
    externalState,
    synthetic: true,
  },
});

function Preview() {
  const [selectedTab, setSelectedTab] = useState(`file:${sourcePath}`);
  const [openedTabs, setOpenedTabs] = useState([
    `file:${sourcePath}`,
    `file:${markdownPath}`,
    "custom:overview",
  ]);
  const [open, setOpen] = useState(true);
  const [workspacePanelWidth, setWorkspacePanelWidth] = useState(0);
  useEffect(() => {
    let active = true;
    void document.fonts.ready.then(() =>
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          if (active) document.body.dataset.previewReady = "true";
        }),
      ),
    );
    return () => {
      active = false;
    };
  }, []);
  return (
    <div
      className="app-shell sidebar-collapsed"
      style={
        {
          "--workspace-panel-width": `${workspacePanelWidth}px`,
        } as React.CSSProperties
      }
    >
      <header className="window-titlebar">
        <div className="window-titlebar-product">
          <ZenXBrand />
        </div>
        <div className="window-titlebar-session" />
      </header>
      <main className="workspace">
        <section className="agent-surface" style={{ padding: 28 }}>
          <h1 style={{ fontSize: 18 }}>File reading preview</h1>
          <p
            style={{
              maxWidth: 300,
              color: "var(--color-text-muted)",
              fontSize: 12,
              lineHeight: 1.7,
            }}
          >
            Actual AuxiliaryPanel, file tree, breadcrumbs and CodeMirror
            editors. Synthetic long source and Markdown only. No Host, private
            files or external access.
          </p>
        </section>
        <AuxiliaryPanel
          threadId={threadId}
          title="Synthetic file review"
          open={open}
          onOpenChange={setOpen}
          onWidthChange={setWorkspacePanelWidth}
          snapshot={null}
          selectedTab={selectedTab}
          onSelectTab={setSelectedTab}
          openedTabs={openedTabs}
          onTabsChange={setOpenedTabs}
          workspacePath={workspace}
          fileDrafts={drafts}
          customTabs={[
            {
              id: "overview",
              title: "Overview",
              icon: "layers",
              render: () => (
                <p style={{ padding: 20 }}>
                  Synthetic non-file tab. File navigation must not appear here.
                </p>
              ),
            },
          ]}
        />
      </main>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<Preview />);
