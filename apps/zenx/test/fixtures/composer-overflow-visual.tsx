// Production ThreadView, editor and styles with synthetic memory-only inputs.
import React, { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { EditorView } from "@codemirror/view";
import { ThreadView } from "../../src/renderer/src/ThreadView.js";
import {
  editComposer,
  emptyComposerState,
} from "../../src/renderer/src/composer-state.js";
import {
  parseSkillDraft,
  withSkillDraft,
} from "../../src/renderer/src/skill-draft.js";
import { insertInlineReference } from "../../src/renderer/src/reference-draft.js";
import { runtimeThread, runtimeMessage } from "./agent-runtime-data.js";
import { i18n } from "../../src/renderer/src/i18n.js";
import "../../src/renderer/src/theme.css";
import "../../src/renderer/src/styles.css";
Object.assign(globalThis, { React });
const params = new URLSearchParams(location.search);
void i18n.changeLanguage(params.get("lang") ?? "en");
document.documentElement.dataset.appearance = params.get("theme") ?? "light";
const thread = {
  ...runtimeThread(
    [
      runtimeMessage(
        "synthetic-message",
        "Synthetic reference editing regression. No Provider, user profile or private content is connected.",
      ),
    ],
    "completed",
    "synthetic-composer-thread",
  ),
  name: "Synthetic Composer regression",
  cwd: "/synthetic/composer",
};
function Fixture() {
  const [composer, setComposer] = useState(emptyComposerState);
  const draft = parseSkillDraft(composer.draft.text);
  const submissions = useRef(0);
  Object.assign(window, {
    composerFixture: {
      snapshot() {
        const editor = document.querySelector<HTMLElement>(
          ".inline-composer-editor .cm-editor",
        );
        const view = editor && EditorView.findFromDOM(editor);
        return {
          draft,
          editorText: view?.state.doc.toString(),
          contentHeight: view?.contentHeight,
          selection: view?.state.selection.main.toJSON(),
          sent: submissions.current,
        };
      },
    },
  });
  function addReference() {
    const editor = document.querySelector<HTMLElement>(
      ".inline-composer-editor .cm-editor",
    );
    const view = editor && EditorView.findFromDOM(editor);
    const position = view?.state.selection.main.head ?? draft.text.length;
    const inserted = insertInlineReference(
      draft.text,
      draft.references,
      {
        kind: "message",
        name: "Synthetic excerpt",
        cwd: thread.cwd,
        threadId: thread.id,
        id: "synthetic-message",
        excerpt: "Exact synthetic excerpt\nwith whitespace preserved.",
      },
      position,
    );
    setComposer((state) =>
      editComposer(
        state,
        withSkillDraft(inserted.text, [], inserted.references),
      ),
    );
  }
  return (
    <div className="app-shell sidebar-collapsed">
      <header className="window-titlebar">
        <button type="button" data-add-reference onClick={addReference}>
          Add synthetic reference
        </button>
        <span>Synthetic data · no model call</span>
      </header>
      <aside className="sidebar" aria-hidden="true" />
      <main className="workspace">
        <section className="agent-surface">
          <ThreadView
            thread={thread}
            composer={composer}
            approvals={[]}
            onDraftChange={(text) =>
              setComposer((state) => editComposer(state, text))
            }
            onSubmit={async () => {
              submissions.current++;
              throw Error("Sending disabled in regression fixture");
            }}
            onInterrupt={async () => {}}
            onRespondToApproval={async () => {}}
          />
        </section>
      </main>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
