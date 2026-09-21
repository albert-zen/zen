import { installScrollbarVisibility } from "../../../src/renderer/src/scrollbar-visibility.js";
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { ThreadView } from "../../../src/renderer/src/ThreadView";
import {
  editComposer,
  emptyComposerState,
} from "../../../src/renderer/src/composer-state";
import "../../../src/renderer/src/theme.css";
import "../../../src/renderer/src/styles.css";
installScrollbarVisibility(document);
import "../../../src/renderer/src/skills.css";
Object.assign(globalThis, { React });
const noop = async () => {};
const files = [
  "src/renderer/ThreadView.tsx",
  "src/renderer/WorkflowCommandMenu.tsx",
  "docs/输入选择器 [draft].md",
];
const skills = [
  {
    id: "11111111-1111-1111-1111-111111111111",
    name: "frontend-design",
    description:
      "Design polished interfaces with a distinctive visual direction",
    source: "Personal library",
    mode: "manual",
  },
  {
    id: "22222222-2222-2222-2222-222222222222",
    name: "code-review",
    description: "Review changes for correctness and maintainability",
    source: "Team library",
    mode: "manual",
  },
];
(window as any).zenx = {
  skills: { list: async () => ({ skills, errors: [] }) },
  workspaceFiles: {
    search: async (_id, query) => ({
      cwd: "D:/Work/zen",
      entries: files
        .filter((path) => path.toLowerCase().includes(query.toLowerCase()))
        .map((path) => ({ name: path.split("/").at(-1), path })),
      truncated: false,
      scanned: 3,
    }),
    validateReference: async (_id, path) => ({
      cwd: "D:/Work/zen",
      name: path.split("/").at(-1),
      path,
    }),
  },
  threads: {
    list: async () => [
      {
        threadId: "review-thread-canonical",
        name: "Review command palette accessibility",
        preview: "",
        status: "idle",
        currentMetadata: { cwd: "D:/Work/zen" },
      },
    ],
  },
  protocol: { request: async () => ({}) },
};
const thread: any = {
  id: "current",
  turns: [],
  status: { type: "idle" },
  cwd: "D:/Work/zen",
  canonicalItems: [],
};
function Fixture() {
  const [composer, setComposer] = useState(() =>
    editComposer(emptyComposerState(), "/"),
  );
  const [dark, setDark] = useState(true);
  const [narrow, setNarrow] = useState(false);
  return (
    <>
      <style>{`body{margin:0;background:var(--surface-base);color:var(--color-text-primary)} .fixture{height:100vh;max-width:900px;margin:auto;display:flex;flex-direction:column}.fixture.narrow{max-width:360px}.fixture-tools{padding:16px;display:flex;gap:12px}.fixture-tools button{padding:8px;background:var(--surface-raised);color:inherit;border:1px solid var(--border);border-radius:8px}.fixture>.thread-view{flex:1;min-height:0}`}</style>
      <main className={`fixture ${narrow ? "narrow" : ""}`}>
        <div className="fixture-tools">
          <button
            onClick={() => {
              document.documentElement.dataset.appearance = dark
                ? "light"
                : "dark";
              setDark(!dark);
            }}
          >
            Light / dark
          </button>
          <button onClick={() => setNarrow(!narrow)}>Narrow / wide</button>
          <button onClick={() => setComposer(editComposer(composer, "@"))}>
            References
          </button>
        </div>
        <ThreadView
          thread={thread}
          composer={composer}
          approvals={[]}
          onDraftChange={(text) => setComposer(editComposer(composer, text))}
          onInterrupt={noop}
          onRespondToApproval={noop}
          onSubmit={noop}
          workflowCommands={[
            {
              name: "review",
              description: "Find bugs, regressions and missing validation",
              prompt: "Review these changes carefully",
              enabled: true,
            },
            {
              name: "explain",
              description: "Explain the code and its key design decisions",
              prompt: "Explain this code",
              enabled: true,
            },
          ]}
        />
      </main>
    </>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
