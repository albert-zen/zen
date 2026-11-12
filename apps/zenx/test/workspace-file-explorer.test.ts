import "./dom-primitives.js";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import {
  listWorkspaceFiles,
  searchWorkspaceFiles,
} from "../src/main/workspace-files.js";

test("file explorer expands folders and searches unopened folders in the exact workspace", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "zenx-explorer-"));
  const dom = new JSDOM('<div id="root"></div>', {
    url: "https://zenx.local/",
    pretendToBeVisual: true,
  });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    React,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const { createRoot } = await import("react-dom/client");
  const { WorkspaceFileExplorer } =
    await import("../src/renderer/src/workspace-file-explorer.js");
  const root = createRoot(document.getElementById("root")!);
  const opened: string[] = [];
  const searched: string[] = [];
  (window as any).zenx = {
    workspaceFiles: {
      list: (threadId: string, relative: string) => {
        assert.equal(threadId, "thread-a");
        return listWorkspaceFiles(workspace, relative);
      },
      search: (threadId: string, query: string) => {
        assert.equal(threadId, "thread-a");
        searched.push(query);
        return searchWorkspaceFiles(workspace, query);
      },
    },
  };
  const settle = async () =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 250));
    });
  try {
    await mkdir(path.join(workspace, "src/deep"), { recursive: true });
    await writeFile(path.join(workspace, "README.md"), "# Project");
    await writeFile(
      path.join(workspace, "src/deep/target.ts"),
      "export const target = true;",
    );
    await act(async () =>
      root.render(
        React.createElement(WorkspaceFileExplorer, {
          threadId: "thread-a",
          onOpen: (value: string) => {
            opened.push(value);
          },
        }),
      ),
    );
    await settle();
    assert.equal(
      document.querySelector('[data-file-path="src/deep/target.ts"]'),
      null,
    );
    const folder = document.querySelector<HTMLButtonElement>(
      '[data-file-path="src"]',
    )!;
    await act(async () => folder.click());
    await settle();
    assert.equal(
      document
        .querySelector('[data-file-path="src"]')
        ?.getAttribute("aria-expanded"),
      "true",
    );
    assert.ok(document.querySelector('[data-file-path="src/deep"]'));
    const input = document.querySelector<HTMLInputElement>(
      'input[type="search"]',
    )!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        dom.window.HTMLInputElement.prototype,
        "value",
      )!.set!.call(input, "target");
      input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
    await settle();
    await settle();
    assert.deepEqual(searched, ["target"]);
    assert.match(
      document.querySelector('[data-file-path="src/deep/target.ts"]')!
        .textContent!,
      /src\/deep/,
    );
    await act(async () =>
      input.dispatchEvent(
        new dom.window.KeyboardEvent("keydown", {
          key: "Enter",
          bubbles: true,
        }),
      ),
    );
    assert.deepEqual(opened, ["src/deep/target.ts"]);
    await act(async () =>
      input.dispatchEvent(
        new dom.window.KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
        }),
      ),
    );
    await settle();
    assert.equal(input.value, "");
    assert.ok(
      document.querySelector('[data-file-path="src/deep"]'),
      "clearing search preserves expanded folders",
    );
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("file search ignores superseded, cleared, failed and previous-thread responses", async () => {
  const dom = new JSDOM('<div id="root"></div>', {
    url: "https://zenx.local/",
    pretendToBeVisual: true,
  });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    React,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const { createRoot } = await import("react-dom/client");
  const { WorkspaceFileExplorer } =
    await import("../src/renderer/src/workspace-file-explorer.js");
  const root = createRoot(document.getElementById("root")!);
  const requests: {
    thread: string;
    query: string;
    resolve: (value: any) => void;
    reject: (error: Error) => void;
  }[] = [];
  const opened: string[] = [];
  (window as any).zenx = {
    workspaceFiles: {
      list: async (thread: string) => ({
        path: ".",
        entries: [{ name: thread + ".ts", path: thread + ".ts", kind: "file" }],
        truncated: false,
      }),
      search: (thread: string, query: string) =>
        new Promise((resolve, reject) =>
          requests.push({ thread, query, resolve, reject }),
        ),
    },
  };
  const render = async (threadId: string) =>
    act(async () =>
      root.render(
        React.createElement(WorkspaceFileExplorer, {
          threadId,
          onOpen: (path: string) => opened.push(path),
        }),
      ),
    );
  const input = () =>
    document.querySelector<HTMLInputElement>('input[type="search"]')!;
  const type = async (value: string) => {
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        dom.window.HTMLInputElement.prototype,
        "value",
      )!.set!.call(input(), value);
      input().dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 220));
    });
  };
  const result = (name: string, truncated = false) => ({
    cwd: "/fixture",
    entries: [{ name, path: `unopened/${name}` }],
    scanned: 100,
    truncated,
  });
  try {
    await render("a");
    await type("old");
    await type("new");
    await act(async () => requests[1]!.resolve(result("new.ts", true)));
    assert.match(document.body.textContent!, /search is partial/);
    await act(async () => requests[0]!.resolve(result("old.ts")));
    assert.equal(
      document.querySelector('[data-file-path="unopened/old.ts"]'),
      null,
    );
    assert.ok(document.querySelector('[data-file-path="unopened/new.ts"]'));
    await type("pending");
    await type("");
    await act(async () => requests[2]!.reject(new Error("stale error")));
    assert.doesNotMatch(document.body.textContent!, /stale error/);
    assert.ok(document.querySelector('[data-file-path="a.ts"]'));
    await type("previous-thread");
    await render("b");
    await act(async () => requests[3]!.resolve(result("private-a.ts")));
    assert.equal(input().value, "");
    assert.equal(
      document.querySelector('[data-file-path="unopened/private-a.ts"]'),
      null,
    );
    assert.ok(document.querySelector('[data-file-path="b.ts"]'));
    await type("missing");
    await act(async () => requests[4]!.reject(new Error("Search denied")));
    assert.match(
      document.querySelector('[role="alert"]')!.textContent!,
      /Search denied/,
    );
    assert.deepEqual(opened, []);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});

test("file tree supports folder keyboard navigation, prototype-like names, refresh and bounded rows", async () => {
  const dom = new JSDOM('<div id="root"></div>', {
    url: "https://zenx.local/",
    pretendToBeVisual: true,
  });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    React,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const { createRoot } = await import("react-dom/client");
  const { WorkspaceFileExplorer } =
    await import("../src/renderer/src/workspace-file-explorer.js");
  const root = createRoot(document.getElementById("root")!);
  let rootReads = 0;
  (window as any).zenx = {
    workspaceFiles: {
      list: async (_thread: string, relative: string) => {
        if (relative === ".") {
          rootReads++;
          return {
            path: ".",
            entries: [
              { name: "toString", path: "toString", kind: "directory" },
              ...Array.from({ length: 2000 }, (_, i) => ({
                name: `${i}.ts`,
                path: `${i}.ts`,
                kind: "file",
              })),
            ],
            truncated: true,
          };
        }
        return {
          path: relative,
          entries: [
            { name: "nested.ts", path: "toString/nested.ts", kind: "file" },
          ],
          truncated: false,
        };
      },
    },
  };
  const press = async (element: HTMLElement, key: string) =>
    act(async () => {
      element.focus();
      element.dispatchEvent(
        new dom.window.KeyboardEvent("keydown", { key, bubbles: true }),
      );
    });
  const folder = () =>
    document.querySelector<HTMLElement>('[data-file-path="toString"]')!;
  try {
    await act(async () =>
      root.render(
        React.createElement(WorkspaceFileExplorer, {
          threadId: "a",
          onOpen: () => {},
        }),
      ),
    );
    const actions = document.querySelector(".workspace-file-actions")!;
    assert.ok(actions.querySelector('input[type="search"]'));
    assert.ok(
      actions.querySelector(
        '[aria-label="Refresh file list"][title="Refresh file list"]',
      ),
    );
    const collapse = actions.querySelector<HTMLButtonElement>(
      '[aria-label="Collapse folders"][title="Collapse folders"]',
    )!;
    assert.equal(collapse.disabled, true);
    assert.ok(collapse.querySelector('[data-icon="collapse-folders"]'));
    assert.equal(actions.querySelector('[data-icon="compress"]'), null);
    assert.equal(document.querySelector(".workspace-file-tree-heading"), null);
    assert.equal(document.querySelectorAll('[role="treeitem"]').length, 2000);
    assert.match(document.body.textContent!, /display limit/);
    await press(folder(), "ArrowRight");
    assert.ok(document.querySelector('[data-file-path="toString/nested.ts"]'));
    assert.equal(collapse.disabled, false);
    await act(async () => collapse.click());
    assert.equal(folder().getAttribute("aria-expanded"), "false");
    assert.equal(
      rootReads,
      1,
      "collapse only changes local directory visibility",
    );
    await press(folder(), "ArrowRight");
    await press(folder(), "ArrowRight");
    assert.equal(
      (document.activeElement as HTMLElement).dataset.filePath,
      "toString/nested.ts",
    );
    await press(document.activeElement as HTMLElement, "ArrowLeft");
    assert.equal(document.activeElement, folder());
    await press(folder(), "ArrowLeft");
    assert.equal(folder().getAttribute("aria-expanded"), "false");
    await press(folder(), "End");
    assert.equal(
      (document.activeElement as HTMLElement).dataset.filePath,
      "1998.ts",
    );
    await press(document.activeElement as HTMLElement, "Home");
    assert.equal(document.activeElement, folder());
    await act(async () =>
      document
        .querySelector<HTMLButtonElement>('[aria-label="Refresh file list"]')!
        .click(),
    );
    assert.equal(rootReads, 2);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});

test("refresh observes actual disk changes while preserving expansion, selection and usable failure state", async () => {
  const workspace = await mkdtemp(
    path.join(os.tmpdir(), "zenx-explorer-refresh-"),
  );
  const dom = new JSDOM('<div id="root"></div>', {
    url: "https://zenx.local/",
    pretendToBeVisual: true,
  });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    React,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const { createRoot } = await import("react-dom/client");
  const { WorkspaceFileExplorer } =
    await import("../src/renderer/src/workspace-file-explorer.js");
  const root = createRoot(document.getElementById("root")!);
  let failure = false;
  const opened: string[] = [];
  const reads: string[] = [];
  (window as any).zenx = {
    workspaceFiles: {
      list: async (_thread: string, directory: string) => {
        reads.push(directory);
        if (failure) throw new Error("EACCES: fixture folder cannot be read");
        return listWorkspaceFiles(workspace, directory);
      },
      search: (_thread: string, query: string) =>
        searchWorkspaceFiles(workspace, query),
    },
  };
  const settle = async () =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 80));
    });
  const row = (name: string) =>
    document.querySelector<HTMLButtonElement>(`[data-file-path="${name}"]`);
  const refresh = () =>
    document.querySelector<HTMLButtonElement>(
      '[aria-label="Refresh file list"]',
    )!;
  try {
    await mkdir(path.join(workspace, "src"));
    await mkdir(path.join(workspace, "docs"));
    await writeFile(
      path.join(workspace, "src/selected.ts"),
      "const draft = true;",
    );
    await writeFile(path.join(workspace, "docs/old.md"), "Old");
    await act(async () =>
      root.render(
        React.createElement(WorkspaceFileExplorer, {
          threadId: "fixture",
          selectedPath: "src/selected.ts",
          onOpen: (file: string) => opened.push(file),
        }),
      ),
    );
    await settle();
    await act(async () => row("docs")!.click());
    await settle();
    assert.ok(
      row("docs/old.md") !== null,
      "unrelated expanded folder is visible",
    );
    assert.ok(
      refresh().parentElement?.lastElementChild === refresh(),
      "refresh is the trailing action, not the leading toggle",
    );
    const beforeMutation = reads.length;
    await writeFile(path.join(workspace, "docs/new.md"), "New");
    await rm(path.join(workspace, "docs/old.md"));
    await settle();
    assert.equal(
      reads.length,
      beforeMutation,
      "no hidden timer polls Thread history or the filesystem",
    );
    await act(async () => refresh().click());
    await settle();
    assert.ok(
      row("docs/old.md") === null,
      "deleted entry disappears on real refresh",
    );
    assert.ok(
      row("docs/new.md") !== null,
      "new disk entry appears without reopening the folder",
    );
    assert.equal(row("docs")?.getAttribute("aria-expanded"), "true");
    assert.equal(row("src/selected.ts")?.getAttribute("data-current"), "true");
    assert.equal(
      row("docs")?.getAttribute("aria-selected"),
      "true",
      "refresh preserves keyboard cursor",
    );
    assert.deepEqual(
      opened,
      [],
      "refresh never reopens the editor or touches its draft",
    );

    failure = true;
    await act(async () => refresh().click());
    await settle();
    assert.match(
      document.body.textContent!,
      /last loaded files are still shown/,
    );
    assert.match(
      document.body.textContent!,
      /EACCES: fixture folder cannot be read/,
    );
    assert.ok(
      row("docs/new.md") !== null,
      "failed refresh preserves actionable last-loaded rows",
    );
    assert.equal(row("docs/new.md")?.disabled, false);
    assert.equal(
      refresh().disabled,
      false,
      "refresh can be retried after failure",
    );
    assert.doesNotMatch(document.body.textContent!, /No files in this folder/);
    failure = false;
    await act(async () => refresh().click());
    await settle();
    assert.ok(
      document.querySelector('[role="alert"]') === null,
      "successful refresh clears error details",
    );

    await act(async () => row("docs")!.click());
    await writeFile(path.join(workspace, "docs/later.md"), "Later");
    await act(async () => row("docs")!.click());
    await settle();
    assert.ok(
      row("docs/later.md") !== null,
      "reopening a cached folder reads its current disk listing",
    );
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("refresh retains the current query/results during failure and rejects retired directory reads", async () => {
  const dom = new JSDOM('<div id="root"></div>', {
    url: "https://zenx.local/",
    pretendToBeVisual: true,
  });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    React,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const { createRoot } = await import("react-dom/client");
  const { WorkspaceFileExplorer } =
    await import("../src/renderer/src/workspace-file-explorer.js");
  const root = createRoot(document.getElementById("root")!);
  let childReads = 0;
  let retired: (value: any) => void = () => {};
  let searchFailure = false;
  const queries: string[] = [];
  const listing = (name: string) => ({
    path: "src",
    entries: [{ name, path: `src/${name}`, kind: "file" }],
    truncated: false,
  });
  (window as any).zenx = {
    workspaceFiles: {
      list: async (_thread: string, directory: string) => {
        if (directory === ".")
          return {
            path: ".",
            entries: [{ name: "src", path: "src", kind: "directory" }],
            truncated: false,
          };
        if (++childReads === 1)
          return await new Promise((resolve) => {
            retired = resolve;
          });
        return listing("current.ts");
      },
      search: async (_thread: string, query: string) => {
        queries.push(query);
        if (searchFailure) throw new Error("Search access denied");
        return {
          cwd: "/fixture",
          entries: [{ name: "current.ts", path: "src/current.ts" }],
          scanned: 2,
          truncated: false,
        };
      },
    },
  };
  const refresh = () =>
    document.querySelector<HTMLButtonElement>(
      '[aria-label="Refresh file list"]',
    )!;
  const settle = async () =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 230));
    });
  try {
    await act(async () =>
      root.render(
        React.createElement(WorkspaceFileExplorer, {
          threadId: "a",
          onOpen: () => {},
        }),
      ),
    );
    await act(async () =>
      document
        .querySelector<HTMLButtonElement>('[data-file-path="src"]')!
        .click(),
    );
    await act(async () => refresh().click());
    await act(async () => retired(listing("retired.ts")));
    assert.ok(
      document.querySelector('[data-file-path="src/current.ts"]') !== null,
      "latest directory refresh is authoritative",
    );
    assert.ok(
      document.querySelector('[data-file-path="src/retired.ts"]') === null,
      "retired response cannot overwrite refresh",
    );
    const input = document.querySelector<HTMLInputElement>(
      'input[type="search"]',
    )!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        dom.window.HTMLInputElement.prototype,
        "value",
      )!.set!.call(input, "current");
      input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
    await settle();
    searchFailure = true;
    await act(async () => refresh().click());
    assert.ok(
      document.querySelector('[data-file-path="src/current.ts"]') !== null,
      "pending refresh does not blank results",
    );
    await settle();
    assert.equal(input.value, "current");
    assert.deepEqual(queries, ["current", "current"]);
    assert.match(
      document.body.textContent!,
      /last loaded files are still shown/,
    );
    assert.match(document.body.textContent!, /Search access denied/);
    assert.ok(
      document.querySelector('[data-file-path="src/current.ts"]') !== null,
      "failed search keeps its last results with warning",
    );
    assert.equal(refresh().disabled, false);
    searchFailure = false;
    await act(async () =>
      document
        .querySelector<HTMLButtonElement>('[role="alert"] button')!
        .click(),
    );
    await settle();
    assert.ok(
      document.querySelector('[role="alert"]') === null,
      "search retry recovers in place",
    );
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});
