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

export const syntheticWorkspaceFiles = {
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
};
