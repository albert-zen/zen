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
    for (const [label, icon] of [
      ["Reveal in Finder", "folder"],
      ["Open in default application", "external-link"],
      ["Open with VS Code", "vscode"],
      ["Manage applications…", "settings"],
    ]) {
      assert.equal(
        button(label!).querySelector("svg")?.getAttribute("data-icon"),
        icon,
      );
      assert.equal(
        button(label!).querySelector("svg")?.getAttribute("aria-hidden"),
        "true",
      );
      assert.equal(
        button(label!).textContent?.trim(),
        label,
        "decorative icon does not change the accessible text",
      );
    }
    assert.equal(button("Open with Cursor"), undefined);
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
    await click("Manage applications…");
    await click("Choose application for Custom application…");
    assert.deepEqual(configured, ["custom"]);
    await click("Close");
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
    await click("Manage applications…");
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
      button("Open with Custom application"),
      undefined,
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
    await click("Manage applications…");
    await click("Choose application for Custom application…");
    await act(async () =>
      finishInitialCatalog({ platform: "darwin", applications: {} }),
    );
    await click("Close");
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

test("application management is explicit, immediate, recoverable and scoped", async () => {
  const dom = new JSDOM('<div id="root"></div>', {
    url: "https://zenx.local/",
    pretendToBeVisual: true,
  });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    React,
    getComputedStyle: dom.window.getComputedStyle,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  // JSDOM has no layout; this only permits the production visible-target guard.
  dom.window.HTMLElement.prototype.getClientRects = () =>
    [{ width: 20, height: 20 }] as unknown as DOMRectList;
  let catalog = {
    platform: "darwin",
    applications: { vscode: "/Applications/VS Code.app" },
  };
  let picker: (id: string, reset: boolean) => Promise<unknown> = async () =>
    catalog;
  const calls: unknown[] = [];
  const errors: string[] = [];
  (window as any).zenx = {
    workspaceFiles: {
      applications: async () => catalog,
      openExternal: async () => {},
      configureApplication: async (id: string, reset: boolean) => {
        calls.push({ id, reset });
        return picker(id, reset);
      },
    },
  };
  const root = createRoot(document.getElementById("root")!);
  const render = async (threadId = "one", path = "a.ts") =>
    act(async () =>
      root.render(
        React.createElement(WorkspaceExternalOpen, {
          threadId,
          path,
          disabled: false,
          onError: (e: string) => errors.push(e),
        }),
      ),
    );
  const button = (label: string) =>
    Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
      (b) =>
        b.getAttribute("aria-label") === label ||
        b.textContent?.trim() === label,
    )!;
  const click = async (label: string) => act(async () => button(label).click());
  const settle = async () =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  const manage = async () => {
    await click("Open file externally");
    await click("Manage applications…");
    await settle();
  };
  try {
    await render();
    await click("Open file externally");
    assert.equal(
      document.querySelectorAll('[role="menuitem"]').length,
      4,
      "only reveal, default, available app and management entry",
    );
    assert.equal(
      document
        .querySelector('[role="menu"]')
        ?.textContent?.includes("/Applications/"),
      false,
    );
    assert.equal(button("Choose application for VS Code…"), undefined);
    await click("Manage applications…");
    await settle();
    assert.equal(document.querySelectorAll(".external-application").length, 4);
    assert.deepEqual(
      [...document.querySelectorAll(".external-application h3 svg")].map((e) =>
        e.getAttribute("data-icon"),
      ),
      ["vscode", "cursor", "compose", "computer"],
    );
    assert.match(
      document.querySelector('[role="dialog"]')!.textContent!,
      /saves immediately/,
    );
    assert.equal(
      calls.length,
      0,
      "opening management does not mutate settings",
    );
    assert.equal(
      document.querySelector("details")?.open,
      false,
      "full paths are disclosed on demand",
    );
    assert.equal(
      button("Cancel"),
      undefined,
      "no misleading discard action for immediate persistence",
    );
    await click("Choose application for Custom application…"); // picker cancellation returns unchanged catalog
    assert.equal(
      document.querySelector('[aria-label="Custom application"] details'),
      null,
    );
    picker = async () => {
      throw new Error("Synthetic picker error");
    };
    await click("Choose application for Custom application…");
    assert.equal(
      document.querySelector('[role="alert"]')?.textContent,
      "Synthetic picker error",
    );
    let finish!: (value: unknown) => void;
    picker = () =>
      new Promise((resolve) => {
        finish = resolve;
      });
    await click("Choose application for Custom application…");
    assert.equal(document.querySelector('[role="alert"]'), null);
    assert.equal(button("Choose application for VS Code…").disabled, true);
    const callsBefore = calls.length;
    await click("Choose application for Custom application…");
    assert.equal(
      calls.length,
      callsBefore,
      "busy does not launch a second picker",
    );
    await click("Close");
    await settle();
    assert.equal(
      document.activeElement,
      button("Open file externally"),
      "Close returns focus to breadcrumb trigger",
    );
    await manage();
    assert.equal(
      button("Choose application for VS Code…").disabled,
      true,
      "closing/reopening does not clear an in-flight picker guard",
    );
    catalog = {
      platform: "darwin",
      applications: {
        vscode: "/Applications/VS Code.app",
        custom: "/Applications/Custom.app",
      },
    } as typeof catalog;
    await act(async () => finish(catalog));
    assert.match(
      document.querySelector('[aria-label="Custom application"]')!.textContent!,
      /Custom.app/,
    );
    await act(async () =>
      document.activeElement?.dispatchEvent(
        new dom.window.KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
        }),
      ),
    );
    await settle();
    assert.equal(document.querySelector('[role="dialog"]'), null);
    assert.equal(
      document.activeElement,
      button("Open file externally"),
      "Escape returns focus to breadcrumb trigger",
    );
    await manage();
    assert.match(
      document.querySelector('[aria-label="Custom application"]')!.textContent!,
      /Custom.app/,
      "reopen reflects saved selection",
    );
    picker = async () => {
      catalog = {
        platform: "darwin",
        applications: { vscode: "/Applications/VS Code.app" },
      };
      return catalog;
    };
    await click("Remove custom application");
    assert.deepEqual(calls.at(-1), { id: "custom", reset: true });
    assert.equal(button("Remove custom application"), undefined);
    picker = () =>
      new Promise((resolve) => {
        finish = resolve;
      });
    await click("Choose application for Custom application…");
    await render("two", "a.ts");
    await settle();
    assert.equal(
      document.querySelector('[role="dialog"]'),
      null,
      "thread scope change retires dialog",
    );
    await act(async () =>
      finish({ platform: "darwin", applications: { custom: "/stale/app" } }),
    );
    await manage();
    assert.equal(
      document
        .querySelector('[role="dialog"]')!
        .textContent!.includes("/stale/app"),
      false,
    );
    await render("two", "b.ts");
    await settle();
    assert.equal(
      document.querySelector('[role="dialog"]'),
      null,
      "file scope change retires dialog",
    );
    await manage();
    let rejectPicker!: (reason: Error) => void;
    picker = () =>
      new Promise((_, reject) => {
        rejectPicker = reject;
      });
    await click("Choose application for Custom application…");
    await click("Close");
    await settle();
    await act(async () =>
      rejectPicker(new Error("Selection failed after Close")),
    );
    assert.deepEqual(
      errors,
      ["Selection failed after Close"],
      "a late failure after dismissal remains visible in the file pane",
    );
    await manage();
    assert.equal(
      document.querySelector('[role="alert"]')?.textContent,
      "Selection failed after Close",
      "reopen retains the same failure for recovery",
    );
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});
