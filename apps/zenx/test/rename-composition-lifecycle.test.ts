import "./dom-primitives.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { RoomsPage } from "../src/renderer/src/bundled-automation-ui.js";
import type { PluginUiSdkV1 } from "../src/renderer/src/plugin-ui-host.js";

for (const dismissal of ["Escape", "Cancel"] as const)
  test(`PAW rename restarts IME state after ${dismissal}`, async () => {
    const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
    Object.assign(globalThis, {
      window: dom.window,
      document: dom.window.document,
      IS_REACT_ACT_ENVIRONMENT: true,
    });
    Object.assign(window, { zenx: { threads: { list: async () => [] } } });
    const calls: string[] = [];
    const sdk = {
      commands: {
        execute: async (id: string) => {
          calls.push(id);
          if (id === "list")
            return {
              rooms: [
                {
                  id: "room",
                  name: "My assistant",
                  members: [{ name: "Chief", threadId: "chief" }],
                  assistant: { threadId: "chief", triggerId: "trigger" },
                  assistantRepliesEnabled: true,
                  messages: [],
                  createdAt: 0,
                },
              ],
            };
          if (id === "rename") return { renamed: true };
          throw new Error(id);
        },
      },
    } as unknown as PluginUiSdkV1;
    const root = createRoot(document.getElementById("root")!);
    const props = (el: any) =>
      el[Object.keys(el).find((k) => k.startsWith("__reactProps"))!];
    try {
      await act(async () =>
        root.render(React.createElement(RoomsPage, { sdk })),
      );
      const rename = document.querySelector<HTMLButtonElement>(
        '[aria-label="Rename conversation"]',
      )!;
      await act(async () => rename.click());
      let input = document.querySelector<HTMLInputElement>(
        '[role="dialog"] input',
      )!;
      await act(async () => props(input.form).onCompositionStart());
      // Escape dismisses this editor while composition is active. The removed input cannot deliver a later compositionend.
      if (dismissal === "Escape") {
        await act(async () =>
          input.dispatchEvent(
            new dom.window.KeyboardEvent("keydown", {
              key: "Escape",
              isComposing: true,
              bubbles: true,
              cancelable: true,
            }),
          ),
        );
      } else {
        await act(async () =>
          Array.from(
            document.querySelectorAll<HTMLButtonElement>(
              '[role="dialog"] button',
            ),
          )
            .find((button) => button.textContent === "Cancel")!
            .click(),
        );
      }
      assert.equal(document.querySelector('[role="dialog"]'), null);
      await act(async () => rename.click());
      input = document.querySelector<HTMLInputElement>(
        '[role="dialog"] input',
      )!;
      await act(async () =>
        props(input).onChange({ target: { value: "New plain name" } }),
      );
      if (dismissal === "Escape") {
        const enter = new dom.window.KeyboardEvent("keydown", {
          key: "Enter",
          bubbles: true,
          cancelable: true,
        });
        await act(async () => input.dispatchEvent(enter));
        assert.equal(
          enter.defaultPrevented,
          false,
          "fresh normal Enter is allowed",
        );
        // JSDOM does not implement Enter's native implicit form submission.
        await act(async () =>
          input.form!.dispatchEvent(
            new dom.window.Event("submit", { bubbles: true, cancelable: true }),
          ),
        );
      } else {
        await act(async () =>
          input
            .form!.querySelector<HTMLButtonElement>('[type="submit"]')!
            .click(),
        );
      }
      assert.equal(
        calls.filter((id) => id === "rename").length,
        1,
        "a fresh editor must allow an ordinary Enter/save after previous IME cancellation",
      );
    } finally {
      await act(async () => root.unmount());
      dom.window.close();
    }
  });

import { ThreadItemMenu } from "../src/renderer/src/Sidebar.js";
for (const dismissal of ["selection", "rename cancellation"] as const)
  test(`Sidebar rename restarts IME state after ${dismissal}`, async () => {
    const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
    Object.assign(globalThis, {
      window: dom.window,
      document: dom.window.document,
      IS_REACT_ACT_ENVIRONMENT: true,
    });
    const root = createRoot(document.getElementById("root")!);
    let calls = 0;
    const propsOf = (el: any) =>
      el[Object.keys(el).find((k) => k.startsWith("__reactProps"))!];
    const options: any = {
      archived: false,
      busyAction: null,
      error: null,
      hasActiveTurn: false,
      open: true,
      pinned: false,
      renaming: true,
      renameDraft: "New name",
      onArchive: () => {},
      onBeginRename: () => {},
      onCancelRename: () => {},
      onDraftChange: () => {},
      onPin: () => {},
      onRename: () => {
        calls++;
      },
      onUnarchive: () => {},
    };
    try {
      await act(async () =>
        root.render(React.createElement(ThreadItemMenu, options)),
      );
      let form = document.querySelector<HTMLFormElement>("form")!;
      await act(async () => propsOf(form).onCompositionStart());
      await act(async () =>
        root.render(
          React.createElement(ThreadItemMenu, {
            ...options,
            ...(dismissal === "selection"
              ? { open: false }
              : { renaming: false }),
          }),
        ),
      );
      await act(async () =>
        root.render(React.createElement(ThreadItemMenu, options)),
      );
      form = document.querySelector<HTMLFormElement>("form")!;
      if (dismissal === "selection") {
        const enter = new dom.window.KeyboardEvent("keydown", {
          key: "Enter",
          bubbles: true,
          cancelable: true,
        });
        await act(async () =>
          form.querySelector("input")!.dispatchEvent(enter),
        );
        assert.equal(enter.defaultPrevented, false);
        await act(async () =>
          form.dispatchEvent(
            new dom.window.Event("submit", { bubbles: true, cancelable: true }),
          ),
        );
      } else {
        await act(async () =>
          form.querySelector<HTMLButtonElement>('[type="submit"]')!.click(),
        );
      }
      assert.equal(
        calls,
        1,
        "the next editor must not inherit the cancelled input's composition lock",
      );
    } finally {
      await act(async () => root.unmount());
      dom.window.close();
    }
  });
