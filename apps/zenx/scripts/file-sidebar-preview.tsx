/** Actual workspace components with synthetic, memory-only file data. */
import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { WorkspaceTextFile } from "../src/main/workspace-files.js";
import { AuxiliaryPanel } from "../src/renderer/src/auxiliary-panel.js";
import {
  WorkspaceFileDrafts,
  fileDraftKey,
} from "../src/renderer/src/workspace-file-drafts.js";
import { Markdown, MessageLinkContext } from "../src/renderer/src/Markdown.js";
import { ZenXBrand } from "../src/renderer/src/ZenXBrand.js";
import { i18n } from "../src/renderer/src/i18n.js";
import "../src/renderer/src/theme.css";
import "../src/renderer/src/styles.css";

const search = new URLSearchParams(location.search);
const language = search.get("lang") === "zh-CN" ? "zh-CN" : "en";
const diagnosticPreview = search.get("diagnostic") === "true";
const previewPlatform = diagnosticPreview ? "darwin" : "linux";
const linkPreview = search.get("links") === "true";
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
const markdown = diagnosticPreview
  ? Array.from(
      { length: 100 },
      (_, index) =>
        `## 合成诊断段落 ${index + 1}\n\n${"这里是完全合成的中文长段落，用来检查文件树保持开启时窄正文区域能否正确换行与滚动，不包含任何用户文件内容。".repeat(10)}\n\n`,
    ).join("") + "## LAST_MARKDOWN_SECTION\n\n合成内容结束。\n"
  : "# Long file reading preview\n\n" +
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
document.documentElement.dataset.platform = previewPlatform;
void i18n.changeLanguage(language);
Object.assign(window, {
  zenx: {
    platform: previewPlatform,
    workspaceFiles: {
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
  const [open, setOpen] = useState(!linkPreview);
  const sequence = useRef(0);
  const [messageLinkRequest, setMessageLinkRequest] = useState<{
    id: number;
    kind: "file" | "browser";
    value: string;
  } | null>(null);
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
          {linkPreview && (
            <div data-local-path-preview style={{ maxWidth: 480 }}>
              <MessageLinkContext.Provider
                value={(target) => {
                  if (target.kind === "browser") {
                    // Record the existing message navigation callback only;
                    // this renderer fixture must never visit a real endpoint.
                    record("browser", threadId, target.value);
                    return;
                  }
                  setMessageLinkRequest({ ...target, id: ++sequence.current });
                  setOpen(true);
                }}
              >
                <Markdown
                  text={
                    (language === "zh-CN"
                      ? "请查看 docs/long-notes.md，然后检查 `src/long-source.ts`。\n\n绝对路径也可以：`/synthetic/file-sidebar-preview/docs/long-notes.md`。\n\n没有自动访问文件，只有点击后才打开右侧文件栏。\n\n```text\n/synthetic/file-sidebar-preview/src/long-source.ts\n```"
                      : "Read docs/long-notes.md, then inspect `src/long-source.ts`.\n\nAbsolute paths work too: `/synthetic/file-sidebar-preview/docs/long-notes.md`.\n\nFiles are opened in the right sidebar only when you click.\n\n```text\n/synthetic/file-sidebar-preview/src/long-source.ts\n```") +
                    "\n\n合成 URL / Synthetic URLs: `http://127.0.0.1:40123/review?q=one#details` · `https://example.test/report`"
                  }
                />
              </MessageLinkContext.Provider>
            </div>
          )}
        </section>
        <AuxiliaryPanel
          threadId={threadId}
          messageLinkRequest={messageLinkRequest}
          onMessageLinkRequestHandled={() => setMessageLinkRequest(null)}
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
