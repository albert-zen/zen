import "./dom-primitives.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { CompanionWorkspace } from "../src/renderer/src/companion-workspace.js";
import { WorkspaceFileDrafts } from "../src/renderer/src/workspace-file-drafts.js";

test("PAW exposes explicit notes, exact local references and truthful unconfigured heartbeat without starting work", async () => {
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
    assert.match(document.body.textContent ?? "", /Creating a PAW/);
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
    const visible = document.querySelector(".auxiliary-content:not([hidden])")!;
    assert.match(visible.textContent ?? "", /Waiting on review/);
    assert.match(visible.textContent ?? "", /Remote status not loaded/);
    assert.equal(
      [...visible.querySelectorAll("button")].some(
        (b) => b.textContent === "Remote review",
      ),
      false,
    );
    assert.ok(calls.every((c) => c === "workspace" || c === "list"));
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});
