import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import {
  listWorkspaceFiles,
  readWorkspaceFile,
  saveWorkspaceFile,
} from "../src/main/workspace-files.js";

test("file editor saves, previews drafts, keeps edits across panels, and handles disk conflicts", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "zenx-editor-ui-"));
  const dom = new JSDOM('<div id="root"></div>', {
    url: "https://zenx.local/",
  });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const { createRoot } = await import("react-dom/client");
  const { WorkspaceFilesPanel } =
    await import("../src/renderer/src/workspace-files-panel.js");
  const { WorkspaceFileDrafts } =
    await import("../src/renderer/src/workspace-file-drafts.js");
  const drafts = new WorkspaceFileDrafts();
  const root = createRoot(document.getElementById("root")!);
  const writes: string[] = [];
  (window as any).zenx = {
    workspaceFiles: {
      list: (_thread: string, relative: string) =>
        listWorkspaceFiles(workspace, relative),
      read: (_thread: string, relative: string) =>
        readWorkspaceFile(workspace, relative),
      save: (
        _thread: string,
        relative: string,
        text: string,
        revision: string,
      ) => {
        writes.push(text);
        return saveWorkspaceFile(workspace, relative, text, revision);
      },
    },
  };
  const settle = async () => {
    for (let i = 0; i < 12; i++)
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
  };
  const button = (text: string) =>
    [...document.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === text,
    )!;
  const click = async (text: string) => {
    await act(async () => button(text).click());
    await settle();
  };
  const edit = async (text: string) => {
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
    await writeFile(path.join(workspace, "README.md"), "# Original\r\n");
    await writeFile(
      path.join(workspace, "app.ts"),
      "export const value = 1;\n",
    );
    await render("a");
    await click("README.md");
    await click("Edit");
    await edit("# My draft\n");
    assert.equal(drafts.hasUnsaved(), true);
    await click("Preview");
    assert.equal(
      document.querySelector(".file-content h1")?.textContent,
      "My draft",
    );
    await render("b");
    assert.equal(document.querySelector("textarea"), null);
    await render("a");
    await act(async () =>
      document
        .querySelector<HTMLButtonElement>(".file-open-tabs button")!
        .click(),
    );
    await settle();
    assert.equal(
      document.querySelector<HTMLTextAreaElement>("textarea")!.value,
      "# My draft\n",
    );
    await click("Save");
    assert.equal(
      (await readWorkspaceFile(workspace, "README.md")).text,
      "# My draft\r\n",
    );
    assert.equal(drafts.hasUnsaved(), false);
    await edit("# Kept draft\n");
    await writeFile(path.join(workspace, "README.md"), "# External edit");
    await click("Save");
    assert.match(
      document.querySelector('[role="alert"]')!.textContent!,
      /changed on disk/,
    );
    assert.equal(
      document.querySelector<HTMLTextAreaElement>("textarea")!.value,
      "# Kept draft\n",
    );
    assert.equal(
      (await readWorkspaceFile(workspace, "README.md")).text,
      "# External edit",
    );
    await click("Refresh");
    await click("Keep editing");
    assert.equal(drafts.hasUnsaved(), true);
    await click("Refresh");
    await click("Discard and reload");
    assert.equal(
      document.querySelector(".file-content h1")?.textContent,
      "External edit",
    );
    assert.equal(drafts.hasUnsaved(), false);
    await click("Files");
    await click("app.ts");
    await click("Edit");
    await edit("export const value = 2;\n");
    await act(async () =>
      document.querySelector("textarea")!.dispatchEvent(
        new dom.window.KeyboardEvent("keydown", {
          key: "s",
          ctrlKey: true,
          bubbles: true,
        }),
      ),
    );
    await settle();
    assert.equal(
      (await readWorkspaceFile(workspace, "app.ts")).text,
      "export const value = 2;\n",
    );
    assert.equal(writes.length, 3);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    await rm(workspace, { recursive: true, force: true });
  }
});
