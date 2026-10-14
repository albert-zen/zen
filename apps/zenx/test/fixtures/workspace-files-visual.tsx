import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { WorkspaceFilePicker } from "../../src/renderer/src/workspace-file-picker.js";
import { WorkspaceFilesPanel } from "../../src/renderer/src/workspace-files-panel.js";
import { WorkspaceFileDrafts } from "../../src/renderer/src/workspace-file-drafts.js";
import { i18n } from "../../src/renderer/src/i18n.js";
import "../../src/renderer/src/theme.css";
import "../../src/renderer/src/styles.css";
const params = new URLSearchParams(location.search);
void i18n.changeLanguage(params.get("lang") ?? "en");
document.documentElement.dataset.appearance = params.get("theme") ?? "light";
const files: Record<string, string> = {
  "README.md":
    "# Workspace preview\n\nSynthetic files exercise the real ZenX components.\n",
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
  workspaceFiles: {
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
function Fixture() {
  const [selected, setSelected] = useState<string>();
  return (
    <main
      style={{
        width: params.has("narrow") ? 360 : 660,
        maxWidth: "100vw",
        height: 640,
        margin: "24px auto",
        border: "1px solid var(--color-border-subtle)",
        borderRadius: 10,
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
        background: "var(--color-surface-main)",
      }}
    >
      <header
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "12px 14px",
          borderBottom: "1px solid var(--color-border-subtle)",
          fontSize: 13,
        }}
      >
        <span>{selected?.split("/").at(-1) ?? "Workspace files"}</span>
        {selected ? (
          <button onClick={() => setSelected(undefined)}>Browse files</button>
        ) : (
          <span style={{ color: "var(--color-text-secondary)", fontSize: 11 }}>
            Synthetic workspace · actual components
          </span>
        )}
      </header>
      {selected ? (
        <WorkspaceFilesPanel
          key={selected}
          threadId="fixture"
          drafts={drafts}
          workspacePath="/synthetic/workspace-demo"
          initialPath={selected}
          standalone
        />
      ) : (
        <WorkspaceFilePicker
          threadId="fixture"
          onOpen={async (path) => {
            await window.zenx.workspaceFiles.read("fixture", path);
            setSelected(path);
          }}
          onBack={() => {}}
        />
      )}
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
