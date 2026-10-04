import "./dom-primitives.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { CompanionWorkspace } from "../src/renderer/src/companion-workspace.js";
import { WorkspaceFileDrafts } from "../src/renderer/src/workspace-file-drafts.js";

for (const interruption of ["none", "route", "focus"] as const) {
  test(`Room Escape unmount restores Workspace focus unless interrupted: ${interruption}`, async () => {
    const dom = new JSDOM('<div id="root"></div>', {
      url: "http://localhost",
      pretendToBeVisual: true,
    });
    const frames: FrameRequestCallback[] = [];
    Object.assign(globalThis, {
      window: dom.window,
      document: dom.window.document,
      React,
      IS_REACT_ACT_ENVIRONMENT: true,
      requestAnimationFrame: (callback: FrameRequestCallback) => {
        frames.push(callback);
        return frames.length;
      },
    });
    Object.assign(window, { zenx: {} });
    const room = {
      id: "room",
      name: "Room",
      members: [],
      memberCount: 0,
      messagePreview: null,
    };
    const drafts = new WorkspaceFileDrafts();
    function Harness() {
      const [open, setOpen] = useState(false);
      return React.createElement(
        React.Fragment,
        null,
        React.createElement(
          "button",
          {
            id: "thread-browser-toggle",
            "data-room-id": room.id,
            onClick: () => setOpen(true),
          },
          "Workspace",
        ),
        React.createElement(
          "button",
          { id: "another-action" },
          "Another action",
        ),
        open
          ? React.createElement(CompanionWorkspace, {
              room,
              threads: [],
              snapshot: { plugins: [], panels: [] } as any,
              section: "overview",
              navigate: () => {},
              onClose: () => setOpen(false),
              fileDrafts: drafts,
              onWidthChange: () => {},
            })
          : null,
      );
    }
    const root = createRoot(document.getElementById("root")!);
    try {
      await act(async () => root.render(React.createElement(Harness)));
      const opener = document.getElementById("thread-browser-toggle")!;
      opener.focus();
      await act(async () => opener.click());
      const close = document.querySelector<HTMLButtonElement>(
        ".auxiliary-close-button",
      )!;
      assert.equal(document.activeElement, close);
      await act(async () =>
        close.dispatchEvent(
          new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
        ),
      );
      assert.equal(document.querySelector(".auxiliary-panel"), null);
      if (interruption === "route") opener.dataset.roomId = "other-room";
      if (interruption === "focus")
        document.getElementById("another-action")!.focus();
      await act(async () => {
        for (const frame of frames.splice(0)) frame(0);
      });
      assert.equal(
        document.activeElement,
        interruption === "none"
          ? opener
          : interruption === "focus"
            ? document.getElementById("another-action")
            : document.body,
      );
    } finally {
      await act(async () => root.unmount());
      dom.window.close();
    }
  });
}
