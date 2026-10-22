import "./dom-primitives.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { CompanionWorkspace } from "../src/renderer/src/companion-workspace.js";
import { WorkspaceFileDrafts } from "../src/renderer/src/workspace-file-drafts.js";

for (const existingInstructions of [false, true]) {
  test(`PAW workspace keeps notes and opens ${existingInstructions ? "existing" : "missing"} instructions without starting work`, async () => {
    const dom = new JSDOM('<div id="root"></div>', {
      url: "http://localhost",
      pretendToBeVisual: true,
    });
    Object.assign(globalThis, {
      window: dom.window,
      document: dom.window.document,
      HTMLElement: dom.window.HTMLElement,
      MutationObserver: dom.window.MutationObserver,
      Node: dom.window.Node,
      React,
      IS_REACT_ACT_ENVIRONMENT: true,
      requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    });
    const calls: string[] = [];
    const routes: string[] = [];
    Object.assign(window, {
      zenx: {
        plugins: {
          executeCommand: async (_plugin: string, command: string) => {
            calls.push(command);
            if (command === "workspace")
              return {
                revision: 2,
                updatedAt: 0,
                matters: [
                  {
                    id: "m",
                    title: "Ship design",
                    plan: "Review changes",
                    statusNote: "Waiting on review",
                    notes: "Keep it accessible",
                    references: [
                      {
                        kind: "thread",
                        device: "other-device",
                        workspace: "/project",
                        threadId: "same-id",
                        label: "Remote review",
                      },
                    ],
                  },
                ],
                memory: [
                  {
                    id: "n",
                    title: "Preference",
                    text: "Keep changes reviewable",
                  },
                ],
              };
            if (command === "list") return { triggers: [] };
            throw Error(command);
          },
        },
      },
    });
    const snapshot = {
      plugins: [{ id: "zenx-triggers", enabled: true, available: true }],
      panels: [],
    } as any;
    const room = {
      id: "room",
      name: "Aster",
      members: [{ name: "Aster", threadId: "assistant" }],
      assistant: { threadId: "assistant", triggerId: "reply" },
      memberCount: 1,
      messagePreview: null,
    };
    const props = {
      room,
      threads: [],
      snapshot,
      section: "overview",
      navigate: (route: string) => routes.push(route),
      onClose: () => {},
      fileDrafts: new WorkspaceFileDrafts(),
      onWidthChange: () => {},
    };
    const root = createRoot(document.getElementById("root")!);
    try {
      await act(async () =>
        root.render(React.createElement(CompanionWorkspace, props)),
      );
      assert.equal(
        document.querySelector(".companion-content h3")?.textContent,
        "PAW",
      );
      assert.match(
        document.body.textContent ?? "",
        /New PAWs include an hourly heartbeat/,
      );
      assert.match(
        document.body.textContent ?? "",
        /No recurring check configured/,
      );
      assert.match(
        document.body.textContent ?? "",
        /Direct Thread messages stay in the Thread/,
      );
      const openThread = [...document.querySelectorAll("button")].find(
        (button) => button.textContent === "Open working Thread",
      );
      assert.ok(openThread);
      await act(async () => openThread.click());
      assert.deepEqual(routes, ["/threads/assistant"]);
      assert.match(
        document.body.textContent ?? "",
        /1 matters · 1 notes · revision 2/,
      );
      await act(async () =>
        root.render(
          React.createElement(CompanionWorkspace, {
            ...props,
            section: "matters",
          }),
        ),
      );
      const visible = document.querySelector(
        ".auxiliary-content:not([hidden])",
      )!;
      assert.match(visible.textContent ?? "", /Waiting on review/);
      assert.match(visible.textContent ?? "", /Remote status not loaded/);
      assert.equal(
        [...visible.querySelectorAll("button")].some(
          (b) => b.textContent === "Remote review",
        ),
        false,
      );
      assert.ok(calls.every((c) => c === "workspace" || c === "list"));
      await act(async () =>
        root.render(
          React.createElement(CompanionWorkspace, {
            ...props,
            section: "automations",
          }),
        ),
      );
      const triggersTab = document.getElementById(
        "aux-tab-custom:automations",
      )!;
      assert.equal(triggersTab.textContent, "Triggers");
      assert.equal(
        triggersTab.querySelector("svg")?.getAttribute("data-icon"),
        "trigger",
      );
      assert.ok(
        triggersTab.querySelector("circle"),
        "PAW Triggers tab uses the clock face",
      );
      const fileReads: Array<[string, string]> = [];
      Object.assign(window.zenx, {
        workspaceFiles: {
          read: async (threadId: string, relative: string) => {
            fileReads.push([threadId, relative]);
            if (existingInstructions)
              return {
                path: "AGENTS.md",
                text: "# Project instructions",
                revision: "rev-1",
              };
            throw new Error(
              "AGENTS.md is not present in this working directory",
            );
          },
        },
      });
      await act(async () =>
        root.render(
          React.createElement(CompanionWorkspace, {
            ...props,
            section: "instructions",
            threads: [
              {
                threadId: "assistant",
                name: "Assistant",
                preview: "",
                status: "idle",
                archived: false,
                currentMetadata: { cwd: "/actual-workspace" },
              } as any,
            ],
          }),
        ),
      );
      assert.ok(fileReads.length >= 1);
      assert.ok(
        fileReads.every(
          ([thread, file]) => thread === "assistant" && file === "AGENTS.md",
        ),
      );
      if (!existingInstructions)
        assert.match(document.body.textContent!, /AGENTS.md is not present/);
      assert.equal(
        props.fileDrafts.snapshot().size,
        existingInstructions ? 1 : 0,
        "opening missing instructions does not invent a file or alternate identity store",
      );
      if (existingInstructions) {
        const close = document.querySelector<HTMLButtonElement>(
          'button[aria-label="Close tab AGENTS.md"]',
        );
        assert.ok(close);
        await act(async () => close.click());
        assert.equal(
          document.querySelector('[aria-label="Edit AGENTS.md"]'),
          null,
        );
        await act(async () =>
          root.render(
            React.createElement(CompanionWorkspace, {
              ...props,
              section: "instructions",
              sectionRequest: "second-explicit-open",
              threads: [
                {
                  threadId: "assistant",
                  name: "Assistant",
                  preview: "",
                  status: "idle",
                  archived: false,
                  currentMetadata: { cwd: "/actual-workspace" },
                } as any,
              ],
            }),
          ),
        );
        assert.ok(
          document.querySelector('[aria-label="Edit AGENTS.md"]'),
          "a repeated explicit entry reopens the existing editor",
        );
      }
    } finally {
      await act(async () => root.unmount());
      dom.window.close();
    }
  });
}

test("Room workspace keeps same-category conversations independently identified", async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    React,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  Object.assign(window, {
    zenx: {
      plugins: {
        executeCommand: async () => ({ revision: 0, matters: [], memory: [] }),
      },
    },
  });
  const routes: string[] = [];
  const threads = ["assistant", "child/a", "child/b"].map((threadId) => ({
    threadId,
    name: "Same title",
    status: "idle",
    archived: false,
    createdAt: "2026-10-15T03:00:00Z",
    updatedAt: "2026-10-15T03:00:00Z",
    preview: "",
    currentMetadata: {
      cwd: "/project",
      provider: "fake",
      model: "fake",
      sandbox: "danger-full-access",
      approvalPolicy: "never",
    },
  }));
  function Harness() {
    const [viewState, onViewChange] = React.useState({
      selected: "thread:child/a",
      tabs: ["thread:child/a", "thread:child/b"],
      member: "assistant",
      conversationThreadIds: ["child/a", "child/b"],
    });
    return React.createElement(CompanionWorkspace, {
      room: {
        id: "room",
        name: "Synthetic room",
        members: [{ name: "Assistant", threadId: "assistant" }],
        memberCount: 1,
        messagePreview: null,
      },
      threads: threads as any,
      snapshot: { plugins: [], panels: [] } as any,
      section: "",
      fileDrafts: new WorkspaceFileDrafts(),
      onWidthChange() {},
      onClose() {},
      navigate: (route) => routes.push(route),
      viewState,
      onViewChange: onViewChange as any,
      renderConversation: (id) =>
        React.createElement("p", { "data-thread-id": id }, id),
    });
  }
  const root = createRoot(document.getElementById("root")!);
  try {
    await act(async () => root.render(React.createElement(Harness)));
    const tab = (id: string) =>
      document.getElementById(`aux-tab-thread:${id}`) as HTMLButtonElement;
    assert.ok(tab("child/a"));
    assert.ok(tab("child/b"));
    await act(async () => tab("child/b").click());
    assert.equal(
      document
        .querySelector("[data-thread-id]")
        ?.getAttribute("data-thread-id"),
      "child/b",
    );
    await act(async () =>
      document
        .querySelector<HTMLButtonElement>(
          '[aria-label="Open conversation full screen"]',
        )!
        .click(),
    );
    assert.deepEqual(routes, ["/threads/child%2Fb"]);
    await act(async () =>
      tab("child/a")
        .parentElement!.querySelector<HTMLButtonElement>(
          ".workspace-tab-close",
        )!
        .click(),
    );
    assert.equal(tab("child/a"), null);
    assert.equal(tab("child/b").getAttribute("aria-selected"), "true");
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});

test("PAW working Thread rename updates only its tab while another same-title conversation stays selected", async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    React,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  Object.defineProperties(dom.window.HTMLInputElement.prototype, {
    attachEvent: { value: () => undefined },
    detachEvent: { value: () => undefined },
  });
  Object.assign(window, {
    zenx: {
      plugins: {
        executeCommand: async (_plugin: string, command: string) => {
          assert.equal(command, "workspace");
          return { revision: 0, matters: [], memory: [] };
        },
      },
    },
  });
  const workingId = "paw-working-thread";
  const room = {
    id: "paw-room",
    name: "Personal assistant",
    members: [{ name: "PAW speaker", threadId: workingId }],
    assistant: { threadId: workingId, triggerId: "paw-reply" },
    memberCount: 1,
    messagePreview: null,
  };
  const initialThreads = [workingId, "child/a", "child/b"].map((threadId) => ({
    threadId,
    name: "Same title",
    status: "idle" as const,
    archived: false,
    createdAt: "2026-10-15T03:00:00Z",
    updatedAt: "2026-10-15T03:00:00Z",
    preview: "",
    ...(threadId === workingId ? {} : { parentThreadId: workingId }),
    currentMetadata: {
      cwd: "/project",
      provider: "fake",
      model: "fake",
      sandbox: "danger-full-access" as const,
      approvalPolicy: "never" as const,
    },
  }));
  const fileDrafts = new WorkspaceFileDrafts();
  const routes: string[] = [];
  const renames: Array<{ threadId: string; title: string }> = [];
  let finishRename!: () => void;
  const renameResult = new Promise<void>((resolve) => {
    finishRename = resolve;
  });
  function Harness() {
    const [threads, setThreads] = React.useState(initialThreads);
    const [viewState, onViewChange] = React.useState({
      selected: "custom:overview",
      tabs: [
        "custom:overview",
        `thread:${workingId}`,
        "thread:child/a",
        "thread:child/b",
      ],
      member: workingId,
      conversationThreadIds: [workingId, "child/a", "child/b"],
    });
    return React.createElement(CompanionWorkspace, {
      room,
      threads,
      snapshot: { plugins: [], panels: [] } as any,
      section: "",
      fileDrafts,
      onWidthChange() {},
      onClose() {},
      navigate: (route) => routes.push(route),
      viewState,
      onViewChange: onViewChange as any,
      onRenameThread: async (threadId, title) => {
        renames.push({ threadId, title });
        await renameResult;
        setThreads((current) =>
          current.map((thread) =>
            thread.threadId === threadId ? { ...thread, name: title } : thread,
          ),
        );
      },
      renderConversation: (id) =>
        React.createElement("p", { "data-thread-id": id }, id),
    });
  }
  const root = createRoot(document.getElementById("root")!);
  const tab = (id: string) =>
    document.getElementById(`aux-tab-${id}`) as HTMLButtonElement;
  const selectedConversation = () =>
    document.querySelector(".auxiliary-conversation [data-thread-id]");
  try {
    await act(async () => root.render(React.createElement(Harness)));
    for (const id of [workingId, "child/a", "child/b"])
      assert.equal(tab(`thread:${id}`).textContent, "Same title");
    await act(async () =>
      document
        .querySelector<HTMLButtonElement>(
          ".companion-content .thread-title-rename",
        )!
        .click(),
    );
    const input = document.querySelector<HTMLInputElement>(
      ".companion-content .thread-title-form input",
    )!;
    assert.equal(input.value, "Same title");
    const key = Object.keys(input).find((key) =>
      key.startsWith("__reactProps$"),
    )!;
    await act(async () =>
      (input as any)[key].onChange({ target: { value: "Research planner" } }),
    );
    await act(async () =>
      input.form!.dispatchEvent(
        new window.Event("submit", { bubbles: true, cancelable: true }),
      ),
    );
    assert.deepEqual(renames, [
      { threadId: workingId, title: "Research planner" },
    ]);
    // A pending working-Thread rename must not steal a newer tab selection.
    await act(async () => tab("thread:child/b").click());
    const selectedChild = selectedConversation();
    assert.equal(selectedChild?.getAttribute("data-thread-id"), "child/b");
    await act(async () => finishRename());
    assert.equal(tab(`thread:${workingId}`).textContent, "Research planner");
    assert.equal(tab("thread:child/a").textContent, "Same title");
    assert.equal(tab("thread:child/b").textContent, "Same title");
    assert.equal(tab("thread:child/b").getAttribute("aria-selected"), "true");
    assert.equal(selectedConversation(), selectedChild);
    assert.equal(
      document.querySelector(".auxiliary-conversation-heading span")
        ?.textContent,
      "Same title",
    );
    assert.equal(room.name, "Personal assistant");
    assert.equal(room.members[0]!.name, "PAW speaker");
    assert.equal(
      document.querySelector<HTMLSelectElement>(".companion-context select")
        ?.value,
      workingId,
    );
    assert.deepEqual(routes, []);
    await act(async () => tab(`thread:${workingId}`).click());
    assert.equal(
      selectedConversation()?.getAttribute("data-thread-id"),
      workingId,
    );
    assert.equal(
      document.querySelector(".auxiliary-conversation-heading span")
        ?.textContent,
      "Research planner",
    );
    await act(async () =>
      document
        .querySelector<HTMLButtonElement>(
          '[aria-label="Open conversation full screen"]',
        )!
        .click(),
    );
    assert.deepEqual(routes, [`/threads/${workingId}`]);
    await act(async () => tab("custom:overview").click());
    assert.equal(
      document.querySelector(".companion-content .thread-title-line strong")
        ?.textContent,
      "Research planner",
    );
    assert.equal(document.querySelector(".thread-title-form"), null);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});
