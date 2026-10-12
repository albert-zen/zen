import "./dom-primitives.js";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { ThreadReadingStateProvider } from "../src/renderer/src/thread-reading-state.js";
import { ThreadView } from "../src/renderer/src/ThreadView.js";
import {
  editComposer,
  emptyComposerState,
} from "../src/renderer/src/composer-state.js";
import type { Thread } from "../src/protocol-client/index.js";
export { act };
export type ViewProps = React.ComponentProps<typeof ThreadView>;
export const draft = editComposer(
  emptyComposerState(),
  "Keep this unsent draft.",
);
export async function withRuntimeDom(
  run: (h: {
    render(thread: Thread, props?: Partial<ViewProps>): Promise<void>;
    hide(): Promise<void>;
    click(selector: string): Promise<HTMLButtonElement>;
  }) => Promise<void>,
) {
  const dom = new JSDOM("<div id='root'></div>", { url: "http://localhost" });
  const previous = { window: globalThis.window, document: globalThis.document };
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    React,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  Object.assign(dom.window.HTMLElement.prototype, {
    attachEvent() {},
    detachEvent() {},
  });
  Object.defineProperties(dom.window.HTMLElement.prototype, {
    clientHeight: {
      configurable: true,
      get() {
        return this.classList.contains("queue-preview-text") ? 32 : 0;
      },
    },
    scrollHeight: {
      configurable: true,
      get() {
        return this.classList.contains("queue-preview-text") &&
          this.textContent.length > 80
          ? 120
          : 32;
      },
    },
  });
  const root = createRoot(document.getElementById("root")!);
  try {
    await run({
      render: async (thread, props = {}) => {
        await act(async () =>
          root.render(
            React.createElement(ThreadReadingStateProvider, {
              children: React.createElement(ThreadView, {
                key: thread.id,
                thread,
                approvals: [],
                composer: draft,
                onDraftChange() {},
                onInterrupt: async () => {},
                onRespondToApproval: async () => {},
                onSubmit: async () => {},
                ...props,
              }),
            }),
          ),
        );
      },
      hide: async () => {
        await act(async () =>
          root.render(
            React.createElement(ThreadReadingStateProvider, { children: null }),
          ),
        );
      },
      click: async (selector) => {
        const button = document.querySelector<HTMLButtonElement>(selector);
        assert.ok(button, selector);
        await act(async () => button.click());
        return button;
      },
    });
  } finally {
    await act(async () => root.unmount());
    Object.assign(globalThis, previous, {
      IS_REACT_ACT_ENVIRONMENT: undefined,
    });
    dom.window.close();
  }
}
