import "./dom-primitives.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act, useRef, useState } from "react";
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
      applications: async () => ({ platform: "linux", applications: {} }),
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

function linkPanelDom() {
  const dom = new JSDOM('<div id="root"></div>', {
    url: "https://zenx.local/",
    pretendToBeVisual: true,
  });
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    MutationObserver: dom.window.MutationObserver,
    Node: dom.window.Node,
    ResizeObserver: ResizeObserverStub,
    getComputedStyle: dom.window.getComputedStyle,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    React,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  (dom.window.HTMLElement.prototype as any).attachEvent = () => {};
  (dom.window.HTMLElement.prototype as any).detachEvent = () => {};
  (dom.window as any).zenx = {};
  return dom;
}

test("a handled browser message link is not replayed by panel remounts", async () => {
  const dom = linkPanelDom();
  const commands: { operation: string; url?: string }[] = [];
  (dom.window as any).zenx = {
    workspaceBrowser: {
      command: async (
        _threadId: string,
        operation: string,
        _tabId?: string,
        url?: string,
      ) => {
        commands.push({ operation, url });
        if (operation === "new")
          return [
            {
              id: `tab-${String(commands.length)}`,
              title: "Page",
              url: url ?? "about:blank",
              canGoBack: false,
              canGoForward: false,
            },
          ];
        return [];
      },
      onChanged: () => () => {},
      onFocusAddress: () => () => {},
      mount: async () => ({}),
    },
  };
  function Harness({ showPanel }: { showPanel: boolean }) {
    const [request, setRequest] = useState<{
      id: number;
      kind: "file" | "browser";
      value: string;
    } | null>(null);
    const [open, setOpen] = useState(true);
    const [tab, setTab] = useState("");
    return React.createElement(
      React.Fragment,
      null,
      React.createElement(
        MessageLinkContext.Provider,
        {
          value: (target) =>
            setRequest({ ...target, id: (request?.id ?? 0) + 1 }),
        },
        React.createElement(Markdown, {
          text: "**http://127.0.0.1:56277/sales–architecture.html**（刚重启，已验证 200）",
        }),
      ),
      showPanel
        ? React.createElement(AuxiliaryPanel, {
            threadId: "thread-a",
            workspacePath: "/tmp/work",
            title: "Test",
            open,
            onOpenChange: setOpen,
            selectedTab: tab,
            onSelectTab: setTab,
            snapshot: null,
            messageLinkRequest: request,
            onMessageLinkRequestHandled: (id: number) =>
              setRequest((current) => (current?.id === id ? null : current)),
          })
        : null,
    );
  }
  const root = createRoot(document.getElementById("root")!);
  try {
    await act(async () =>
      root.render(React.createElement(Harness, { showPanel: true })),
    );
    const anchor =
      document.querySelector<HTMLAnchorElement>(".markdown-body a")!;
    await act(async () => anchor.click());
    const opened = commands.filter((command) => command.operation === "new");
    assert.equal(opened.length, 1);
    assert.equal(
      opened[0]?.url,
      new URL("http://127.0.0.1:56277/sales–architecture.html").toString(),
    );
    // Thread switches remount the panel (keyed by thread id); the handled
    // request must not open the page again.
    await act(async () =>
      root.render(React.createElement(Harness, { showPanel: false })),
    );
    await act(async () =>
      root.render(React.createElement(Harness, { showPanel: true })),
    );
    await act(async () =>
      root.render(React.createElement(Harness, { showPanel: false })),
    );
    await act(async () =>
      root.render(React.createElement(Harness, { showPanel: true })),
    );
    assert.equal(
      commands.filter((command) => command.operation === "new").length,
      1,
    );
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});

test("side panel expanded state persists across thread remounts", async () => {
  const dom = linkPanelDom();
  function Harness() {
    const [open, setOpen] = useState(true);
    const [tab, setTab] = useState("");
    return React.createElement(AuxiliaryPanel, {
      threadId: "thread-expand-persist",
      workspacePath: "/tmp/work",
      title: "Test",
      open,
      onOpenChange: setOpen,
      selectedTab: tab,
      onSelectTab: setTab,
      snapshot: null,
    });
  }
  const root = createRoot(document.getElementById("root")!);
  try {
    await act(async () => root.render(React.createElement(Harness)));
    const panel = () => document.querySelector(".auxiliary-panel")!;
    assert.equal(panel().getAttribute("data-expanded"), "false");
    const toggle = document.querySelector<HTMLButtonElement>(
      ".auxiliary-panel button[aria-pressed]:not(.workspace-add-tab)",
    )!;
    await act(async () => toggle.click());
    assert.equal(panel().getAttribute("data-expanded"), "true");
    await act(async () => root.render(React.createElement("div", null)));
    await act(async () => root.render(React.createElement(Harness)));
    assert.equal(panel().getAttribute("data-expanded"), "true");
    const toggleAgain = document.querySelector<HTMLButtonElement>(
      ".auxiliary-panel button[aria-pressed]:not(.workspace-add-tab)",
    )!;
    await act(async () => toggleAgain.click());
    assert.equal(panel().getAttribute("data-expanded"), "false");
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

for (const kind of ["browser", "file"] as const) {
  for (const fail of [false, true]) {
    test(`acknowledged ${kind} links retain delayed ${fail ? "failure" : "success"}`, async () => {
      const dom = linkPanelDom();
      const gate = deferred<any>();
      const old = {
        id: "old",
        threadId: "acknowledged",
        title: "Old page",
        url: "https://example.test/old",
        canGoBack: false,
        canGoForward: false,
      };
      let changed: (value: any) => void = () => {};
      let selection = "browser:old";
      (window as any).zenx = {
        workspaceBrowser: {
          command: async (_thread: string, command: string) =>
            command === "new" ? gate.promise : [old],
          onChanged: (listener: typeof changed) => {
            changed = listener;
            return () => {};
          },
          onFocusAddress: () => () => {},
          mount: async () => ({}),
        },
        workspaceFiles: {
          applications: async () => ({ platform: "linux", applications: {} }),
          read: async () => gate.promise,
        },
      };
      function Harness() {
        const [request, setRequest] = useState<any>(null);
        const [tab, setTab] = useState("browser:old");
        return React.createElement(
          React.Fragment,
          null,
          React.createElement(
            "button",
            {
              id: "request-link",
              onClick: () =>
                setRequest({
                  id: 1,
                  kind,
                  value:
                    kind === "browser" ? "https://example.test/new" : "new.md",
                }),
            },
            "Open link",
          ),
          React.createElement(AuxiliaryPanel, {
            threadId: "acknowledged",
            workspacePath: "/tmp/work",
            title: "Test",
            open: true,
            onOpenChange: () => {},
            selectedTab: tab,
            onSelectTab: (id) => {
              selection = id;
              setTab(id);
            },
            snapshot: null,
            messageLinkRequest: request,
            onMessageLinkRequestHandled: (id) =>
              setRequest((current: any) =>
                current?.id === id ? null : current,
              ),
          }),
        );
      }
      const root = createRoot(document.getElementById("root")!);
      try {
        await act(async () => root.render(React.createElement(Harness)));
        await act(async () => document.getElementById("request-link")!.click());
        await act(async () => {
          if (fail) gate.reject(new Error("delayed-link-failure"));
          else if (kind === "browser") {
            const tabs = [
              old,
              {
                ...old,
                id: "new",
                title: "New page",
                url: "https://example.test/new",
              },
            ];
            changed({ threadId: "acknowledged", tabs });
            gate.resolve(tabs);
          } else
            gate.resolve({
              path: "new.md",
              text: "new file",
              revision: "fixture",
            });
        });
        if (fail)
          assert.match(
            document.body.textContent ?? "",
            /delayed-link-failure/u,
          );
        else
          assert.equal(
            selection,
            kind === "browser" ? "browser:new" : "file:new.md",
          );
      } finally {
        await act(async () => root.unmount());
        dom.window.close();
      }
    });
  }
}

for (const interrupt of [
  "newer link",
  "tab selection",
  "remount",
  "resource switch",
] as const) {
  for (const fail of [false, true]) {
    test(`late message link ${fail ? "failure" : "success"} respects ${interrupt}`, async () => {
      const dom = linkPanelDom();
      const gate = deferred<any[]>();
      const page = (id: string) => ({
        id,
        threadId: "pending-a",
        title: id,
        url: `https://example.test/${id}`,
        canGoBack: false,
        canGoForward: false,
      });
      let pages = [page("old"), page("other")];
      let changed: (value: any) => void = () => {};
      let selection = "browser:old";
      let creates = 0;
      (window as any).zenx = {
        workspaceBrowser: {
          command: async (_thread: string, command: string) => {
            if (command !== "new") return pages;
            creates += 1;
            if (creates === 1) return gate.promise;
            pages = [...pages, page("newer")];
            changed({ threadId: "pending-a", tabs: pages });
            return pages;
          },
          onChanged: (listener: typeof changed) => {
            changed = listener;
            return () => {
              changed = () => {};
            };
          },
          onFocusAddress: () => () => {},
          mount: async () => ({}),
        },
      };
      function Harness({
        show = true,
        owner = "pending-a",
      }: {
        show?: boolean;
        owner?: string;
      }) {
        const sequence = useRef(0);
        const [request, setRequest] = useState<any>(null);
        const [tab, setTab] = useState("browser:old");
        return React.createElement(
          React.Fragment,
          null,
          React.createElement(
            "button",
            {
              id: "pending-link",
              onClick: () =>
                setRequest({
                  id: ++sequence.current,
                  kind: "browser",
                  value: "https://example.test/link",
                }),
            },
            "Open link",
          ),
          show
            ? React.createElement(AuxiliaryPanel, {
                threadId: owner,
                title: "Test",
                open: true,
                onOpenChange: () => {},
                selectedTab: tab,
                onSelectTab: (id) => {
                  selection = id;
                  setTab(id);
                },
                snapshot: null,
                messageLinkRequest: request,
                onMessageLinkRequestHandled: (id) =>
                  setRequest((current: any) =>
                    current?.id === id ? null : current,
                  ),
              })
            : null,
        );
      }
      const root = createRoot(document.getElementById("root")!);
      try {
        await act(async () => root.render(React.createElement(Harness)));
        await act(async () => document.getElementById("pending-link")!.click());
        if (interrupt === "newer link")
          await act(async () =>
            document.getElementById("pending-link")!.click(),
          );
        if (interrupt === "tab selection")
          await act(async () =>
            document.getElementById("aux-tab-browser:other")!.click(),
          );
        if (interrupt === "remount") {
          await act(async () =>
            root.render(React.createElement(Harness, { show: false })),
          );
          await act(async () => root.render(React.createElement(Harness)));
        }
        if (interrupt === "resource switch") {
          await act(async () =>
            root.render(React.createElement(Harness, { owner: "pending-b" })),
          );
          await act(async () => root.render(React.createElement(Harness)));
        }
        const expectedSelection = selection;
        await act(async () => {
          if (fail) gate.reject(new Error("stale-link-failure"));
          else gate.resolve([...pages, page("stale")]);
        });
        assert.equal(selection, expectedSelection);
        assert.doesNotMatch(
          document.body.textContent ?? "",
          /stale-link-failure/u,
        );
        assert.equal(creates, interrupt === "newer link" ? 2 : 1);
      } finally {
        await act(async () => root.unmount());
        dom.window.close();
      }
    });
  }
}
