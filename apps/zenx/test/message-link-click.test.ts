import "./dom-primitives.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Markdown, MessageLinkContext } from "../src/renderer/src/Markdown.js";
import { AuxiliaryPanel } from "../src/renderer/src/auxiliary-panel.js";
import { readWorkspaceFile } from "../src/main/workspace-files.js";
import { messageFilePath } from "../src/renderer/src/message-file-path.js";

test("keyboard-activated message links request the right panel; unavailable files report errors", async () => {
  const dom = new JSDOM('<div id="root"></div>', {
    url: "https://zenx.local/",
    pretendToBeVisual: true,
  });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    MutationObserver: dom.window.MutationObserver,
    Node: dom.window.Node,
    getComputedStyle: dom.window.getComputedStyle,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    React,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  (dom.window.HTMLElement.prototype as any).attachEvent = () => {};
  (dom.window.HTMLElement.prototype as any).detachEvent = () => {};
  const files: string[] = [];
  (dom.window as any).zenx = {
    workspaceFiles: {
      read: async (_thread: string, path: string) => {
        files.push(path);
        throw new Error("ENOENT: file unavailable");
      },
    },
  };
  function Harness() {
    const [request, setRequest] = useState<{
      id: number;
      kind: "file" | "browser";
      value: string;
    } | null>(null);
    const [open, setOpen] = useState(false);
    const [tab, setTab] = useState("");
    return React.createElement(
      React.Fragment,
      null,
      React.createElement(
        MessageLinkContext.Provider,
        {
          value: (target) => {
            setRequest({ ...target, id: (request?.id ?? 0) + 1 });
            setOpen(true);
          },
        },
        React.createElement(Markdown, { text: "[local](./missing.md)" }),
      ),
      React.createElement(AuxiliaryPanel, {
        threadId: "thread-a",
        workspacePath: "/tmp/work",
        title: "Test",
        open,
        onOpenChange: setOpen,
        selectedTab: tab,
        onSelectTab: setTab,
        snapshot: null,
        messageLinkRequest: request,
      }),
    );
  }
  const root = createRoot(document.getElementById("root")!);
  try {
    await act(async () => root.render(React.createElement(Harness)));
    const anchor =
      document.querySelector<HTMLAnchorElement>(".markdown-body a")!;
    assert.equal(anchor.tabIndex, 0);
    anchor.focus();
    await act(async () => anchor.click());
    assert.deepEqual(files, ["missing.md"]);
    assert.ok(document.querySelector(".auxiliary-panel"));
    assert.match(document.body.textContent ?? "", /ENOENT: file unavailable/u);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});

test("production Markdown clicks read exact percent-encoded filenames through the Host reader", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "zenx-markdown-percent-"));
  const dom = new JSDOM('<div id="root"></div>', {
    url: "https://zenx.local/",
    pretendToBeVisual: true,
  });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    MutationObserver: dom.window.MutationObserver,
    Node: dom.window.Node,
    getComputedStyle: dom.window.getComputedStyle,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    React,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const values: string[] = [];
  const reads: Promise<string>[] = [];
  const root = createRoot(document.getElementById("root")!);
  try {
    for (const name of [
      "report%done.md",
      "report%20done.md",
      "report done.md",
      "中文 file.md",
    ])
      await writeFile(join(cwd, name), name);
    const fileUrl = pathToFileURL(join(cwd, "report%done.md")).href;
    await act(async () =>
      root.render(
        React.createElement(
          MessageLinkContext.Provider,
          {
            value: (target) => {
              if (target.kind !== "file")
                throw new Error("Expected a file target");
              values.push(target.value);
              reads.push(
                readWorkspaceFile(cwd, messageFilePath(target.value, cwd)).then(
                  (file) => file.text,
                ),
              );
            },
          },
          React.createElement(Markdown, {
            text: [
              "[percent](report%25done.md)",
              "[literal20](report%2520done.md)",
              `[file URL](${fileUrl})`,
              "[space](report%20done.md)",
              "[中文](%E4%B8%AD%E6%96%87%20file.md)",
            ].join(" "),
          }),
        ),
      ),
    );
    const anchors = [
      ...document.querySelectorAll<HTMLAnchorElement>(".markdown-body a"),
    ];
    assert.equal(anchors.length, 5);
    for (const anchor of anchors) await act(async () => anchor.click());
    assert.deepEqual(values, [
      "report%done.md",
      "report%20done.md",
      join(cwd, "report%done.md"),
      "report done.md",
      "中文 file.md",
    ]);
    assert.deepEqual(await Promise.all(reads), [
      "report%done.md",
      "report%20done.md",
      "report%done.md",
      "report done.md",
      "中文 file.md",
    ]);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    await rm(cwd, { recursive: true, force: true });
  }
});
