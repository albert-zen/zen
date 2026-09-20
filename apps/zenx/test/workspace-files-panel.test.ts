import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { EditorView } from "@codemirror/view";
import { JSDOM } from "jsdom";
import React, { act } from "react";

import {
  listWorkspaceFiles,
  readWorkspaceFile,
  saveWorkspaceFile,
} from "../src/main/workspace-files.js";

test("inline editors autosave real files, preserve in-flight input, and expose conflicts", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "zenx-editor-ui-"));
  const dom = new JSDOM('<div id="root"></div>', {
    url: "https://zenx.local/",
    pretendToBeVisual: true,
  });
  Object.assign(globalThis, {
    window: dom.window,
    Window: dom.window.Window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element,
    MutationObserver: dom.window.MutationObserver,
    Node: dom.window.Node,
    getComputedStyle: dom.window.getComputedStyle,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    React,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const { createRoot } = await import("react-dom/client");
  const { WorkspaceFilesPanel } =
    await import("../src/renderer/src/workspace-files-panel.js");
  const { WorkspaceFileDrafts } =
    await import("../src/renderer/src/workspace-file-drafts.js");
  const drafts = new WorkspaceFileDrafts(10);
  const root = createRoot(document.getElementById("root")!);
  let blockedSaveRelease: (() => void) | undefined;
  let saveStarted: (() => void) | undefined;
  const writes: string[] = [];
  (window as any).zenx = {
    workspaceFiles: {
      list: (_thread: string, relative: string) =>
        listWorkspaceFiles(workspace, relative),
      read: (_thread: string, relative: string) =>
        readWorkspaceFile(workspace, relative),
      save: async (
        _thread: string,
        relative: string,
        text: string,
        revision: string,
      ) => {
        writes.push(text);
        saveStarted?.();
        if (blockedSaveRelease !== undefined) {
          await new Promise<void>((resolve) => {
            blockedSaveRelease = resolve;
          });
          blockedSaveRelease = undefined;
        }
        return saveWorkspaceFile(workspace, relative, text, revision);
      },
    },
  };
  const settle = async (rounds = 12) => {
    for (let index = 0; index < rounds; index += 1)
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
  };
  const button = (text: string) =>
    [...document.querySelectorAll<HTMLButtonElement>("button")].find(
      (candidate) => candidate.textContent === text,
    );
  const click = async (text: string, wait = true) => {
    await act(async () => button(text)!.click());
    if (wait) await settle();
  };
  const edit = async (text: string) => {
    const codeMirror = document.querySelector<HTMLElement>(".cm-editor");
    if (codeMirror) {
      const view = EditorView.findFromDOM(codeMirror)!;
      await act(async () =>
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: text },
        }),
      );
      return;
    }
    await act(async () => {
      const input = document.querySelector<HTMLTextAreaElement>("textarea")!;
      Object.getOwnPropertyDescriptor(
        dom.window.HTMLTextAreaElement.prototype,
        "value",
      )!.set!.call(input, text);
      input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
  };
  const render = async (thread: string) => {
    await act(async () =>
      root.render(
        React.createElement(WorkspaceFilesPanel, {
          key: thread,
          threadId: thread,
          drafts,
        }),
      ),
    );
    await settle();
  };
  try {
    await writeFile(
      path.join(workspace, "README.md"),
      "# Original\r\n\r\nBody\r\n",
    );
    await writeFile(
      path.join(workspace, "app.ts"),
      "export const value = 1;\n",
    );
    await render("a");
    await click("README.md");

    assert.equal(button("Edit"), undefined);
    assert.equal(button("Preview"), undefined);
    assert.equal(button("Save"), undefined);
    assert.match(
      document.querySelector(".cm-content")!.textContent!,
      /Original/,
    );
    const started = new Promise<void>((resolve) => {
      saveStarted = resolve;
    });
    blockedSaveRelease = () => {};
    await edit("# First\r\n\r\nBody\r\n");
    await act(async () => started);
    saveStarted = undefined;
    assert.match(
      document.querySelector('[role="status"]')!.textContent!,
      /Saving/,
    );

    await edit("# Second\r\n\r\nBody\r\n");
    const release = blockedSaveRelease;
    assert.ok(release);
    await act(async () => release());
    await settle();
    assert.deepEqual(writes.slice(0, 2), [
      "# First\r\n\r\nBody\r\n",
      "# Second\r\n\r\nBody\r\n",
    ]);
    assert.equal(
      (await readWorkspaceFile(workspace, "README.md")).text,
      "# Second\r\n\r\nBody\r\n",
    );

    await edit("# Kept draft\r\n\r\nBody\r\n");
    await writeFile(path.join(workspace, "README.md"), "# External edit\r\n");
    await settle();
    assert.match(
      document.querySelector('.file-save-error[role="alert"]')!.textContent!,
      /changed on disk/,
    );
    assert.equal(
      (() => {
        const state = EditorView.findFromDOM(
          document.querySelector<HTMLElement>(".cm-editor")!,
        )!.state;
        return state.sliceDoc(0, state.doc.length);
      })(),
      "# Kept draft\r\n\r\nBody\r\n",
    );
    assert.equal(
      (await readWorkspaceFile(workspace, "README.md")).text,
      "# External edit\r\n",
    );
    assert.ok(document.querySelector(".file-conflict details"));
    await click("Reload disk version", false);
    await click("Keep editing");
    assert.equal(drafts.hasUnsaved(), true);
    await click("Reload disk version", false);
    await click("Discard and reload");
    assert.match(
      document.querySelector(".cm-content")!.textContent!,
      /External edit/,
    );
    assert.equal(drafts.hasUnsaved(), false);

    await click("Files");
    await click("app.ts");
    assert.ok(document.querySelector<HTMLTextAreaElement>(".file-editor"));
    await edit("export const value = 2;\n");
    await settle();
    assert.equal(
      (await readWorkspaceFile(workspace, "app.ts")).text,
      "export const value = 2;\n",
    );
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    await rm(workspace, { recursive: true, force: true });
  }
});
