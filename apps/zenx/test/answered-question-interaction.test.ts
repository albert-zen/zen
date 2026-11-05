import "./dom-primitives.js";
import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { ThreadView } from "../src/renderer/src/ThreadView.js";
import { emptyComposerState } from "../src/renderer/src/composer-state.js";
import { answeredQuestionFixture } from "./fixtures/answered-question-data.js";

test("real ThreadView renders labels and text, reveals question on hover/click, dismisses and retires on navigation", async () => {
  const dom = new JSDOM(
    '<!doctype html><html><body><div id="root"></div></body></html>',
    { url: "http://localhost" },
  );
  const previous = { window: globalThis.window, document: globalThis.document };
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  Object.assign(window, {
    zenx: {
      triggers: { list: async () => [] },
      plugins: { executeCommand: async () => null },
    },
  });
  const root = createRoot(document.getElementById("root")!);
  const render = (missing = false, empty = false) =>
    root.render(
      React.createElement(ThreadView, {
        thread: empty
          ? {
              ...answeredQuestionFixture(),
              id: "other",
              turns: [],
              canonicalItems: [],
            }
          : answeredQuestionFixture(missing),
        composer: emptyComposerState(),
        approvals: [],
        onDraftChange: () => {},
        onInterrupt: async () => {},
        onRespondToApproval: async () => {},
        onSubmit: async () => {},
      }),
    );
  try {
    await act(async () => render());
    const answer = document.querySelector(".answered-question-answer")!;
    assert.match(answer.textContent!, /一页摘要完整明细请保留重点案例/);
    assert.match(answer.textContent!, /\*\*标记\*\*/);
    assert.doesNotMatch(answer.textContent!, /Reply to|scope:|summary/);
    const trigger = document.querySelector<HTMLButtonElement>(
      ".answered-question-trigger",
    )!;
    await act(async () => {
      trigger.dispatchEvent(
        new window.MouseEvent("pointerover", { bubbles: true }),
      );
    });
    assert.match(
      document.querySelector(".answered-question-popover")!.textContent!,
      /暂不整理/,
    );
    await act(async () => trigger.click());
    await act(async () => {
      trigger.dispatchEvent(
        new window.MouseEvent("pointerout", { bubbles: true }),
      );
      await new Promise((resolve) => setTimeout(resolve, 220));
    });
    assert.ok(
      document.querySelector(".answered-question-popover"),
      "click pins hover disclosure",
    );
    await act(async () =>
      document.dispatchEvent(
        new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      ),
    );
    assert.equal(document.querySelector(".answered-question-popover"), null);
    await act(async () => trigger.click());
    assert.ok(document.querySelector(".answered-question-popover"));
    await act(async () => render(false, true));
    assert.equal(document.querySelector(".answered-question-popover"), null);
    await act(async () => render(true));
    await act(async () =>
      document
        .querySelector<HTMLButtonElement>(".answered-question-trigger")!
        .click(),
    );
    assert.match(
      document.querySelector(".answered-question-popover")!.textContent!,
      /unavailable/,
    );
    assert.match(
      document.querySelector(".answered-question-answer")!.textContent!,
      /scope:/,
    );
  } finally {
    await act(async () => root.unmount());
    Object.assign(globalThis, previous, {
      IS_REACT_ACT_ENVIRONMENT: undefined,
    });
    dom.window.close();
  }
});
