import "./dom-primitives.js";
import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { WorkspaceExternalOpen } from "../src/renderer/src/workspace-external-open.js";

test("external file menu distinguishes reveal, editor, missing apps and unsaved files", async () => {
  const dom = new JSDOM('<div id="root"></div>', {
    url: "https://zenx.local/",
    pretendToBeVisual: true,
  });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element,
    Node: dom.window.Node,
    MutationObserver: dom.window.MutationObserver,
    getComputedStyle: dom.window.getComputedStyle,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    React,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const opened: unknown[] = [];
  const configured: unknown[] = [];
  const errors: string[] = [];
  (window as any).zenx = {
    workspaceFiles: {
      applications: async () => ({
        platform: "darwin",
        applications: { vscode: "/Applications/Visual Studio Code.app" },
      }),
      openExternal: async (input: unknown) => {
        opened.push(input);
      },
      configureApplication: async (id: string) => {
        configured.push(id);
        return {
          platform: "darwin",
          applications: { custom: "/Applications/Editor.app" },
        };
      },
    },
  };
  const root = createRoot(document.getElementById("root")!);
  const render = async (disabled: boolean, filePath = "src/file.ts") =>
    act(async () =>
      root.render(
        React.createElement(WorkspaceExternalOpen, {
          threadId: "local-thread",
          path: filePath,
          disabled,
          onError: (error: string) => errors.push(error),
        }),
      ),
    );
  const button = (label: string) =>
    Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
      (b) =>
        b.getAttribute("aria-label") === label ||
        b.textContent?.trim().startsWith(label),
    )!;
  const click = async (label: string) => act(async () => button(label).click());
  try {
    await render(false);
    await click("Open file externally");
    assert.ok(!!button("Reveal in Finder"));
    assert.equal(button("Open with Cursor").disabled, true);
    assert.equal(button("Open with VS Code").disabled, false);
    await click("Open with VS Code");
    assert.deepEqual(opened, [
      {
        host: "local",
        threadId: "local-thread",
        path: "src/file.ts",
        application: "vscode",
      },
    ]);
    await render(true);
    await click("Open file externally");
    assert.equal(button("Open in default application").disabled, true);
    assert.equal(button("Open with VS Code").disabled, true);
    assert.equal(button("Reveal in Finder").disabled, false);
    await click("Choose application for Custom application…");
    assert.deepEqual(configured, ["custom"]);
    const originalApplications = (window as any).zenx.workspaceFiles
      .applications;
    // A different mounted file tab changes the profile while this component stays mounted.
    (window as any).zenx.workspaceFiles.applications = async () => ({
      platform: "darwin",
      applications: { custom: "/Applications/Other Tab.app" },
    });
    await render(false);
    await click("Open file externally");
    assert.equal(
      button("Open with Custom application").disabled,
      false,
      "menu opening refreshes preferences changed in another tab",
    );
    await click("Reveal in Finder");
    (window as any).zenx.workspaceFiles.applications = originalApplications;
    let finishPicker!: (value: unknown) => void;
    (window as any).zenx.workspaceFiles.configureApplication = () =>
      new Promise((resolve) => {
        finishPicker = resolve;
      });
    await click("Open file externally");
    await click("Choose application for Custom application…");
    await render(false, "other/file.ts");
    await act(async () =>
      finishPicker({
        platform: "darwin",
        applications: { custom: "/Applications/Stale.app" },
      }),
    );
    await click("Open file externally");
    assert.equal(
      button("Open with Custom application").disabled,
      true,
      "old picker result cannot overwrite the new file context's catalog",
    );
    await click("Reveal in Finder");
    let finishInitialCatalog!: (value: unknown) => void;
    (window as any).zenx.workspaceFiles.applications = () =>
      new Promise((resolve) => {
        finishInitialCatalog = resolve;
      });
    (window as any).zenx.workspaceFiles.configureApplication = async () => ({
      platform: "darwin",
      applications: { custom: "/Applications/New.app" },
    });
    await render(false, "third/file.ts");
    await click("Open file externally");
    await click("Choose application for Custom application…");
    await act(async () =>
      finishInitialCatalog({ platform: "darwin", applications: {} }),
    );
    await click("Open file externally");
    assert.equal(
      button("Open with Custom application").disabled,
      false,
      "slow initial detection cannot overwrite a newly configured application",
    );
    assert.deepEqual(errors, []);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});
